// Stripe Webhook 署名検証（HMAC-SHA256・worker/node 共通）。§5：host/client の重複実装を一本化（乖離＝事故の温床）。
// header 形式 `t=<unix>,v1=<hex>`。t の鮮度（既定±300s）を検証し、`${t}.${payload}` の HMAC を定数時間比較する。
const ENC = new TextEncoder();

export async function verifyStripeSig(secret: string, payload: string, header: string, toleranceSec = 300): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=")));
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;
  const ts = Number(t);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", ENC.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, ENC.encode(`${t}.${payload}`));
  const hex = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqualHex(hex, v1);
}

// 定数時間の hex 比較（タイミング攻撃対策）。
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
