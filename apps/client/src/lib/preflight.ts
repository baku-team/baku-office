// アプリ開発の事前確認（クライアント側）。企画・仕様の後、実装前に必ず4確認を通す。
// ①環境（実行可否・容量）②権限（クライアント権限で実行可か）③安全（DB/ストレージへ悪影響がないか）④コスト（推定トークン・予算）。
// いずれかが fail なら実装/公開申請をブロックする。
import type { Ctx } from "../core/ports.ts";
import { getApiKey } from "./client.ts";
import { getStorageUsage } from "./storage-usage.ts";
import { monthTotals, getLimits } from "./usage.ts";

export type CheckKey = "env" | "permission" | "safety" | "cost";
export type Check = { key: CheckKey; label: string; status: "ok" | "warn" | "fail"; detail: string };
export type PreflightResult = { ok: boolean; checks: Check[] };

const ALLOWED_PERMS = new Set(["db:read", "db:write", "storage:read", "storage:write", "ai", "agent", "members:read", "net"]);
// 管理者承認が要る（影響の大きい）権限。
const PRIVILEGED = ["db:write", "storage:write", "members:read", "net"];
// 破壊的SQL/危険操作の痕跡。
const DESTRUCTIVE = /\b(drop\s+table|delete\s+from|truncate|alter\s+table|attach\s+database|pragma|update\s+\w+\s+set(?![^;]*\bwhere\b))/i;

export type DraftLike = { name: string; permissions?: string[]; definition?: unknown; spec?: string; estTokens?: number };

export async function preflight(ctx: Ctx, d: DraftLike): Promise<PreflightResult> {
  const env = ctx.env;
  const perms = d.permissions ?? [];
  const defStr = typeof d.definition === "string" ? d.definition : JSON.stringify(d.definition ?? "");
  const checks: Check[] = [];

  // ① 環境確認：必要能力が使えるか／容量に余裕があるか。
  const needsAi = perms.includes("ai") || perms.includes("agent");
  const hasAi = needsAi ? (!!(await getApiKey(env, "gemini")) || !!(await getApiKey(env, "claude")) || !!env.LOCAL_AI_BASE_URL) : true;
  const storage = await getStorageUsage(env).catch(() => []);
  const near = storage.filter((s) => s.enabled && s.limit > 0 && s.used >= 0 && s.used / s.limit >= 0.9);
  if (needsAi && !hasAi) checks.push({ key: "env", label: "環境確認", status: "fail", detail: "AI能力が必要ですが Gemini/Claude/ローカルLLM のいずれも未設定です。" });
  else if (near.length) checks.push({ key: "env", label: "環境確認", status: "warn", detail: `容量が逼迫しています（90%超）：${near.map((s) => s.key.toUpperCase()).join(", ")}。` });
  else checks.push({ key: "env", label: "環境確認", status: "ok", detail: "この環境で実行可能・容量に余裕あり。" });

  // ② 権限確認：宣言権限がクライアント権限の範囲内か。
  const unknown = perms.filter((p) => !ALLOWED_PERMS.has(p));
  const priv = perms.filter((p) => PRIVILEGED.includes(p));
  if (unknown.length) checks.push({ key: "permission", label: "権限確認", status: "fail", detail: `未知/不許可の権限：${unknown.join(", ")}（破壊的・特権操作はアプリに付与されません）。` });
  else if (priv.length) checks.push({ key: "permission", label: "権限確認", status: "warn", detail: `管理者承認が必要な権限を含みます：${priv.join(", ")}。` });
  else checks.push({ key: "permission", label: "権限確認", status: "ok", detail: "クライアント権限内で実行可能。" });

  // ③ 安全確認：DB/ストレージへの破壊的影響がないか。
  if (DESTRUCTIVE.test(defStr)) checks.push({ key: "safety", label: "安全確認", status: "fail", detail: "破壊的操作の痕跡（DROP/DELETE/TRUNCATE/ALTER/WHERE無しUPDATE 等）を検出しました。" });
  else if (perms.includes("net")) checks.push({ key: "safety", label: "安全確認", status: "warn", detail: "外部送信（net）を含みます。送信先 allowlist と内容を要確認。" });
  else checks.push({ key: "safety", label: "安全確認", status: "ok", detail: "DB/ストレージへの破壊的操作なし（スコープ済み ctx・owner 限定で動作）。" });

  // ④ コスト計算：推定消費トークンと当月予算の照合。
  const tokens = d.estTokens && d.estTokens > 0 ? d.estTokens : Math.min(20000, Math.ceil(defStr.length / 3) + 2000);
  const limits = await getLimits(env).catch(() => ({} as Record<string, { monthlyCap?: number }>));
  const month = await monthTotals(env).catch(() => ({} as Record<string, number>));
  const cap = (limits.gemini?.monthlyCap ?? limits.claude?.monthlyCap) as number | undefined;
  const used = (month.gemini ?? 0) + (month.claude ?? 0);
  let costStatus: Check["status"] = "ok";
  let costDetail = `推定消費 ~${tokens.toLocaleString()} tokens/実行。`;
  if (cap && cap > 0) {
    const remain = cap - used;
    costDetail += ` 当月予算 残り ~${Math.max(0, remain).toLocaleString()}/${cap.toLocaleString()} tokens。`;
    if (remain <= 0) { costStatus = "fail"; costDetail += " 予算超過のため実行不可。"; }
    else if (tokens > remain) { costStatus = "warn"; costDetail += " 1実行で予算を超える可能性。"; }
  } else {
    costDetail += " 月次予算は［高度なオプション → API使用量］で設定・確認できます。";
  }
  checks.push({ key: "cost", label: "コスト計算", status: costStatus, detail: costDetail });

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}
