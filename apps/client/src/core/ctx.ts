// 実行コンテキストの組み立て（移植性アーキ §6/§7）。
// Phase 1：CF Profile（A）固定で既存実装を包む。将来は Profile に応じて Port 実装を差し替える。
import type { Ctx } from "./ports.ts";
import { cfSqlStore, cfStorage, cfAi, cfAgent } from "./cf-adapter.ts";
import { localIdentity } from "./identity.ts";
import { detectProfile } from "./profiles.ts";
import { makeAppsApi } from "./apps.ts";
import "../parts/index.ts"; // 組み込みアプリ（パーツ）を登録

export function buildCtx(env: Env): Ctx {
  // agent/identity/apps は ctx 全体（db 等）を使うため、先に ctx を組んでから注入する。
  const ctx = { profile: detectProfile(env).id, env, db: cfSqlStore(env), storage: cfStorage(env), ai: cfAi(env) } as Ctx;
  ctx.identity = localIdentity(ctx); // 会員/ロール解決は db ベース＝全 Profile 共通
  ctx.agent = cfAgent(ctx);
  ctx.apps = makeAppsApi(ctx);       // アプリ間連動
  return ctx;
}
