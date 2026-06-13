import { kvPut } from "./kv.ts";
// 団体ロゴ画像の保管。mascot と同様、団体ごと1枚を LICENSE KV に保持し /api/logo で配信。
// 暗号化しない（表示用画像。機微情報ではない）。
const KEY = "logo_image";

export async function getLogo(env: Env): Promise<{ buf: ArrayBuffer; ct: string } | null> {
  const r = await env.LICENSE.getWithMetadata<{ ct?: string }>(KEY, { type: "arrayBuffer" });
  if (!r.value) return null;
  return { buf: r.value, ct: r.metadata?.ct || "image/png" };
}
export async function storeLogo(env: Env, buf: ArrayBuffer, ct: string): Promise<void> {
  await kvPut(env, KEY, buf, { metadata: { ct } });
}
export async function clearLogo(env: Env): Promise<void> {
  await env.LICENSE.delete(KEY);
}
