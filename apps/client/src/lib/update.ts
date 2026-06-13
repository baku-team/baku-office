import { kvPut } from "./kv.ts";
// 第2層更新のクライアント側ロジック（deploy仕様§3.3-3.4）。
//   案①：Deploy Hook をアプリKVに「暗号化保存」し、アプリ内ボタンで自分のプロジェクトを再ビルド。
//   フックURLはアプリKV内だけに保持し、ホストへは送らない（原則1の強い担保）。
import { encryptField, decryptField } from "@baku-office/shared";
import { masterKey } from "./client.ts";

const KV_HOOK = "deploy_hook";
const DOMAIN = "deploy-hook"; // HKDF サブ鍵分離

// セマンティックバージョン比較（a>b で正）。
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

// Deploy Hook URL の形式検証（CFのフックURL）。緩め＝https かつ cloudflare.com ドメイン。
export function isValidHookUrl(u: string): boolean {
  try { const x = new URL(u); return x.protocol === "https:" && /(^|\.)cloudflare\.com$/i.test(x.hostname); }
  catch { return false; }
}

export async function hasDeployHook(env: Env): Promise<boolean> {
  return (await env.LICENSE.get(KV_HOOK)) !== null;
}

export async function saveDeployHook(env: Env, url: string): Promise<void> {
  const enc = await encryptField(await masterKey(env), url, DOMAIN);
  await kvPut(env, KV_HOOK, enc);
}

export async function getDeployHook(env: Env): Promise<string | null> {
  const stored = await env.LICENSE.get(KV_HOOK);
  if (!stored) return null;
  return decryptField(await masterKey(env), stored, DOMAIN);
}

export async function clearDeployHook(env: Env): Promise<void> {
  await env.LICENSE.delete(KV_HOOK);
}
