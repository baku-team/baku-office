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

// 並び順＝適用順。新しいマイグレーションはここに追記するだけ。
const MIGRATIONS: { id: string; sql: string }[] = [
  { id: "0001_client", sql: m0001 },
  { id: "0002_files_schedule", sql: m0002 },
  { id: "0003_reminders", sql: m0003 },
  { id: "0004_summary_jobs", sql: m0004 },
  { id: "0005_skills", sql: m0005 },
  { id: "0006_capabilities_diag", sql: m0006 },
  { id: "0007_video_jobs", sql: m0007 },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

// コメント除去＋セミコロン分割。
function statements(sql: string): string[] {
  return sql
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean);
}
const ignorable = (msg: string) => /already exists|duplicate column|duplicate/i.test(msg);

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
        if (!ignorable((e as Error).message)) throw e; // 既存環境への再適用は無視、想定外は中断
      }
    }
    await env.DB.prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)").bind(m.id, Math.floor(Date.now() / 1000)).run();
    applied.push(m.id);
  }
  return { applied };
}

// 軽量ガード：KVのスキーマ版が最新なら即return（1リクエスト1 KV read）。
const KV_VER = "schema_version";
export async function ensureSchema(env: Env): Promise<void> {
  try {
    if ((await env.LICENSE.get(KV_VER)) === String(SCHEMA_VERSION)) return;
    await applyMigrations(env);
    await env.LICENSE.put(KV_VER, String(SCHEMA_VERSION));
  } catch {
    // 失敗時も次リクエストで再試行（フラグは立てない）。
  }
}
