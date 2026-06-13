// 統一エラーコード（§サポート運用）。
// 目的：何か問題が起きたとき、ログを取らなくても「エラー番号」だけで発生箇所がわかるようにする。
// 仕組み：
//   1) 想定済みの失敗は AppError(code, userMessage, status) を投げる（finer なコード）。
//   2) 想定外の未捕捉エラーは middleware の全体catchが「APIルート/ページ由来の確定コード」を必ず付与する。
//   3) 画面には「（エラー番号: Exxxx）」を添えて表示し、サポートはこの番号＋本台帳で発生箇所を特定する。
// 採番規約（ERROR_CODES.md と一致させること）：
//   1xxx 認証・参加 / 2xxx 会計 / 3xxx 人・会員 / 4xxx 予定・Google / 5xxx ファイル・取り込み
//   6xxx AI・エージェント / 7xxx 設定・通知・課金 / 8xxx 連携(A2A)・外部・Webhook / 9xxx 基盤(KV/暗号/移行)
//   E0xxx はページ描画やフォールバック。

export type ErrCode = string;

// 想定済みの失敗。userMessage はそのまま利用者に見せる平易文。
export class AppError extends Error {
  code: ErrCode;
  status: number;
  userMessage: string;
  constructor(code: ErrCode, userMessage: string, status = 400, cause?: unknown) {
    super(`${code}: ${userMessage}`);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.userMessage = userMessage;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}
export const fail = (code: ErrCode, userMessage: string, status = 400, cause?: unknown): never => {
  throw new AppError(code, userMessage, status, cause);
};

// 基盤（横断）のコード。
export const INFRA = {
  WRITE_LIMIT: "E9001", // KV/D1 の1日あたり書き込み上限超過
  MASTER_KEY_MISSING: "E9002", // 本番で MASTER_KEY 未設定（暗号処理ブロック）
  CRYPTO: "E9003", // 暗号化/復号/ハッシュの失敗
  MIGRATION: "E9004", // スキーマ自動適用の失敗
  BOOT: "E9005", // 起動時点検の失敗
  HOST: "E9006", // ホスト(host worker)との通信失敗
  CAPABILITY: "E9007", // アプリ（パーツ）が宣言していない能力(Port)へアクセスした（capability scoping 違反）
} as const;

// 想定外エラーの既定文言（利用者向け）。
export const GENERIC_MSG = "申し訳ありません。処理中に問題が発生しました。";
export const LIMIT_MSG = "ただいま保存（書き込み）回数が本日の上限に達したため、一時的に保存できません。時間をおいて（日付が変わると回復します）お試しください。管理者の方は上位プラン（Workers Paid）で上限を引き上げられます。";

// KV/D1 の1日あたり書き込み上限超過（無料枠で起こりやすい）を検出する。
export function isWriteLimitError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e ?? "")).toLowerCase();
  return m.includes("limit exceeded") || m.includes("too many requests") || m.includes("daily request limit");
}

// APIルート（実パス）→ コード。未捕捉エラー時に「どのルートで失敗したか」を示す。
const ROUTE_CODES: Record<string, string> = {
  // 1xxx 認証・参加
  "/api/login": "E1001",
  "/api/join": "E1002",
  "/api/consent": "E1003",
  "/api/auth/google/relay": "E1012",
  // 2xxx 会計
  "/api/tx": "E2001",
  "/api/invoices": "E2002",
  // 3xxx 人・会員
  "/api/members": "E3001",
  "/api/membership": "E3002",
  "/api/review": "E3003",
  "/api/me/leave-request": "E3004",
  // 4xxx 予定・Google
  "/api/docs": "E4001",
  "/api/google": "E4010",
  "/api/google/start": "E4011",
  "/api/google/callback": "E4012",
  // 5xxx ファイル・取り込み
  "/api/files": "E5001",
  "/api/import": "E5002",
  "/api/drive": "E5010",
  "/api/drive/start": "E5011",
  "/api/drive/callback": "E5012",
  "/api/store": "E5020",
  "/api/data": "E5030",
  "/api/backup": "E5040",
  // 6xxx AI・エージェント
  "/api/chat": "E6001",
  "/api/chat-sessions": "E6002",
  "/api/skills": "E6003",
  "/api/agent-actions": "E6004",
  "/api/autopilot": "E6005",
  "/api/mascot": "E6006",
  "/api/capabilities": "E6007",
  "/api/activity": "E6008",
  // 7xxx 設定・通知・課金
  "/api/settings": "E7001",
  "/api/site": "E7002",
  "/api/site/join": "E7003",
  "/api/update": "E7004",
  "/api/billing/start": "E7005",
  "/api/notifications": "E7006",
  "/api/personal": "E7007",
  "/api/usage": "E7008",
  "/api/keys": "E7009",
  // 8xxx 連携(A2A)・外部・Webhook
  "/api/a2a/inbound": "E8001",
  "/api/a2a/manage": "E8002",
  "/api/report": "E8010",
  "/api/cron/drain": "E8020",
  "/api/line/webhook": "E8030",
  "/api/site/stripe-webhook": "E8031",
};
// 動的セグメントを含むAPIルート。
const ROUTE_PATTERNS: [RegExp, string][] = [
  [/^\/api\/auth\/[^/]+\/start$/, "E1010"],
  [/^\/api\/auth\/[^/]+\/callback$/, "E1011"],
];
// ページ（非API）の領域コード。先頭セグメントから「どの画面か」を示す。
const PAGE_AREA: Record<string, string> = {
  "": "E0100", // ホーム
  accounting: "E0200",
  invoices: "E0210",
  membership: "E0300",
  members: "E0300",
  review: "E0310",
  schedule: "E0400",
  calendar: "E0401",
  meet: "E0402",
  gmail: "E0403",
  minutes: "E0410",
  files: "E0500",
  import: "E0510",
  drive: "E0520",
  backup: "E0530",
  chat: "E0600",
  apps: "E0610",
  settings: "E0700",
  billing: "E0710",
  usage: "E0720",
  diagnostics: "E0730",
  legal: "E0740",
  approvals: "E0750",
  personal: "E0800",
  account: "E0810",
  consent: "E0820",
  activate: "E0830",
  login: "E0840",
  join: "E0850",
};

// パスからコードを引く。API は厳密一致→パターン、ページは先頭セグメントの領域コード。
export function codeForPath(pathname: string): string {
  if (ROUTE_CODES[pathname]) return ROUTE_CODES[pathname];
  for (const [re, c] of ROUTE_PATTERNS) if (re.test(pathname)) return c;
  const seg = pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  return PAGE_AREA[seg] ?? "E0000";
}

// 任意のエラーを「利用者向け文言・状態コード・エラー番号」に正規化する（middleware の全体catchで使用）。
export function resolveError(e: unknown, pathname: string): { status: number; code: string; message: string } {
  if (e instanceof AppError) return { status: e.status, code: e.code, message: e.userMessage };
  if (isWriteLimitError(e)) return { status: 503, code: INFRA.WRITE_LIMIT, message: LIMIT_MSG };
  return { status: 500, code: codeForPath(pathname), message: GENERIC_MSG };
}

// 利用者向け文言にエラー番号を添える。
export const appendCode = (message: string, code: string): string => `${message}（エラー番号: ${code}）`;
