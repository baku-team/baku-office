// 自動マイグレーションランナー（自己ホスト・大規模DB変更対応）。
// マイグレーションSQLをバンドル（Vite ?raw）し、schema_migrations で未適用分だけ適用。
// upstream更新でマイグレーションが増えても、初回リクエスト時に自動適用＝顧客の手作業不要。
// 既存テーブルへの再適用に備え、文ごとに「既に存在/重複列」エラーは無視（冪等）。
import m0001 from "../../migrations/0001_client.sql?raw";
import m0002 from "../../migrations/0002_files_schedule.sql?raw";
import m0003 from "../../migrations/0003_reminders.sql?raw";
import m0004 from "../../migrations/0004_summary_jobs.sql?raw";
import m0005 from "../../migrations/0005_skills.sql?raw";
import m0006 from "../../migrations/0006_capabilities_diag.sql?raw";
import m0007 from "../../migrations/0007_video_jobs.sql?raw";
import m0008 from "../../migrations/0008_api_usage.sql?raw";
import m0009 from "../../migrations/0009_drive.sql?raw";
import m0010 from "../../migrations/0010_membership.sql?raw";
import m0011 from "../../migrations/0011_sites.sql?raw";
import m0012 from "../../migrations/0012_imports.sql?raw";
import m0013 from "../../migrations/0013_external_apps.sql?raw";
import m0014 from "../../migrations/0014_draft_preflight.sql?raw";
import m0015 from "../../migrations/0015_chat_sessions.sql?raw";
import m0016 from "../../migrations/0016_agent_jobs.sql?raw";
import m0017 from "../../migrations/0017_a2a_actions.sql?raw";
import m0018 from "../../migrations/0018_reports.sql?raw";
import m0019 from "../../migrations/0019_google.sql?raw";
import m0020 from "../../migrations/0020_invoices.sql?raw";
import m0021 from "../../migrations/0021_notifications.sql?raw";
import m0022 from "../../migrations/0022_usage_tokens.sql?raw";
import m0023 from "../../migrations/0023_files_encryption.sql?raw";
import m0024 from "../../migrations/0024_agent_approvals.sql?raw";
import m0025 from "../../migrations/0025_files_ctx.sql?raw";
import m0026 from "../../migrations/0026_user_leave.sql?raw";
import m0027 from "../../migrations/0027_perf_indexes.sql?raw";
import m0028 from "../../migrations/0028_op_usage.sql?raw";
import { logDiag } from "./diag.ts";

// 並び順＝適用順。新しいマイグレーションはここに追記するだけ。
const MIGRATIONS: { id: string; sql: string }[] = [
  { id: "0001_client", sql: m0001 },
  { id: "0002_files_schedule", sql: m0002 },
  { id: "0003_reminders", sql: m0003 },
  { id: "0004_summary_jobs", sql: m0004 },
  { id: "0005_skills", sql: m0005 },
  { id: "0006_capabilities_diag", sql: m0006 },
  { id: "0007_video_jobs", sql: m0007 },
  { id: "0008_api_usage", sql: m0008 },
  { id: "0009_drive", sql: m0009 },
  { id: "0010_membership", sql: m0010 },
  { id: "0011_sites", sql: m0011 },
  { id: "0012_imports", sql: m0012 },
  { id: "0013_external_apps", sql: m0013 },
  { id: "0014_draft_preflight", sql: m0014 },
  { id: "0015_chat_sessions", sql: m0015 },
  { id: "0016_agent_jobs", sql: m0016 },
  { id: "0017_a2a_actions", sql: m0017 },
  { id: "0018_reports", sql: m0018 },
  { id: "0019_google", sql: m0019 },
  { id: "0020_invoices", sql: m0020 },
  { id: "0021_notifications", sql: m0021 },
  { id: "0022_usage_tokens", sql: m0022 },
  { id: "0023_files_encryption", sql: m0023 },
  { id: "0024_agent_approvals", sql: m0024 },
  { id: "0025_files_ctx", sql: m0025 },
  { id: "0026_user_leave", sql: m0026 },
  { id: "0027_perf_indexes", sql: m0027 },
  { id: "0028_op_usage", sql: m0028 },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

// コメント除去＋セミコロン分割。WHY: 行頭だけでなく `;` 後のインラインコメント（例 `... DEFAULT 'x'; -- 説明`）も
// 除かないと、分割後にコメントのみの断片が残り D1 が "No SQL statements detected" で全マイグレーションを中断する。
function statements(sql: string): string[] {
  return sql
    .split("\n").map((l) => l.replace(/--.*$/, "")).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean);
}
// 既存環境への再適用で安全に無視できるエラーのみを限定列挙。WHY: 以前は bare "duplicate" も無視しており、
// 部分適用や想定外の重複を隠蔽し得た（2026-06-04 の Cron 全停止の温床）。
const ignorable = (msg: string) => /already exists|duplicate column name/i.test(msg);

export async function applyMigrations(env: Env): Promise<{ applied: string[] }> {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER)").run();
  const done = new Set((await env.DB.prepare("SELECT id FROM schema_migrations").all<{ id: string }>()).results.map((r) => r.id));
  const applied: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    for (const stmt of statements(m.sql)) {
      try {
        await env.DB.prepare(stmt).run();
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (!ignorable(msg)) {
          // 想定外の失敗は診断に残してから中断（部分適用を隠蔽しない）。
          await logDiag(env, "error", "migration", `migration ${m.id} 失敗: ${msg}`, stmt.slice(0, 200));
          throw e;
        }
      }
    }
    await env.DB.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(m.id, Math.floor(Date.now() / 1000)).run();
    applied.push(m.id);
  }
  return { applied };
}

// 軽量ガード：KVのスキーマ版が最新なら即return（1リクエスト1 KV read）。
const KV_VER = "schema_version";
const KV_LOCK = "schema_lock"; // 初回同時リクエストの並行適用を抑える best-effort ロック（§4-1）。
export async function ensureSchema(env: Env): Promise<void> {
  try {
    if ((await env.LICENSE.get(KV_VER)) === String(SCHEMA_VERSION)) return;
    // best-effort ロック：他リクエストが適用中なら今回はスキップ（次リクエストが KV_VER で収束）。
    // KV は結果整合のため完全排他ではない＝DDL は冪等エラー無視で救済、INSERT 系は使わない規約で補完。
    if ((await env.LICENSE.get(KV_LOCK)) === "1") return;
    await env.LICENSE.put(KV_LOCK, "1", { expirationTtl: 60 });
    try {
      await applyMigrations(env);
      await env.LICENSE.put(KV_VER, String(SCHEMA_VERSION));
    } finally {
      await env.LICENSE.delete(KV_LOCK).catch(() => {});
    }
  } catch (e) {
    // 失敗時も次リクエストで再試行（KV_VER は立てない）。原因は診断に残す（無言の全停止を避ける）。
    await logDiag(env, "error", "migration", `ensureSchema 失敗: ${(e as Error).message ?? String(e)}`);
  }
}
