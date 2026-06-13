// CF 環境アダプタ（移植性アーキ §3・Profile A）。
// 既存モジュール（storage.ts / media-ai.ts / agent.ts / env.DB）を Port 形に薄く包むだけ。
// ここに業務ロジックは置かない（コアは薄く・§0原則3）。
import type { Ctx, SqlStore, SqlParam, StoragePort, AiPort, AgentPort } from "./ports.ts";
import * as storage from "../lib/storage.ts";
import * as media from "../lib/media-ai.ts";
import { runAgent } from "../lib/agent.ts";

// D1 を方言中立 QueryStore として包む。bind は配列展開。CF型は本アダプタ内に閉じる。
export function cfSqlStore(env: Env): SqlStore {
  const bind = (sql: string, params: readonly SqlParam[] = []) => env.DB.prepare(sql).bind(...params);
  return {
    all: async <T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]) =>
      (await bind(sql, params).all<T>()).results as T[],
    first: <T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]) =>
      bind(sql, params).first<T>() as Promise<T | null>,
    run: async (sql: string, params?: readonly SqlParam[]) => {
      const r = await bind(sql, params).run();
      return { rowsWritten: r.meta?.changes ?? 0, lastRowId: r.meta?.last_row_id ?? null };
    },
    batch: async (stmts) => {
      await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...((s.params ?? []) as SqlParam[]))));
    },
    // 過渡期：未移行コード用（Phase C で撤去）。
    prepare: (sql: string) => env.DB.prepare(sql),
  };
}

export function cfStorage(env: Env): StoragePort {
  return {
    kv: {
      get: (k) => env.LICENSE.get(k),
      put: (k, v, o) => env.LICENSE.put(k, v, o),
      delete: (k) => env.LICENSE.delete(k),
      list: async (prefix) => (await env.LICENSE.list({ prefix })).keys.map((x) => x.name),
    },
    mode: () => storage.storageMode(env),
    saveFile: (file, by) => storage.saveFile(env, file, by),
    getFile: (id) => storage.getFile(env, id),
  };
}

export function cfAi(env: Env): AiPort {
  return {
    transcribe: (buf, mime) => media.transcribeAudio(env, buf, mime),
    webSearch: (q) => media.webSearch(env, q),
    makeDocument: (owner, baseUrl, a) => media.makeDocument(env, owner, baseUrl, a),
  };
}

// エージェントは道具実行で ctx 全体（db/storage/ai）を使うため、env でなく ctx を受ける。
export function cfAgent(ctx: Ctx): AgentPort {
  return {
    run: (i) => runAgent(ctx, i.owner, i.text, i.image, i.baseUrl ?? "", i.role ?? "member", { history: i.history, model: i.model }),
  };
}
