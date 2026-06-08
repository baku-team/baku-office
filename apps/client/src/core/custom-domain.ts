// カスタムドメイン設定（団体ごと・Plus 以上）。
// 実際の Worker への紐付けは顧客が Cloudflare ダッシュボードで行う。ここでは「希望ドメインの保存＋表示」のみ。
import type { Ctx } from "./ports.ts";

export type CustomDomainConfig = { domain: string; registeredAt: number };

// FQDN の最小妥当性チェック（ラベル英数とハイフン・ドット区切り・全長253以下）。空文字は「未設定」。
export function sanitizeDomain(input: unknown): string {
  const s = String(input ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!s) return "";
  if (s.length > 253) return "";
  const ok = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(s);
  return ok ? s : "";
}

const KV_DOMAIN = "custom_domain";
export async function getCustomDomain(ctx: Ctx): Promise<CustomDomainConfig | null> {
  const raw = await ctx.storage.kv.get(KV_DOMAIN);
  if (!raw) return null;
  try { const v = JSON.parse(raw); return v && typeof v.domain === "string" ? v : null; } catch { return null; }
}
// nowSec は呼び出し側（API）から渡す（core は Date.now を直接使わない方針に倣い、引数で受ける）。
export async function setCustomDomain(ctx: Ctx, domainInput: unknown, nowSec: number): Promise<CustomDomainConfig | null> {
  const domain = sanitizeDomain(domainInput);
  if (!domain) { await ctx.storage.kv.delete(KV_DOMAIN); return null; } // 空＝設定解除
  const cfg: CustomDomainConfig = { domain, registeredAt: nowSec };
  await ctx.storage.kv.put(KV_DOMAIN, JSON.stringify(cfg));
  return cfg;
}
