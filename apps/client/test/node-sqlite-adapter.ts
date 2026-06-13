// 第2リファレンスの QueryStore アダプタ（移植性アーキ §3/§6 Profile B/C）。
// node:sqlite 上に方言中立 QueryStore（all/first/run/batch）を実装し、コア/パーツを CF 非依存で動かす。
// → CF(D1) と同一の中立IFで動くことを契約テストで実証。テスト専用（src 外）。本番バンドルには含めない。
import type { DatabaseSync } from "node:sqlite";
import type { QueryStore, SqlParam, KvPort } from "../src/core/ports.ts";

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

export function nodeSqlStore(db: DatabaseSync): QueryStore {
  const args = (params?: readonly SqlParam[]) => (params ?? []) as never[];
  return {
    all: async <T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]) =>
      db.prepare(sql).all(...args(params)) as T[],
    first: async <T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]) =>
      (db.prepare(sql).get(...args(params)) ?? null) as T | null,
    run: async (sql: string, params?: readonly SqlParam[]) => {
      const r = db.prepare(sql).run(...args(params));
      return { rowsWritten: Number(r.changes ?? 0), lastRowId: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : null };
    },
    batch: async (stmts) => { for (const s of stmts) db.prepare(s.sql).run(...args(s.params)); },
  };
}

// env.DB（CF D1 バインディング）互換シム。storage.ts 等まだ env.DB(D1直) を使う第一者コードのテスト用。
// ctx.db Port は nodeSqlStore(QueryStore) を使うこと。こちらは D1 の prepare→bind→all/first/run を模す。
export function nodeD1(db: DatabaseSync): D1Database {
  const mk = (sql: string, bound: unknown[] = []) => ({
    bind: (...vals: unknown[]) => mk(sql, vals),
    run: async () => { const r = db.prepare(sql).run(...(bound as never[])); return { success: true, results: [], meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } }; },
    all: async () => ({ results: db.prepare(sql).all(...(bound as never[])) }),
    first: async () => db.prepare(sql).get(...(bound as never[])) ?? null,
    raw: async () => [],
  });
  return {
    prepare: (sql: string) => mk(sql) as unknown as D1PreparedStatement,
    batch: async (stmts) => Promise.all((stmts as unknown as { run(): Promise<unknown> }[]).map((s) => s.run())) as unknown as Promise<D1Result[]>,
  } as unknown as D1Database;
}
