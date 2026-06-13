import { kvPut } from "./kv.ts";
// カスタム相棒（マスコット）画像の保管。団体ごと1枚を LICENSE KV に保持し /api/mascot で配信。
// 暗号化しない（ロゴ同等の表示用画像。機微情報ではない）。
const KEY = "mascot_image";

export async function getMascot(env: Env): Promise<{ buf: ArrayBuffer; ct: string } | null> {
  const r = await env.LICENSE.getWithMetadata<{ ct?: string }>(KEY, { type: "arrayBuffer" });
  if (!r.value) return null;
  return { buf: r.value, ct: r.metadata?.ct || "image/png" };
}
export async function storeMascot(env: Env, buf: ArrayBuffer, ct: string): Promise<void> {
  await kvPut(env, KEY, buf, { metadata: { ct } });
}
export async function clearMascot(env: Env): Promise<void> {
  await env.LICENSE.delete(KEY);
}
