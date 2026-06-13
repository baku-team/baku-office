// ポータブルコアの能力Port（移植性アーキ §2/§3）。
// Phase 1：既存実装を「そのまま包む」ための最小インターフェース。挙動不変・無リスク。
// 過渡期のため env 素通しを残すが、段階的に ctx.db/storage/ai/agent へ寄せていく。
import type { Role } from "@baku-office/shared";

// DB（保存・問合せ）。方言中立IF：CF型(D1)を露出せず、読み(all/first)と書き(run)を分離する
// （capability scoping の db:read / db:write の土台）。サードパーティ製パーツはこの中立IFのみに依存する。
export type SqlParam = string | number | boolean | null | ArrayBuffer | ArrayBufferView;
export interface QueryStore {
  all<T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<T | null>;
  run(sql: string, params?: readonly SqlParam[]): Promise<{ rowsWritten: number; lastRowId: number | null }>;
  batch(stmts: ReadonlyArray<{ sql: string; params?: readonly SqlParam[] }>): Promise<void>;
}

// ストレージ（KV＋ファイル）。鍵保管・トークン等の小KVと、ファイル本体（KV/R2）を扱う。
export interface KvPort {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
export interface StoragePort {
  kv: KvPort;
  mode(): "r2" | "kv";
  saveFile(file: File, createdBy: string): Promise<{ id: string; mode: string }>;
  getFile(id: string): Promise<{ buf: ArrayBuffer; mime: string; name: string } | null>;
  ownsFile(id: string, owner: string): Promise<boolean>; // 所有者検査（IDOR防止・storage:read）。
}

// AI（推論）。現行で公開済みの能力のみ。chat 本体はエージェント内部に閉じる（Phase 2 で整理）。
export interface AiPort {
  transcribe(buf: ArrayBuffer, mime: string): Promise<string | null>;
  webSearch(query: string): Promise<string | null>;
  makeDocument(owner: string, baseUrl: string, a: { type: string; title: string; content: string }): Promise<string>;
  extractInvoice(file: { buf: ArrayBuffer; mime: string; name: string }): Promise<import("../lib/media-ai.ts").InvoiceExtract>;
  summarizeTranscript(transcript: string): Promise<{ summary: string; actions: { content: string; due?: string }[] } | null>;
}

// Google 連携（Calendar/Gmail/Meet 等の API 呼び出し）。env(秘密)を露出せず、認可済みの fetch だけを公開。
export interface GooglePort {
  fetch(url: string, init?: RequestInit): Promise<Response | null>;
}

// エージェント（道具ループ）。チャットはセッション履歴・モデル選択を渡せる。
export interface AgentPort {
  run(input: { owner: string; text: string; role?: Role; image?: { mimeType: string; dataB64: string }; baseUrl?: string; history?: import("./ai.ts").Turn[]; model?: "gemini" | "claude" | "local" }): Promise<string>;
}

// コアへ注入される実行コンテキスト（特権・第一者）。env を含む＝host/API/cron 側で使う。
// パーツ（業務モジュール）には env を渡さない＝下の PartCtx（capability scoping 済み）を注入する。
export type Ctx = {
  profile: string; // "cf" 等。診断用（コアは分岐に使わない）。
  env: Env;        // 第一者(host/API)専用。パーツへは scopeCtx で除去して渡す。
  db: QueryStore;
  storage: StoragePort;
  ai: AiPort;
  agent: AgentPort;
  google: GooglePort;
  identity: import("./identity.ts").IdentityPort;
  apps: import("./apps.ts").AppsApi; // アプリ間連動（§アプリレジストリ）
};

// パーツに渡す実行コンテキスト。env を持たず、宣言した権限に応じて Port を絞る（§capability scoping）。
// 未宣言の Port にアクセスすると実行時に AppError を投げる（scopeCtx 実装）。
export type PartCtx = Omit<Ctx, "env">;
