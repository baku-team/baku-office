// capability scoping（§セキュリティ・apps.ts 冒頭の方針の実体）。
// パーツ（アプリ）には「宣言した permission に対応する Port だけ」を注入し、未宣言の能力へのアクセスは実行時に拒否する。
// AI生成アプリ／外部取り込みアプリが、宣言を超えてDB書込・外部送信・他能力へ到達するのを構造的に防ぐ。
import type { Ctx, PartCtx, QueryStore, StoragePort, AiPort, AgentPort, GooglePort } from "./ports.ts";
import type { IdentityPort } from "./identity.ts";
import type { Permission } from "./apps.ts";
import { AppError, INFRA } from "../lib/errors.ts";

const deny = (perm: string, op: string): never => {
  throw new AppError(INFRA.CAPABILITY, `このアプリは「${perm}」権限を宣言していないため、${op} を実行できません。アプリのマニフェスト（permissions）に追加してください。`, 403);
};
// メソッド1つを permission で門番する。許可かつ実体があれば bind、無ければ拒否スタブ（部分ctxにも安全）。
function gate<T extends (...a: never[]) => unknown>(allowed: boolean, fn: T | undefined, self: unknown, perm: string, op: string): T {
  return (allowed && typeof fn === "function" ? (fn.bind(self) as T) : (((..._a: never[]) => deny(perm, op)) as unknown as T));
}
// メソッドだけを持つ Port の全面門番プロキシ（ai/agent/google/identity 用）。
function gatePort<T extends object>(allowed: boolean, port: T | undefined, perm: string, name: string): T {
  if (allowed && port) return port;
  return new Proxy({}, { get: (_t, prop) => () => deny(perm, `${name}.${String(prop)}`) }) as T;
}

// 宣言 permission に応じて Port を絞った PartCtx を返す（env は構造的に存在しない）。
// 部分的な ctx（テストstub等）でも未提供メソッドは拒否扱いになり、決して生の能力へ昇格しない。
export function scopeCtx(ctx: Ctx, permissions: readonly Permission[] = []): PartCtx {
  const has = (p: Permission) => permissions.includes(p);
  const s = ctx.storage as Partial<StoragePort> | undefined;
  const r = has("storage:read");
  const w = has("storage:write");

  const db: QueryStore = {
    all: gate(has("db:read"), ctx.db?.all, ctx.db, "db:read", "db.all"),
    first: gate(has("db:read"), ctx.db?.first, ctx.db, "db:read", "db.first"),
    run: gate(has("db:write"), ctx.db?.run, ctx.db, "db:write", "db.run"),
    batch: gate(has("db:write"), ctx.db?.batch, ctx.db, "db:write", "db.batch"),
  };

  const storage: StoragePort = {
    kv: {
      get: gate(r, s?.kv?.get, s?.kv, "storage:read", "kv.get"),
      list: gate(r, s?.kv?.list, s?.kv, "storage:read", "kv.list"),
      put: gate(w, s?.kv?.put, s?.kv, "storage:write", "kv.put"),
      delete: gate(w, s?.kv?.delete, s?.kv, "storage:write", "kv.delete"),
    },
    mode: typeof s?.mode === "function" ? s.mode.bind(s) : (() => "kv" as const), // 保存方式の判定のみ＝無害。
    getFile: gate(r, s?.getFile, s, "storage:read", "getFile"),
    ownsFile: gate(r, s?.ownsFile, s, "storage:read", "ownsFile"),
    saveFile: gate(w, s?.saveFile, s, "storage:write", "saveFile"),
  };

  return {
    profile: ctx.profile,
    db,
    storage,
    ai: gatePort<AiPort>(has("ai"), ctx.ai, "ai", "ai"),
    agent: gatePort<AgentPort>(has("agent"), ctx.agent, "agent", "agent"),
    google: gatePort<GooglePort>(has("net"), ctx.google, "net", "google"),
    identity: gatePort<IdentityPort>(has("members:read"), ctx.identity, "members:read", "identity"),
    apps: ctx.apps, // アプリ間連動は呼び出し時に target の requiredPermission を別途検査する。
  };
}
