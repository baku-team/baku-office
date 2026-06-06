// 第2リファレンスの SqlStore アダプタ（移植性アーキ §3/§6 Profile B/C）。
// node:sqlite 上に D1 互換の prepare→bind→run/all/first を実装し、コア/パーツを CF 非依存で動かす。
// テスト専用（src 外）。本番バンドルには含めない。
import type { DatabaseSync } from "node:sqlite";
import type { SqlStore, KvPort } from "../src/core/ports.ts";

// テスト用の in-memory KV（StoragePort.kv 互換）。
export function memKv(): KvPort {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
    list: async (prefix) => [...m.keys()].filter((k) => !prefix || k.startsWith(prefix)),
  };
}

export function nodeSqlStore(db: DatabaseSync): SqlStore {
  const mk = (sql: string, bound: unknown[] = []) => ({
    bind: (...vals: unknown[]) => mk(sql, vals),
    run: async () => { db.prepare(sql).run(...(bound as never[])); return { success: true, results: [], meta: {} }; },
    all: async () => ({ results: db.prepare(sql).all(...(bound as never[])) }),
    first: async () => db.prepare(sql).get(...(bound as never[])) ?? null,
    raw: async () => [],
  });
  return {
    prepare: (sql: string) => mk(sql) as unknown as D1PreparedStatement,
    batch: async (stmts) => Promise.all((stmts as unknown as { run(): Promise<unknown> }[]).map((s) => s.run())) as unknown as Promise<D1Result[]>,
  };
}
