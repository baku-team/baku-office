import { kvPut } from "./kv.ts";
// クライアント設定（高度なオプション）。LICENSE KV に保存。組織単位の軽量設定。
import { DEFAULT_MODELS, isValidWorkersAiModel } from "../core/models/config.ts";

export type AiEngine = "gemini" | "claude";

// 招待なし公開A2Aの受付ポリシー（団体ごと）。mode＝box(受付箱で承認)/auto(即時自動応答)/hybrid(信頼で分岐)。
export type ReceptionPolicy = { mode: "box" | "auto" | "hybrid"; minHostTrust: number; requireVerified: boolean; requireAiReview: boolean; requireCertified: boolean };
const DEFAULT_RECEPTION: ReceptionPolicy = { mode: "box", minHostTrust: 0.3, requireVerified: false, requireAiReview: false, requireCertified: false };
export async function getReceptionPolicy(env: Env): Promise<ReceptionPolicy> {
  const raw = await env.LICENSE.get("reception_policy");
  if (!raw) return { ...DEFAULT_RECEPTION };
  try { const p = JSON.parse(raw); return { ...DEFAULT_RECEPTION, ...p, mode: ["box", "auto", "hybrid"].includes(p.mode) ? p.mode : "box" }; } catch { return { ...DEFAULT_RECEPTION }; }
}
export async function setReceptionPolicy(env: Env, p: Partial<ReceptionPolicy>): Promise<ReceptionPolicy> {
  const cur = await getReceptionPolicy(env);
  const next: ReceptionPolicy = {
    mode: p.mode && ["box", "auto", "hybrid"].includes(p.mode) ? p.mode : cur.mode,
    minHostTrust: typeof p.minHostTrust === "number" ? Math.max(0, Math.min(1, p.minHostTrust)) : cur.minHostTrust,
    requireVerified: typeof p.requireVerified === "boolean" ? p.requireVerified : cur.requireVerified,
    requireAiReview: typeof p.requireAiReview === "boolean" ? p.requireAiReview : cur.requireAiReview,
    requireCertified: typeof p.requireCertified === "boolean" ? p.requireCertified : cur.requireCertified,
  };
  await kvPut(env, "reception_policy", JSON.stringify(next));
  return next;
}

// 記帳方式：単式（出納帳・既定）／複式（仕訳・試算表）。管理者が切替。
export type BookkeepingMode = "single" | "double";
export async function getBookkeepingMode(env: Env): Promise<BookkeepingMode> {
  return (await env.LICENSE.get("bookkeeping_mode")) === "double" ? "double" : "single";
}
export async function setBookkeepingMode(env: Env, m: string): Promise<BookkeepingMode> {
  const v: BookkeepingMode = m === "double" ? "double" : "single";
  await kvPut(env, "bookkeeping_mode", v);
  return v;
}

// クラウドAI（Workers AI）の使用モデル。管理者が上位モデルを選択できる。
// 解決順：KV設定 > env.WORKERS_AI_MODEL > 既定。妥当でないIDは既定へフォールバック。
export async function getWorkersAiModel(env: Env): Promise<string> {
  const saved = (await env.LICENSE.get("workers_ai_model"))?.trim();
  if (saved && isValidWorkersAiModel(saved)) return saved;
  return env.WORKERS_AI_MODEL?.trim() || DEFAULT_MODELS.workers_ai;
}
export async function setWorkersAiModel(env: Env, id: string): Promise<string> {
  const v = isValidWorkersAiModel(id) ? id : DEFAULT_MODELS.workers_ai;
  await kvPut(env, "workers_ai_model", v);
  return v;
}

// AIエンジン選択（既定 gemini=無料／claude=BYOK）。Plus以上で Claude を任意選択可。
export async function getAiEngine(env: Env): Promise<AiEngine> {
  return (await env.LICENSE.get("ai_engine")) === "claude" ? "claude" : "gemini";
}
export async function setAiEngine(env: Env, e: string): Promise<AiEngine> {
  const v: AiEngine = e === "claude" ? "claude" : "gemini";
  await kvPut(env, "ai_engine", v);
  return v;
}

// AIへ追加するカスタム指示（口調・人格・回答形式など）。system に追記される。
const CUSTOM_PROMPT_MAX = 2000;
export async function getCustomPrompt(env: Env): Promise<string> {
  return (await env.LICENSE.get("custom_prompt")) ?? "";
}
export async function setCustomPrompt(env: Env, s: string): Promise<string> {
  const v = (s ?? "").slice(0, CUSTOM_PROMPT_MAX);
  await kvPut(env, "custom_prompt", v);
  return v;
}

// Workers Paid（CF有料プラン）有効フラグ。管理者が「CFをPaidにした」と申告して上限を引き上げる。
// CF側から自動検出はできないため自己申告。マルチエージェントの並列数・ジョブ規模・ホップ上限の引き上げに使う。
export async function getWorkersPaid(env: Env): Promise<boolean> {
  return (await env.LICENSE.get("workers_paid")) === "true";
}
export async function setWorkersPaid(env: Env, enabled: boolean): Promise<boolean> {
  await kvPut(env, "workers_paid", enabled ? "true" : "false");
  return enabled;
}

// 任意：org スコープの通知（期日リマインダー等）をプッシュする Webhook URL。Discord 互換の content/text JSON を POST。
export async function getNotifyWebhook(env: Env): Promise<string> {
  return (await env.LICENSE.get("notify_webhook_url")) ?? "";
}
export async function setNotifyWebhook(env: Env, url: string): Promise<string> {
  const v = (url ?? "").trim().slice(0, 500);
  await kvPut(env, "notify_webhook_url", v);
  return v;
}

// マルチエージェントの同時実行上限（無料枠は subrequest/CPU 制約のため控えめ、Paid で拡張）。
export async function maxParallelAgents(env: Env): Promise<number> {
  return (await getWorkersPaid(env)) ? 5 : 2;
}
// スーパーバイザーのホップ上限（Paid でより多段の委譲を許可）。
export async function agentMaxHops(env: Env): Promise<number> {
  return (await getWorkersPaid(env)) ? 6 : 4;
}
