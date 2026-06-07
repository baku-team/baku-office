// CF 環境アダプタ（移植性アーキ §3・Profile A）。
// 既存モジュール（storage.ts / media-ai.ts / agent.ts / env.DB）を Port 形に薄く包むだけ。
// ここに業務ロジックは置かない（コアは薄く・§0原則3）。
import type { Ctx, SqlStore, StoragePort, AiPort, AgentPort } from "./ports.ts";
import * as storage from "../lib/storage.ts";
import * as media from "../lib/media-ai.ts";
import { runAgent } from "../lib/agent.ts";

export function cfSqlStore(env: Env): SqlStore {
  return {
    prepare: (sql) => env.DB.prepare(sql),
    batch: (stmts) => env.DB.batch(stmts),
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
