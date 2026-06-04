// フェーズ2（顧客アカウント側の固定エージェント相当）。
// LINE Webhook → 署名検証 → ライセンス判定 → 署名config適用 → Claude → 返信。
// config駆動/ライセンスは #2機構（署名payloadをKVに置き、リクエスト毎に検証）。
import { type Envelope, type Ed25519Jwk } from "./crypto";
import {
  type ConfigPayload,
  type LeasePayload,
  BASE_CAPS,
  CONFIGS,
  signConfig,
  signLease,
  openConfig,
  openLease,
  licensed,
} from "./license";

interface Env {
  ANTHROPIC_API_KEY: string;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  BRAIN_MODEL: string;
  HISTORY: KVNamespace;
  MEDIA: KVNamespace; // 画像・書類本体（無料＝KV・カード不要）
  MEDIA_R2?: R2Bucket; // Paid契約者向け（R2バインディングがあれば優先・大容量/高速）
  DB: D1Database; // メモ等の構造化データ
  PUBLIC_BASE_URL: string; // 配信ベースURL（Worker自身）。/media/<key> で配信
  GEMINI_API_KEY: string; // 音声文字起こし（BYOK・任意）
  GOOGLE_CLIENT_ID: string; // Google Drive OAuth（大容量ストレージ・任意）
  GOOGLE_CLIENT_SECRET: string; // 同上
  INTERNAL_KEY: string; // 自己連鎖Cron（/internal/drain）の共有秘密
  SIGNING_JWK?: string; // Ed25519秘密鍵JWK（ホスト/CP側のみ。クライアントは持たない）
  VERIFY_PUBLIC_JWK?: string; // Ed25519公開鍵JWK（クライアント側の検証用。本番はこれだけを置く）
  ADMIN_KEY: string; // /admin 認証（ホスト側）
  DEV_USER_IDS?: string; // 開発バイパス用のLINE userId（カンマ区切り）。本番は空。ここに載るアカウントだけ認証を飛ばす。
  CLIENT?: Fetcher; // ホスト側のみ：既定(self)クライアントへのService Binding（同一アカウントの推奨配信路。workers.dev同士の直fetchはCFが遮断するため）。
  CLIENT_BASE_URL?: string; // ホスト側のみ：既定(self)クライアントの配信先URL（別アカウント・カスタムドメイン）。
  PROVISION_KEY?: string; // 配信(/provision)の共有シークレット。クライアント=受信検証／ホスト=既定(self)宛の送信ヘッダ。
  TENANTS?: KVNamespace; // ホスト側のみ：テナント台帳（tenant→{url, provisionKey}）。多数顧客の配信先を動的管理。
  TENANT_ID?: string; // クライアント側のみ：この顧客のテナントID。設定時は lease.tenant 一致を必須化（誤配信/横流し防止）。
}

type Msg = { role: "user" | "assistant"; content: string };
type ApiMsg = { role: "user" | "assistant"; content: unknown }; // tool往復で content が配列になる
type ContentBlock = { type: string; text?: string; id?: string; name?: string; input?: unknown };
type AnthropicResp = {
  content?: ContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    server_tool_use?: { web_search_requests?: number };
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};
type MediaItem = { type: "image"; url: string };
type ToolInput = {
  content?: string;
  id?: number;
  kind?: string;
  query?: string;
  remind_at?: string;
  type?: string;
  instruction?: string;
  category?: string;
  from?: string;
  to?: string;
  scope?: string;
  title?: string;
  date?: string;
  name?: string;
  fresh?: boolean;
  url?: string;
};
type NoteRow = {
  id: number;
  kind: string;
  content: string;
  name: string | null;
  done: number;
  scope: string;
  file_id: string | null;
  status: string;
  created_at: number;
};
type ReminderRow = { id: number; content: string; remind_at: number };
type KnowledgeRow = { id: number; content: string };
type JobRow = {
  id: number;
  note_id: number;
  user_id: string;
  scope: string;
  file_uri: string | null;
  total_pages: number;
  next_page: number;
  chunk_size: number;
  partial: string;
  status: string;
  engine: string;
};
type DocRow = {
  id: number;
  name: string | null;
  category: string | null;
  doc_date: string | null;
  amount: number | null;
  scope: string;
  created_at: number;
};
const MAX_MSGS = 10; // 直近5往復だけ文脈に残す（トークン・コスト抑制）
const HISTORY_TTL = 60 * 60 * 24 * 30; // 30日アクセスが無ければ履歴を自動削除
const KV_LEASE = "lease";
const KV_CONFIG = "cfg";
const KV_MODE = (u: string): string => `mode:${u}`; // ユーザーごとの処理方針（cheap=Gemini無料 / secure=Claude課金・学習なし）
const KV_NOASK = (u: string): string => `noask:${u}`; // 重要情報の都度確認を抑制するフラグ
const KV_PENDING = (u: string): string => `pend:${u}`; // 確認待ちの保留メッセージ
const KV_SUM = (u: string): string => `sum:${u}`; // 古い履歴を畳んだローリング要約（文脈維持×トークン圧縮）
const KV_SEEN = (id: string): string => `seen:${id}`; // 処理済みwebhookEventId（LINE再送の重複排除）
const HISTORY_KEEP = 12; // 生のまま文脈に残す直近件数
const HISTORY_FOLD_AT = 24; // これを超えたら古い分を要約に畳む

const nowSec = (): number => Math.floor(Date.now() / 1000);
// 署名鍵（ホスト/CP側のみ・/admin で使用）。クライアントには配らない。
const jwkOf = (env: Env): Ed25519Jwk => {
  if (!env.SIGNING_JWK) throw new Error("SIGNING_JWK 未設定（署名はホスト側のみ）");
  return JSON.parse(env.SIGNING_JWK) as Ed25519Jwk;
};
// 検証鍵（クライアント側・公開鍵のみ）。本番は VERIFY_PUBLIC_JWK を置く。
// 開発の単一Worker構成では SIGNING_JWK の公開部分(x)で代替（importVerifyKey が x のみ使う）。
const verifyJwkOf = (env: Env): Ed25519Jwk => {
  const raw = env.VERIFY_PUBLIC_JWK ?? env.SIGNING_JWK;
  if (!raw) throw new Error("VERIFY_PUBLIC_JWK 未設定（検証鍵がありません）");
  return JSON.parse(raw) as Ed25519Jwk;
};

// JST「YYYY-MM-DD HH:MM」⇄ epoch秒
function parseJst(s: string): number | null {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}
function fmtJst(epoch: number): string {
  return new Date((epoch + 9 * 3600) * 1000).toISOString().slice(0, 16).replace("T", " ");
}

// LINE署名検証：raw body の HMAC-SHA256(channel secret) を base64 して X-Line-Signature と比較。
async function verifyLineSignature(secret: string, body: string, signature: string): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 料金（USD/Mtok・2026時点）。BYOKなので顧客負担。為替は目安。
const PRICE: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5-20251001": { in: 1, out: 5 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-opus-4-8": { in: 5, out: 25 },
};
const USD_JPY = 160;

// タスク難易度 → モデル（Sonnet既定／簡易Haiku／難Opus）
const MODELS = {
  simple: "claude-haiku-4-5-20251001",
  normal: "claude-sonnet-4-6",
  hard: "claude-opus-4-8",
} as const;
type Tier = keyof typeof MODELS;

const GEMINI_MODEL = "gemini-3.5-flash"; // メイン（要約/OCR/音声/Gemini一本時のnormal以上）
const GEMINI_LITE = "gemini-3.1-flash-lite"; // ルーター/simple（軽量・低レイテンシ・無料枠）
const MODEL_LABEL: Record<string, string> = {
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-opus-4-8": "Claude Opus 4.8",
};

// Anthropic公式 Web検索（server側で実行・GA）。Claudeが必要時のみ呼ぶ。
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 5 };

const ROUTER_INSTRUCTION =
  "次の依頼の難易度を simple / normal / hard の1語だけで答えてください。" +
  "simple=雑談や短い事実質問、normal=通常の説明・相談・要約、hard=高度な推論/コード/長文分析/専門的判断。";

// 難易度ルーター：まず無料枠のGeminiで分類。Geminiが無ければClaude、どちらも無ければnormal。
async function routeModel(env: Env, text: string): Promise<Tier> {
  if (env.GEMINI_API_KEY) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_LITE}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: ROUTER_INSTRUCTION }] },
            contents: [{ parts: [{ text: text.slice(0, 2000) }] }],
            generationConfig: { maxOutputTokens: 10 },
          }),
        },
      );
      if (r.ok) {
        const data = (await r.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const label = (data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "").toLowerCase();
        if (label.includes("simple")) return "simple";
        if (label.includes("hard")) return "hard";
        return "normal";
      }
    } catch {
      /* fall through to Claude */
    }
  }
  if (!env.ANTHROPIC_API_KEY) return "normal";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODELS.simple, max_tokens: 8, system: ROUTER_INSTRUCTION, messages: [{ role: "user", content: text.slice(0, 2000) }] }),
    });
    if (!res.ok) return "normal";
    const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
    const label = (data.content.find((c) => c.type === "text")?.text ?? "").toLowerCase();
    if (label.includes("simple")) return "simple";
    if (label.includes("hard")) return "hard";
    return "normal";
  } catch {
    return "normal";
  }
}

// クライアントツール：会話の文脈から保存/一覧を判断（「〜メモして」「予定を覚えて」等）。
const SAVE_NOTE_TOOL = {
  name: "save_note",
  description:
    "ユーザーが覚えておきたい情報・予定・タスク・メモを保存する。『〜をメモして』『覚えておいて』など保存の意図が読み取れたら呼ぶ。組織全員で共有すべき内容は scope='shared'、本人だけなら 'personal'。",
  input_schema: {
    type: "object",
    properties: {
      content: { type: "string", description: "保存する内容（日時や要点を含め簡潔に）" },
      scope: { type: "string", enum: ["personal", "shared"], description: "personal=本人のみ / shared=組織共有" },
    },
    required: ["content"],
  },
};
const LIST_NOTES_TOOL = {
  name: "list_notes",
  description: "保存済みのメモ・予定・画像・書類の一覧（#番号つき）を取得する。『何をメモしてた？』『一覧』等で呼ぶ。",
  input_schema: { type: "object", properties: {} },
};
const GET_MEDIA_TOOL = {
  name: "get_media",
  description:
    "保存済みの画像・書類・記録(議事録等)を呼び出す。『さっきの画像見せて』『議事録を出して』『#3を見せて』等で呼ぶ。idを指定すれば該当、無ければ種別の最新を返す。",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "number", description: "一覧の#番号（任意）" },
      kind: { type: "string", enum: ["image", "file", "record"], description: "画像/書類/記録（id省略時の最新指定・任意）" },
    },
  },
};
const DELETE_NOTE_TOOL = {
  name: "delete_note",
  description: "保存済みのメモ・画像・書類を削除する。『#3を削除』『さっきのメモ消して』等で呼ぶ。",
  input_schema: { type: "object", properties: { id: { type: "number", description: "一覧の#番号" } }, required: ["id"] },
};
const SEARCH_NOTES_TOOL = {
  name: "search_notes",
  description: "保存済みのメモ・書類をキーワードで検索する。『牛乳のメモある？』『会議の書類探して』等で呼ぶ。",
  input_schema: { type: "object", properties: { query: { type: "string", description: "検索語" } }, required: ["query"] },
};
const COMPLETE_NOTE_TOOL = {
  name: "complete_note",
  description: "メモ・タスクを完了済みにする。『#3を完了』『買い物終わった』等で呼ぶ。",
  input_schema: { type: "object", properties: { id: { type: "number", description: "一覧の#番号" } }, required: ["id"] },
};
const SET_REMINDER_TOOL = {
  name: "set_reminder",
  description:
    "指定時刻にLINEへ通知するリマインダーを登録する。『明日9時にゴミ出しをリマインド』等で呼ぶ。remind_at は JST『YYYY-MM-DD HH:MM』で、システムが伝える現在日時から計算して絶対時刻で渡す。",
  input_schema: {
    type: "object",
    properties: {
      content: { type: "string", description: "通知内容" },
      remind_at: { type: "string", description: "通知時刻 JST『YYYY-MM-DD HH:MM』" },
    },
    required: ["content", "remind_at"],
  },
};
const LIST_REMINDERS_TOOL = {
  name: "list_reminders",
  description: "未通知のリマインダー一覧を取得する。『リマインダー見せて』『予定の通知ある？』等で呼ぶ。",
  input_schema: { type: "object", properties: {} },
};
const CANCEL_REMINDER_TOOL = {
  name: "cancel_reminder",
  description: "リマインダーを取り消す。『#2のリマインダー消して』等で呼ぶ。",
  input_schema: {
    type: "object",
    properties: { id: { type: "number", description: "リマインダーの#番号" } },
    required: ["id"],
  },
};
const MAKE_DOCUMENT_TOOL = {
  name: "make_document",
  description:
    "スライド・資料・PDF・Excelを実際に生成する（Claude Agent Skills）。『〜のスライド作って』『〜の資料をPDFで』『集計表をExcelで』等で呼ぶ。instruction には構成・項目・テーマを具体的に。",
  input_schema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["slide", "doc", "pdf", "sheet"], description: "slide=PowerPoint, doc=Word, pdf=PDF, sheet=Excel" },
      instruction: { type: "string", description: "作成する資料の内容・構成・項目の詳しい指示" },
    },
    required: ["type", "instruction"],
  },
};
const SAVE_KNOWLEDGE_TOOL = {
  name: "save_knowledge",
  description:
    "後で参照する長めの知識・資料・マニュアル本文を保存する。『この内容を覚えておいて（長文）』『マニュアルを登録』等で呼ぶ。組織共有は scope='shared'、本人のみは 'personal'。短い予定は save_note。",
  input_schema: {
    type: "object",
    properties: {
      content: { type: "string", description: "保存する本文" },
      scope: { type: "string", enum: ["personal", "shared"], description: "personal=本人のみ / shared=組織共有" },
    },
    required: ["content"],
  },
};
const SEARCH_KNOWLEDGE_TOOL = {
  name: "search_knowledge",
  description:
    "保存済みの知識・資料からキーワードで関連箇所だけを取り出す。『◯◯について登録した資料あった？』等で呼ぶ。全文をやり取りせず必要箇所のみ参照しトークンを節約する。",
  input_schema: { type: "object", properties: { query: { type: "string", description: "検索語" } }, required: ["query"] },
};
const QUERY_DOCS_TOOL = {
  name: "query_documents",
  description:
    "保存した文書・画像を分類や期間で絞り込む。『6月の領収書まとめて』『先月の請求書一覧』『名刺を一覧』等で呼ぶ。日付は文書の日付を優先し、無ければ保存日。結果（日付・分類・金額）を使って集計してよい。",
  input_schema: {
    type: "object",
    properties: {
      category: { type: "string", description: "分類（部分一致・任意）例：領収書・請求書・名刺・写真" },
      from: { type: "string", description: "開始日 YYYY-MM-DD（任意）" },
      to: { type: "string", description: "終了日 YYYY-MM-DD（任意）" },
    },
  },
};
const SAVE_PROFILE_TOOL = {
  name: "save_profile",
  description:
    "人物の経歴・スキル・人脈などのプロフィールを登録/追記する。『私のスキルは〜』『経歴を登録して』、履歴書PDFの内容などで呼ぶ。組織の全員が人材検索で参照できる。name は対象者の氏名。",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "対象者の氏名" },
      content: { type: "string", description: "スキル・経歴・人脈などの本文" },
    },
    required: ["name", "content"],
  },
};
const SEARCH_PEOPLE_TOOL = {
  name: "search_people",
  description:
    "組織メンバーのプロフィール（スキル・経歴・人脈）を横断検索して質問に答える。『Pythonできる人いる？』『◯◯さんのスキルでこれ可能？』『金融業界の人脈ある人は？』『これができる人いる？』等で呼ぶ。",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "探したいスキル・条件・質問" } },
    required: ["query"],
  },
};
const GET_PROFILE_TOOL = {
  name: "get_profile",
  description:
    "特定の人のプロフィール（経歴・スキル・人脈）を表示する。『◯◯さんのスキルを教えて』『◯◯さんの経歴は？』等で呼ぶ。",
  input_schema: {
    type: "object",
    properties: { name: { type: "string", description: "対象者の氏名" } },
    required: ["name"],
  },
};
const UPLOAD_STATUS_TOOL = {
  name: "upload_status",
  description:
    "直近または指定したファイルの取り込み状況（アップロード中/完了/失敗）を確認する。『取り込めた？』『さっきのファイル取り込めた？』等の進捗確認で呼ぶ。",
  input_schema: {
    type: "object",
    properties: { id: { type: "number", description: "ファイルの#番号（省略時は直近のファイル）" } },
  },
};
const READ_FILE_TOOL = {
  name: "read_file",
  description:
    "取り込んだファイル（PDF・テキスト）の内容を参照して質問に答える。『この資料の要点は？』『事業計画の売上目標は？』『さっきのPDFについて』等で呼ぶ。id省略時は直近のファイル。query に具体的な質問を入れる。" +
    "通常は一度作った要約キャッシュで軽く答えるが、特定資料の詳細・数値・契約条件など正確性が重要な質問では fresh=true を指定して本文を都度確認する。",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "number", description: "ファイルの#番号（任意・省略時は直近）" },
      query: { type: "string", description: "ファイル内容への質問・指示" },
      fresh: {
        type: "boolean",
        description: "true=本文を都度確認（正確性重視・特定資料の詳細）。false/省略=要約キャッシュで軽く回答",
      },
    },
  },
};
const SAVE_RECORD_TOOL = {
  name: "save_record",
  description:
    "エージェントが作成したテキスト成果物（議事録・要約・レポート・まとめ等）を分類付きで保存する。『この会議を議事録にまとめて保存』『要約を記録して』等で、本文を生成してから呼ぶ。資料ファイル(PDF/PPT/Excel)が必要なら make_document を使う。",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "タイトル（一覧に表示）" },
      content: { type: "string", description: "本文（議事録・要約の全文）" },
      category: { type: "string", description: "分類 例：議事録・要約・レポート" },
      date: { type: "string", description: "対象の日付 YYYY-MM-DD（任意・会議日など）" },
      scope: { type: "string", enum: ["personal", "shared"], description: "personal=本人のみ / shared=組織共有" },
    },
    required: ["title", "content"],
  },
};
const REGISTER_LINK_TOOL = {
  name: "register_link",
  description:
    "Google Driveなど外部の共有リンク（大容量ファイル等）を登録する。ユーザーがファイル/フォルダのURL（https://...）を送ってきたら呼ぶ。大容量ファイルはエージェント保存せずこのリンク登録で扱う。",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "共有URL（https://...）" },
      title: { type: "string", description: "名前（任意）" },
      category: { type: "string", description: "分類（任意・例：資料/動画）" },
    },
    required: ["url"],
  },
};
const SHARE_ITEM_TOOL = {
  name: "share_item",
  description:
    "保存済みのメモ・画像・書類・知識を組織全員で共有する（または共有解除）。『#3を共有して』『さっきの領収書をみんなに共有』『共有して』等で呼ぶ。id省略時は直近に本人が保存したもの。",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "number", description: "共有する#番号（省略時は直近）" },
      scope: { type: "string", enum: ["shared", "personal"], description: "shared=共有 / personal=共有解除" },
    },
  },
};

// 全ツール定義（最後の要素に cache_control を付けてキャッシュ＝トークン節約）。
const TOOL_DEFS = [
  WEB_SEARCH_TOOL,
  SAVE_NOTE_TOOL,
  LIST_NOTES_TOOL,
  GET_MEDIA_TOOL,
  DELETE_NOTE_TOOL,
  SEARCH_NOTES_TOOL,
  COMPLETE_NOTE_TOOL,
  SET_REMINDER_TOOL,
  LIST_REMINDERS_TOOL,
  CANCEL_REMINDER_TOOL,
  MAKE_DOCUMENT_TOOL,
  SAVE_KNOWLEDGE_TOOL,
  SEARCH_KNOWLEDGE_TOOL,
  QUERY_DOCS_TOOL,
  UPLOAD_STATUS_TOOL,
  READ_FILE_TOOL,
  SAVE_RECORD_TOOL,
  SAVE_PROFILE_TOOL,
  SEARCH_PEOPLE_TOOL,
  GET_PROFILE_TOOL,
  REGISTER_LINK_TOOL,
  SHARE_ITEM_TOOL,
];

// Gemini function calling 用にツール定義を変換（input_schema を持つ client tool のみ。web_searchは除外）。
const GEMINI_FUNCTIONS = TOOL_DEFS.filter((t) => "input_schema" in t).map((t) => {
  const tool = t as { name: string; description: string; input_schema: unknown };
  return { name: tool.name, description: tool.description, parameters: tool.input_schema };
});

type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: { result: string } };
};
type GeminiResp = {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
};

// 履歴が伸びたら古い部分をHaikuで要約して圧縮（文脈を保ちつつトークン節約）。
async function summarize(env: Env, msgs: Msg[]): Promise<string> {
  const text = msgs
    .map((m) => `${m.role === "user" ? "ユーザー" : "アシスタント"}: ${m.content}`)
    .join("\n")
    .slice(0, 6000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODELS.simple,
        max_tokens: 400,
        system: "次の会話を、後で文脈に使えるよう日本語の箇条書きで簡潔に要約。固有名詞・決定事項・依頼を残す。",
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
    return data.content.find((c) => c.type === "text")?.text ?? "";
  } catch {
    return "";
  }
}

// 古い履歴を畳む要約（secure＝Claude／cheap＝Gemini優先。機微をGeminiに送らないためmodeで分岐）。
async function foldSummary(env: Env, text: string, mode: Mode): Promise<string> {
  const prompt =
    "次の会話を、後で文脈を思い出すための短い箇条書き要約にしてください。重要な事実・決定事項・固有名詞・依頼中の事項のみ、250字以内。\n\n" +
    text.slice(0, 10000);
  const claudeFirst = mode === "secure" && env.ANTHROPIC_API_KEY;
  if (!claudeFirst && env.GEMINI_API_KEY) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_LITE}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 300 } }),
        },
      );
      if (r.ok) {
        const d = (await r.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const t = d.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
        if (t) return t;
      }
    } catch {
      /* fall through to Claude */
    }
  }
  if (env.ANTHROPIC_API_KEY) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: MODELS.simple,
          max_tokens: 400,
          system: "会話を後で使える日本語の箇条書きで簡潔に要約。固有名詞・決定・依頼を残す。",
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (res.ok) {
        const d = (await res.json()) as { content: Array<{ type: string; text?: string }> };
        return d.content.find((c) => c.type === "text")?.text ?? "";
      }
    } catch {
      /* noop */
    }
  }
  return "";
}

// 履歴が一定量を超えたら、古い分を既存要約に畳み込んでD1から削除（文脈を保ったままトークン固定費に圧縮）。
async function maybeFoldHistory(env: Env, userId: string, mode: Mode): Promise<void> {
  const { results } = await env.DB.prepare("SELECT id, role, text FROM history WHERE user_id = ? ORDER BY id ASC")
    .bind(userId)
    .all<{ id: number; role: string; text: string }>();
  if (results.length <= HISTORY_FOLD_AT) return;
  const fold = results.slice(0, results.length - HISTORY_KEEP);
  if (!fold.length) return;
  const prev = (await env.HISTORY.get(KV_SUM(userId))) || "";
  const body =
    (prev ? `これまでの要約:\n${prev}\n\n新しい会話:\n` : "") +
    fold.map((r) => `${r.role === "assistant" ? "AI" : "ユーザー"}: ${r.text}`).join("\n");
  const sum = await foldSummary(env, body, mode);
  if (!sum) return;
  await env.HISTORY.put(KV_SUM(userId), sum.slice(0, 4000));
  await env.DB.prepare("DELETE FROM history WHERE user_id = ? AND id <= ?").bind(userId, fold[fold.length - 1].id).run();
}

async function callAnthropic(env: Env, model: string, system: string, messages: ApiMsg[]): Promise<AnthropicResp> {
  // プロンプトキャッシュ：system と tools プレフィックスをキャッシュ（5分TTL）。
  // 末尾ツールに cache_control を置くと、その前の全ツール定義＋systemがキャッシュ対象になる。
  const tools = TOOL_DEFS.map((t, i) =>
    i === TOOL_DEFS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t,
  );
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`anthropic ${res.status}: ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as AnthropicResp;
}

// Claude Agent Skills で資料/スライドを生成 → Files APIで取得 → R2保存 → DLリンク。
const SKILL_MAP: Record<string, string> = { slide: "pptx", doc: "docx", pdf: "pdf", sheet: "xlsx" };

function collectFileIds(node: unknown, acc: string[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) collectFileIds(x, acc);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === "file_id" && typeof v === "string") acc.push(v);
    else collectFileIds(v, acc);
  }
}

async function downloadAnthropicFile(
  env: Env,
  fileId: string,
): Promise<{ buf: ArrayBuffer; filename: string; mime: string } | null> {
  const headers = {
    "x-api-key": env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "files-api-2025-04-14",
  };
  let filename = `${fileId}`;
  let mime = "application/octet-stream";
  const meta = await fetch(`https://api.anthropic.com/v1/files/${fileId}`, { headers });
  if (meta.ok) {
    const m = (await meta.json()) as { filename?: string; mime_type?: string };
    filename = m.filename ?? filename;
    mime = m.mime_type ?? mime;
  }
  const content = await fetch(`https://api.anthropic.com/v1/files/${fileId}/content`, { headers });
  if (!content.ok) return null;
  return { buf: await content.arrayBuffer(), filename, mime };
}

async function generateDocument(env: Env, userId: string, type: string, instruction: string): Promise<string> {
  if (!env.PUBLIC_BASE_URL) return "（配信URLが未設定のため資料を返せません。管理者にご相談ください）";
  const skillId = SKILL_MAP[type] ?? "pdf";
  const betas = "code-execution-2025-08-25,skills-2025-10-02";
  const messages: ApiMsg[] = [{ role: "user", content: instruction }];
  let resp: AnthropicResp | null = null;
  for (let i = 0; i < 10; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": betas,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        container: { skills: [{ type: "anthropic", skill_id: skillId, version: "latest" }] },
        tools: [{ type: "code_execution_20250825", name: "code_execution" }],
        messages,
      }),
    });
    if (!r.ok) {
      const d = await r.text();
      throw new Error(`skills ${r.status}: ${d.slice(0, 200)}`);
    }
    resp = (await r.json()) as AnthropicResp;
    if (resp.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: resp.content });
  }
  const ids: string[] = [];
  collectFileIds(resp?.content, ids);
  if (!ids.length) return "資料を生成できませんでした（出力ファイルが見つかりません）。";
  const links: string[] = [];
  for (const fid of ids) {
    const f = await downloadAnthropicFile(env, fid);
    if (!f) continue;
    const key = `media/${userId}/${fid}-${f.filename}`;
    const ref = await putMedia(env, key, f.buf, f.mime);
    if (!ref) continue;
    await env.DB.prepare(
      "INSERT INTO notes (user_id, kind, content, name, category, doc_date, amount, scope, done, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'personal', 0, ?)",
    )
      .bind(userId, "file", ref, f.filename, "生成資料", fmtDate(nowSec()), null, nowSec())
      .run();
    links.push(`${env.PUBLIC_BASE_URL}/media/${encodeURIComponent(ref)}`);
  }
  if (!links.length) return "資料は生成されましたが取得に失敗しました。";
  return `資料を作成しました：\n${links.join("\n")}`;
}

type ToolOut = { result: string; media?: MediaItem };

// 取り込み済みファイル（file_idあり）を id 指定 or 直近で取得。
async function findFile(env: Env, userId: string, id?: number): Promise<NoteRow | null> {
  if (id) {
    return env.DB.prepare(
      "SELECT id, kind, content, name, done, scope, file_id, status, created_at FROM notes WHERE (user_id = ? OR scope = 'shared') AND id = ?",
    )
      .bind(userId, id)
      .first<NoteRow>();
  }
  return env.DB.prepare(
    "SELECT id, kind, content, name, done, scope, file_id, status, created_at FROM notes WHERE (user_id = ? OR scope = 'shared') AND kind = 'file' AND status = 'done' ORDER BY id DESC LIMIT 1",
  )
    .bind(userId)
    .first<NoteRow>();
}

// 直近 or 指定のファイルの取り込み状況を取得（uploading/done/error）。
async function fileStatus(env: Env, userId: string, id?: number): Promise<NoteRow | null> {
  if (id) {
    return env.DB.prepare(
      "SELECT id, kind, content, name, done, scope, file_id, status, created_at FROM notes WHERE (user_id = ? OR scope = 'shared') AND id = ?",
    )
      .bind(userId, id)
      .first<NoteRow>();
  }
  return env.DB.prepare(
    "SELECT id, kind, content, name, done, scope, file_id, status, created_at FROM notes WHERE user_id = ? AND kind = 'file' ORDER BY id DESC LIMIT 1",
  )
    .bind(userId)
    .first<NoteRow>();
}

// file_id を document block で渡し、質問に答える（PDF/テキスト）。出力短めでwaitUntil内に収める。
async function readFile(env: Env, fileId: string, question: string): Promise<string> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "files-api-2025-04-14",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODELS.normal,
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: [
              { type: "document", source: { type: "file", file_id: fileId } },
              { type: "text", text: question || "この資料の要点を日本語でまとめてください。" },
            ],
          },
        ],
      }),
    });
    if (!r.ok) return "";
    const data = (await r.json()) as { content: Array<{ type: string; text?: string }> };
    return data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  } catch {
    return "";
  }
}

// 人材プロフィール一覧から質問にマッチする人物を挙げる。
async function peopleSearch(env: Env, dossier: string, question: string): Promise<string> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODELS.normal,
        max_tokens: 1500,
        system:
          "以下は組織メンバーのプロフィール一覧です。質問に対し、該当する人物を理由（スキル/経歴/人脈の根拠）とともに挙げてください。該当者がいなければ『該当者なし』。一覧に無い人物を創作してはいけません。",
        messages: [{ role: "user", content: `プロフィール一覧:\n${dossier}\n\n質問: ${question}` }],
      }),
    });
    if (!r.ok) return "";
    const data = (await r.json()) as { content: Array<{ type: string; text?: string }> };
    return data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  } catch {
    return "";
  }
}

// ファイル名・content-typeから、Geminiが受け付けるMIMEを補正（octet-streamは拡張子で判定）。
function fileMime(name: string | null, ct?: string): string {
  const ext = (name ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (ct && ct !== "application/octet-stream" && (ct.includes("pdf") || ct.startsWith("text/"))) return ct;
  if (ext === "pdf") return "application/pdf";
  if (["txt", "md", "csv", "json"].includes(ext)) return "text/plain";
  return "application/pdf";
}

// Gemini File API にファイルをアップロード（raw・base64なし）→ file_uri を返す。
async function geminiUploadFile(env: Env, buf: ArrayBuffer, mime: string): Promise<string> {
  if (!env.GEMINI_API_KEY) return "";
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${env.GEMINI_API_KEY}&uploadType=media`,
      { method: "POST", headers: { "Content-Type": mime }, body: buf },
    );
    if (!r.ok) {
      console.log(`[gemini-upload] ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return "";
    }
    const data = (await r.json()) as { file?: { uri?: string } };
    return data.file?.uri ?? "";
  } catch (e) {
    console.log(`[gemini-upload] ${(e as Error).message}`);
    return "";
  }
}

// Gemini Files API の resumable upload：本体をストリームで流し、Worker memory(128MB)に全体を載せない。
// Drive経由の大容量ファイル用（簡易uploadの上限・メモリ上限を一段引き上げる）。
async function geminiUploadResumable(env: Env, stream: ReadableStream, mime: string, size: number): Promise<string> {
  if (!env.GEMINI_API_KEY || !size) return "";
  try {
    const start = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(size),
        "X-Goog-Upload-Header-Content-Type": mime,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: "upload" } }),
    });
    const uploadUrl = start.headers.get("x-goog-upload-url");
    if (!start.ok || !uploadUrl) {
      console.log(`[gemini-resumable-start] ${start.status}: ${(await start.text()).slice(0, 200)}`);
      return "";
    }
    const up = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Length": String(size), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
      body: stream,
      // CloudflareはリクエストボディにReadableStreamを許容（要 duplex: half）。
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (!up.ok) {
      console.log(`[gemini-resumable-upload] ${up.status}: ${(await up.text()).slice(0, 200)}`);
      return "";
    }
    const data = (await up.json()) as { file?: { uri?: string } };
    return data.file?.uri ?? "";
  } catch (e) {
    console.log(`[gemini-resumable] ${(e as Error).message}`);
    return "";
  }
}

// 参照(ref)から Gemini Files へアップロードして file_uri を得る。
// drive: は size を取ってストリームで resumable（大容量対応）／それ以外(KV・25MB上限内)はバッファで簡易upload。
async function geminiUploadFromRef(env: Env, ref: string, fallbackMime: string): Promise<string> {
  if (!env.GEMINI_API_KEY) return "";
  if (ref.startsWith("drive:")) {
    const s = await driveGetStream(env, ref.slice(6));
    if (s?.stream && s.size) {
      const uri = await geminiUploadResumable(env, s.stream, s.mime || fallbackMime, s.size);
      if (uri) return uri;
    }
    // ストリーム不可（権限/サイズ不明）ならバッファ経路へフォールバック。
  }
  const obj = await getMedia(env, ref);
  if (!obj) return "";
  return geminiUploadFile(env, obj.buf, obj.mime || fallbackMime);
}

// アップロード済みファイル(file_uri)に対して質問/要約（base64不要・軽量）。
async function geminiByUri(env: Env, fileUri: string, mime: string, question: string): Promise<string> {
  if (!env.GEMINI_API_KEY) return "";
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ file_data: { mime_type: mime, file_uri: fileUri } }, { text: question }] }],
        }),
      },
    );
    if (!r.ok) {
      console.log(`[gemini-uri] ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return "";
    }
    const data = (await r.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  } catch (e) {
    console.log(`[gemini-uri] ${(e as Error).message}`);
    return "";
  }
}

// ファイルをGeminiで読み、質問回答/要約する。
// レビュー反映：base64(btoa)はCPUの主犯なので使わず、Files APIに生upload→file_uri参照（CPUほぼ0）。
async function geminiReadFile(env: Env, buf: ArrayBuffer, mime: string, question: string): Promise<string> {
  if (!env.GEMINI_API_KEY) {
    console.log("[gemini] GEMINI_API_KEY 未設定");
    return "";
  }
  const uri = await geminiUploadFile(env, buf, mime);
  if (!uri) return "";
  return geminiByUri(env, uri, mime, question || "この資料の要点を日本語で詳しくまとめてください。");
}

// キャッシュ済み要約に基づいて質問に答える（document再参照なし・軽量）。
async function answerFrom(env: Env, basis: string, question: string): Promise<string> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODELS.simple,
        max_tokens: 1500,
        system: "以下の資料要約に基づいて質問に答えてください。要約に無い内容は『資料に記載がありません』と述べる。",
        messages: [{ role: "user", content: `資料:\n${basis}\n\n質問: ${question}` }],
      }),
    });
    if (!r.ok) return "";
    const data = (await r.json()) as { content: Array<{ type: string; text?: string }> };
    return data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  } catch {
    return "";
  }
}

// id指定 or 種別の最新で保存物を1件取得。
async function findMedia(env: Env, userId: string, id?: number, kind?: string): Promise<NoteRow | null> {
  if (id) {
    return env.DB.prepare(
      "SELECT id, kind, content, name, done, scope, created_at FROM notes WHERE (user_id = ? OR scope = 'shared') AND id = ?",
    )
      .bind(userId, id)
      .first<NoteRow>();
  }
  const k = kind === "file" ? "file" : kind === "record" ? "record" : "image";
  return env.DB.prepare(
    "SELECT id, kind, content, name, done, scope, created_at FROM notes WHERE (user_id = ? OR scope = 'shared') AND kind = ? ORDER BY id DESC LIMIT 1",
  )
    .bind(userId, k)
    .first<NoteRow>();
}

// save_note / list_notes / get_media を実行（D1＋R2公開URL）。
async function execTool(env: Env, ctx: ExecutionContext, userId: string, name: string, input: ToolInput): Promise<ToolOut> {
  if (name === "save_note") {
    const content = (input.content ?? "").trim();
    if (!content) return { result: "保存内容が空です。" };
    const scope = input.scope === "shared" ? "shared" : "personal";
    await env.DB.prepare(
      "INSERT INTO notes (user_id, kind, content, name, category, doc_date, amount, scope, done, created_at) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 0, ?)",
    )
      .bind(userId, "text", content, null, scope, nowSec())
      .run();
    return { result: `${scope === "shared" ? "組織で共有として" : ""}保存しました：${content}` };
  }
  if (name === "list_notes") {
    const { results } = await env.DB.prepare(
      "SELECT id, kind, content, name, done, scope, status, created_at FROM notes WHERE user_id = ? OR scope = 'shared' ORDER BY id DESC LIMIT 10",
    )
      .bind(userId)
      .all<NoteRow>();
    if (!results.length) return { result: "登録はまだありません。" };
    return { result: results.map(noteLine).join("\n") };
  }
  if (name === "register_link") {
    const u = (input.url ?? "").trim();
    if (!/^https?:\/\//.test(u)) return { result: "有効なURL（https://...）が必要です。" };
    const title = (input.title ?? "リンク").trim();
    const category = (input.category ?? "リンク").trim();
    await env.DB.prepare(
      "INSERT INTO notes (user_id, kind, content, name, category, doc_date, amount, scope, file_id, status, done, created_at) VALUES (?, 'file', ?, ?, ?, NULL, NULL, 'personal', NULL, 'done', 0, ?)",
    )
      .bind(userId, `link:${u}`, title, category, nowSec())
      .run();
    return { result: `「${title}」をリンクとして登録しました。一覧や「${title}を開いて」で参照できます。` };
  }
  if (name === "get_media") {
    const row = await findMedia(env, userId, input.id, input.kind);
    if (!row) return { result: "該当する保存物が見つかりません。" };
    if (row.content.startsWith("link:")) return { result: `${row.name ?? "ファイル"}：${row.content.slice(5)}` };
    if (row.kind === "record") return { result: `${row.name ?? "記録"}\n\n${row.content}` };
    if (!env.PUBLIC_BASE_URL) return { result: "（配信URLが未設定です。管理者にご相談ください）" };
    const url = `${env.PUBLIC_BASE_URL}/media/${encodeURIComponent(row.content)}`;
    if (row.kind === "image") return { result: "画像を表示します。", media: { type: "image", url } };
    return { result: `書類「${row.name ?? "ファイル"}」のダウンロード：${url}` };
  }
  if (name === "delete_note") {
    if (!input.id) return { result: "削除対象の#番号が必要です。" };
    const row = await env.DB.prepare(
      "SELECT id, kind, content, name, done, scope, created_at FROM notes WHERE user_id = ? AND id = ?",
    )
      .bind(userId, input.id)
      .first<NoteRow>();
    if (!row) return { result: "該当が見つかりません。" };
    if (row.kind === "image" || row.kind === "file") await deleteMedia(env, row.content);
    await env.DB.prepare("DELETE FROM notes WHERE user_id = ? AND id = ?").bind(userId, input.id).run();
    return { result: `#${input.id} を削除しました。` };
  }
  if (name === "search_notes") {
    const q = (input.query ?? "").trim();
    if (!q) return { result: "検索語が必要です。" };
    const { results } = await env.DB.prepare(
      "SELECT id, kind, content, name, done, scope, status, created_at FROM notes WHERE (user_id = ? OR scope = 'shared') AND (content LIKE ? OR name LIKE ?) ORDER BY id DESC LIMIT 10",
    )
      .bind(userId, `%${q}%`, `%${q}%`)
      .all<NoteRow>();
    if (!results.length) return { result: `「${q}」に一致する保存はありません。` };
    return { result: results.map(noteLine).join("\n") };
  }
  if (name === "complete_note") {
    if (!input.id) return { result: "完了対象の#番号が必要です。" };
    await env.DB.prepare("UPDATE notes SET done = 1 WHERE user_id = ? AND id = ?").bind(userId, input.id).run();
    return { result: `#${input.id} を完了にしました。` };
  }
  if (name === "set_reminder") {
    const content = (input.content ?? "").trim();
    const at = parseJst(input.remind_at ?? "");
    if (!content || !at) return { result: "内容と時刻（JST）が必要です。" };
    await env.DB.prepare("INSERT INTO reminders (user_id, content, remind_at, done, created_at) VALUES (?, ?, ?, 0, ?)")
      .bind(userId, content, at, nowSec())
      .run();
    return { result: `⏰ リマインダー登録：${fmtJst(at)} に「${content}」` };
  }
  if (name === "list_reminders") {
    const { results } = await env.DB.prepare(
      "SELECT id, content, remind_at FROM reminders WHERE user_id = ? AND done = 0 ORDER BY remind_at ASC LIMIT 10",
    )
      .bind(userId)
      .all<ReminderRow>();
    if (!results.length) return { result: "未通知のリマインダーはありません。" };
    return { result: results.map((r) => `#${r.id} ${fmtJst(r.remind_at)} ${r.content}`).join("\n") };
  }
  if (name === "cancel_reminder") {
    if (!input.id) return { result: "取消対象の#番号が必要です。" };
    await env.DB.prepare("UPDATE reminders SET done = 1 WHERE user_id = ? AND id = ?").bind(userId, input.id).run();
    return { result: `#${input.id} のリマインダーを取り消しました。` };
  }
  if (name === "make_document") {
    const out = await generateDocument(env, userId, input.type ?? "pdf", (input.instruction ?? "").trim());
    return { result: out };
  }
  if (name === "save_profile") {
    const pname = (input.name ?? "").trim();
    const content = (input.content ?? "").trim();
    if (!pname || !content) return { result: "氏名と内容が必要です。" };
    const existing = await env.DB.prepare("SELECT id, content FROM profiles WHERE owner_user_id = ? ORDER BY id DESC LIMIT 1")
      .bind(userId)
      .first<{ id: number; content: string }>();
    if (existing) {
      await env.DB.prepare("UPDATE profiles SET name = ?, content = ?, updated_at = ? WHERE id = ?")
        .bind(pname, `${existing.content}\n${content}`, nowSec(), existing.id)
        .run();
    } else {
      await env.DB.prepare(
        "INSERT INTO profiles (owner_user_id, name, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(userId, pname, content, nowSec(), nowSec())
        .run();
    }
    return { result: `${pname} さんのプロフィールを登録しました。組織の人材検索で参照できます。` };
  }
  if (name === "get_profile") {
    const pname = (input.name ?? "").trim();
    const { results } = await env.DB.prepare(
      "SELECT name, content FROM profiles WHERE name LIKE ? ORDER BY id DESC LIMIT 3",
    )
      .bind(`%${pname}%`)
      .all<{ name: string; content: string }>();
    if (!results.length) return { result: `${pname} さんのプロフィールは登録されていません。` };
    return { result: results.map((p) => `【${p.name}】\n${p.content}`).join("\n\n") };
  }
  if (name === "search_people") {
    const q = (input.query ?? "").trim();
    const { results } = await env.DB.prepare("SELECT name, content FROM profiles ORDER BY id DESC LIMIT 50").all<{
      name: string;
      content: string;
    }>();
    if (!results.length) return { result: "登録されたプロフィールがありません。まず各自のスキル・経歴を登録してください。" };
    const dossier = results
      .map((p) => `■ ${p.name}\n${p.content}`)
      .join("\n\n")
      .slice(0, 12000);
    const ans = await peopleSearch(env, dossier, q);
    return { result: ans || "該当する人物が見つかりませんでした。" };
  }
  if (name === "upload_status") {
    const row = await fileStatus(env, userId, input.id);
    if (!row) return { result: "対象のファイルが見つかりません。" };
    const s =
      row.status === "done"
        ? "✅ 取り込み完了（内容について質問できます）"
        : row.status === "error"
          ? "❌ アップロードに失敗しています。再送してください。"
          : "📥 アップロード中です。もう少しお待ちください。";
    return { result: `「${row.name ?? "ファイル"}」：${s}` };
  }
  if (name === "read_file") {
    const row = await findFile(env, userId, input.id);
    if (row && row.content.startsWith("link:"))
      return { result: `このファイルは外部リンクのため内容参照はできません。リンクを開いてご確認ください：${row.content.slice(5)}` };
    if (row && row.status === "uploading") return { result: "このファイルはまだアップロード中です。少し待ってからお試しください。" };
    if (row && row.status === "error") return { result: "このファイルはアップロードに失敗しています。再送してください。" };
    if (!row) return { result: "参照できるファイルが見つかりません。先にファイルを送ってください。" };
    const q = (input.query ?? "").trim();
    const engine = engineFor(await getMode(env, userId), env);
    // 正確性が重要・特定資料の確認は本文を都度参照（キャッシュを使わない）。secure=Claude(学習なし)/cheap=Gemini。
    if (input.fresh === true) {
      const obj = await getMedia(env, row.content);
      if (!obj) return { result: "ファイル本体が見つかりません。" };
      const mime = fileMime(row.name, obj.mime);
      let ans = "";
      if (engine === "claude") {
        const fid = await uploadToFiles(env, obj.buf, row.name ?? "document.pdf", mime);
        if (fid) ans = await readFile(env, fid, q || "この資料の要点を詳しくまとめてください。");
      } else if (engine === "gemini") {
        ans = await geminiReadFile(env, obj.buf, mime, q || "この資料の要点を詳しくまとめてください。");
      } else {
        return { result: "機密モードでこの資料を読むにはClaude APIキーの設定が必要です。" };
      }
      return { result: ans || "内容を読み取れませんでした（PDF・テキストのみ対応。Word/Excel/PPTはPDF化を）。" };
    }
    // 通常：一度読んだファイルは要約をキャッシュし、PDF再読み込みを避ける。
    const cached = await env.DB.prepare(
      "SELECT content FROM knowledge WHERE source_note_id = ? AND content LIKE '[資料キャッシュ]%' ORDER BY id DESC LIMIT 1",
    )
      .bind(row.id)
      .first<{ content: string }>();
    if (!cached) {
      // 要約が無ければ分割ジョブを作成。Cronがページ範囲ごとに少しずつ処理して完遂する。
      const job = await env.DB.prepare(
        "SELECT id, status, next_page, total_pages FROM summary_jobs WHERE note_id = ? AND status IN ('pending','running') ORDER BY id DESC LIMIT 1",
      )
        .bind(row.id)
        .first<{ id: number; status: string; next_page: number; total_pages: number }>();
      if (job) {
        return { result: `📄 「${row.name ?? "資料"}」を要約作成中です。もう少し待って『要約できた？』で確認してください。` };
      }
      if (engine === "none") {
        return { result: "機密モードでこの資料を読むにはClaude APIキーの設定が必要です。" };
      }
      await env.DB.prepare(
        "INSERT INTO summary_jobs (note_id, user_id, scope, engine, status, next_page, chunk_size, partial, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 1, 3, '', ?, ?)",
      )
        .bind(row.id, userId, row.scope, engine, nowSec(), nowSec())
        .run();
      return {
        result: `📄 「${row.name ?? "資料"}」の要約をバックグラウンドで作成します（毎分少しずつ処理）。完了後『要約できた？』で取得できます。`,
      };
    }
    const basis = cached.content;
    if (!q) return { result: basis.replace(/^\[資料キャッシュ\]\s*/, "") };
    const ans = await answerFrom(env, basis, q);
    return { result: ans || basis.replace(/^\[資料キャッシュ\]\s*/, "") };
  }
  if (name === "query_documents") {
    const cat = (input.category ?? "").trim();
    const from = (input.from ?? "").trim();
    const to = (input.to ?? "").trim();
    const dexpr = "COALESCE(doc_date, strftime('%Y-%m-%d', created_at, 'unixepoch'))";
    const { results } = await env.DB.prepare(
      `SELECT id, name, category, doc_date, amount, scope, created_at FROM notes
       WHERE (user_id = ? OR scope = 'shared') AND kind IN ('image','file','record')
         AND (? = '' OR category LIKE ?)
         AND (? = '' OR ${dexpr} >= ?)
         AND (? = '' OR ${dexpr} <= ?)
       ORDER BY ${dexpr} DESC LIMIT 50`,
    )
      .bind(userId, cat, `%${cat}%`, from, from, to, to)
      .all<DocRow>();
    if (!results.length) return { result: "該当する文書はありません。" };
    return { result: results.map(docLine).join("\n") };
  }
  if (name === "save_record") {
    const title = (input.title ?? "成果物").trim();
    const content = (input.content ?? "").trim();
    if (!content) return { result: "本文が空です。" };
    const category = (input.category ?? "記録").trim();
    const docDate = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : fmtDate(nowSec());
    const scope = input.scope === "shared" ? "shared" : "personal";
    await env.DB.prepare(
      "INSERT INTO notes (user_id, kind, content, name, category, doc_date, amount, scope, done, created_at) VALUES (?, 'record', ?, ?, ?, ?, NULL, ?, 0, ?)",
    )
      .bind(userId, content, title, category, docDate, scope, nowSec())
      .run();
    return { result: `${scope === "shared" ? "組織で共有として" : ""}「${title}」を${category}として保存しました（${docDate}）。` };
  }
  if (name === "share_item") {
    const newScope = input.scope === "personal" ? "personal" : "shared";
    let id = input.id;
    if (!id) {
      const last = await env.DB.prepare("SELECT id FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT 1")
        .bind(userId)
        .first<{ id: number }>();
      id = last?.id;
    }
    if (!id) return { result: "共有する対象が見つかりません。" };
    await env.DB.prepare("UPDATE notes SET scope = ? WHERE user_id = ? AND id = ?").bind(newScope, userId, id).run();
    await env.DB.prepare("UPDATE knowledge SET scope = ? WHERE user_id = ? AND source_note_id = ?")
      .bind(newScope, userId, id)
      .run();
    return { result: newScope === "shared" ? `#${id} を組織全員に共有しました。` : `#${id} の共有を解除しました。` };
  }
  if (name === "save_knowledge") {
    const content = (input.content ?? "").trim();
    if (!content) return { result: "保存内容が空です。" };
    const scope = input.scope === "shared" ? "shared" : "personal";
    await env.DB.prepare(
      "INSERT INTO knowledge (user_id, content, scope, source_note_id, created_at) VALUES (?, ?, ?, NULL, ?)",
    )
      .bind(userId, content, scope, nowSec())
      .run();
    return { result: `${scope === "shared" ? "組織で共有として" : ""}知識として登録しました（${content.length}文字）。` };
  }
  if (name === "search_knowledge") {
    const q = (input.query ?? "").trim();
    if (!q) return { result: "検索語が必要です。" };
    const { results } = await env.DB.prepare(
      "SELECT id, content FROM knowledge WHERE (user_id = ? OR scope = 'shared') AND content LIKE ? ORDER BY id DESC LIMIT 3",
    )
      .bind(userId, `%${q}%`)
      .all<KnowledgeRow>();
    if (!results.length) return { result: `「${q}」に一致する知識はありません。` };
    // 全文ではなく一致箇所周辺だけ返してトークン節約。
    return { result: results.map((r) => `#${r.id} …${snippet(r.content, q)}…`).join("\n\n") };
  }
  return { result: "未対応のツールです。" };
}

// 検索語の周辺だけを切り出す（全文をcontextに載せない）。
function snippet(text: string, query: string): string {
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text.slice(0, 400);
  return text.slice(Math.max(0, i - 150), i + 350);
}

function noteLine(r: NoteRow): string {
  const icon = r.done
    ? "✅"
    : r.kind === "image"
      ? "🖼"
      : r.kind === "file"
        ? "📄"
        : r.kind === "record"
          ? "📋"
          : "📝";
  const label =
    r.kind === "image" ? "画像" : r.kind === "file" || r.kind === "record" ? (r.name ?? "記録") : r.content;
  const st = r.status === "uploading" ? " ⏳取込中" : r.status === "error" ? " ❌失敗" : "";
  return `#${r.id} ${icon} ${label}${st}${r.scope === "shared" ? " 🔗共有" : ""}`;
}

const fmtDate = (epoch: number): string => new Date((epoch + 9 * 3600) * 1000).toISOString().slice(0, 10);

function docLine(r: DocRow): string {
  const d = r.doc_date ?? fmtDate(r.created_at);
  const cat = r.category ? `[${r.category}]` : "";
  const amt = r.amount != null ? ` ¥${r.amount}` : "";
  return `#${r.id} ${d} ${cat}${amt} ${r.name ?? ""}${r.scope === "shared" ? " 🔗" : ""}`.trim();
}

// ツール実行ループ：tool_use が来たら実行→結果を返して再度Claude。最大5周。
async function runAgent(
  env: Env,
  model: string,
  system: string,
  messages: ApiMsg[],
  userId: string,
  ctx: ExecutionContext,
): Promise<{ text: string; searchCount: number; media: MediaItem[]; inTok: number; outTok: number; costJpy: number }> {
  const t0 = Date.now();
  let inTok = 0;
  let outTok = 0;
  let cacheRead = 0;
  let searchCount = 0;
  const media: MediaItem[] = [];
  for (let step = 0; step < 5; step++) {
    const data = await callAnthropic(env, model, system, messages);
    const u = data.usage;
    if (u) {
      inTok += u.input_tokens;
      outTok += u.output_tokens;
      cacheRead += u.cache_read_input_tokens ?? 0;
      searchCount += u.server_tool_use?.web_search_requests ?? 0;
    }
    const toolUses = (data.content ?? []).filter((c) => c.type === "tool_use");
    if (data.stop_reason === "tool_use" && toolUses.length) {
      messages.push({ role: "assistant", content: data.content });
      const toolResults: Array<{ type: string; tool_use_id?: string; content: string }> = [];
      for (const tu of toolUses) {
        const out = await execTool(env, ctx, userId, tu.name ?? "", (tu.input ?? {}) as ToolInput);
        if (out.media) media.push(out.media);
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: out.result });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }
    const p = PRICE[model] ?? { in: 3, out: 15 };
    const usd = (inTok * p.in + outTok * p.out) / 1_000_000;
    const costJpy = usd * USD_JPY;
    console.log(
      `[metrics] model=${model} in=${inTok} cache_read=${cacheRead} out=${outTok} search=${searchCount} ` +
        `latency_ms=${Date.now() - t0} cost_jpy=${costJpy.toFixed(4)}`,
    );
    const text = (data.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("")
      .trim();
    return { text: text || "（応答を生成できませんでした）", searchCount, media, inTok, outTok, costJpy };
  }
  const p = PRICE[model] ?? { in: 3, out: 15 };
  const costJpy = ((inTok * p.in + outTok * p.out) / 1_000_000) * USD_JPY;
  return { text: "（処理が完了しませんでした）", searchCount, media, inTok, outTok, costJpy };
}

// Gemini版のツール実行ループ（function calling）。Claudeキーが無い／simple時に使用＝無料枠で全機能。
async function runAgentGemini(
  env: Env,
  model: string,
  system: string,
  messages: ApiMsg[],
  userId: string,
  ctx: ExecutionContext,
): Promise<{ text: string; searchCount: number; media: MediaItem[]; inTok: number; outTok: number; costJpy: number }> {
  const contents: Array<{ role: string; parts: GeminiPart[] }> = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content) }],
  }));
  const media: MediaItem[] = [];
  let inTok = 0;
  let outTok = 0;
  const t0 = Date.now();
  for (let step = 0; step < 6; step++) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          tools: [{ function_declarations: GEMINI_FUNCTIONS }],
          tool_config: { function_calling_config: { mode: "AUTO" } },
          generationConfig: { maxOutputTokens: 2048 },
        }),
      },
    );
    if (!r.ok) {
      console.log(`[gemini-agent] ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return { text: "（応答の生成に失敗しました）", searchCount: 0, media, inTok, outTok, costJpy: 0 };
    }
    const data = (await r.json()) as GeminiResp;
    inTok += data.usageMetadata?.promptTokenCount ?? 0;
    outTok += data.usageMetadata?.candidatesTokenCount ?? 0;
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const fcs = parts.filter((p) => p.functionCall);
    if (fcs.length) {
      contents.push({ role: "model", parts });
      const respParts: GeminiPart[] = [];
      for (const p of fcs) {
        const fc = p.functionCall as { name: string; args?: Record<string, unknown> };
        const out = await execTool(env, ctx, userId, fc.name, (fc.args ?? {}) as ToolInput);
        if (out.media) media.push(out.media);
        respParts.push({ functionResponse: { name: fc.name, response: { result: out.result } } });
      }
      contents.push({ role: "user", parts: respParts });
      continue;
    }
    const text = parts
      .filter((p) => p.text)
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    console.log(`[metrics] provider=gemini in=${inTok} out=${outTok} latency_ms=${Date.now() - t0}`);
    return { text: text || "（応答を生成できませんでした）", searchCount: 0, media, inTok, outTok, costJpy: 0 };
  }
  return { text: "（処理が完了しませんでした）", searchCount: 0, media, inTok, outTok, costJpy: 0 };
}

async function lineReply(env: Env, replyToken: string, text: string): Promise<void> {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: text.slice(0, 5000) }] }),
  });
}

interface LineEvent {
  type: string;
  webhookEventId?: string; // イベント一意ID（再送でも同一）。重複排除のキー。
  deliveryContext?: { isRedelivery?: boolean };
  replyToken?: string;
  source?: { userId?: string };
  message?: { type: string; text?: string; id?: string; fileName?: string };
}

// Push通知（リマインダー用・replyTokenなしで能動送信）。
async function linePush(env: Env, to: string, text: string): Promise<void> {
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
  });
}

async function lineReplyMessages(env: Env, replyToken: string, messages: unknown[]): Promise<void> {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ replyToken, messages: messages.slice(0, 5) }),
  });
}

// テキスト＋クイックリプライ（タップで該当ラベルがそのまま送信される＝message action）。
async function lineReplyQuick(env: Env, replyToken: string, text: string, labels: string[]): Promise<void> {
  const items = labels.slice(0, 13).map((l) => ({
    type: "action",
    action: { type: "message", label: l.slice(0, 20), text: l },
  }));
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: text.slice(0, 5000), quickReply: { items } }] }),
  });
}

// 会話履歴はD1（書込10万/日）。KV（書込1千/日）より律速が緩い。
async function appendHistory(env: Env, userId: string, role: string, text: string): Promise<void> {
  await env.DB.prepare("INSERT INTO history (user_id, role, text, ts) VALUES (?, ?, ?, ?)")
    .bind(userId, role, text, nowSec())
    .run();
}

async function recentHistory(env: Env, userId: string, limit: number): Promise<{ role: string; text: string }[]> {
  const { results } = await env.DB.prepare("SELECT role, text FROM history WHERE user_id = ? ORDER BY id DESC LIMIT ?")
    .bind(userId, limit)
    .all<{ role: string; text: string }>();
  return results.reverse(); // 古い順に戻す
}

// 処理方針：cheap=安さ優先(Gemini無料・学習あり) / secure=機微・精度優先(Claude課金・学習なし)。既定はcheap。
type Mode = "cheap" | "secure";
// 抽出エンジン：gemini=無料OCR/要約 / claude=学習なしOCR/要約 / none=抽出せず保管のみ(secureでClaude鍵が無いとき)。
type Engine = "gemini" | "claude" | "none";
function engineFor(mode: Mode, env: Env): Engine {
  if (mode === "secure") return env.ANTHROPIC_API_KEY ? "claude" : "none";
  return "gemini";
}
async function getMode(env: Env, userId: string): Promise<Mode> {
  const v = await env.HISTORY.get(KV_MODE(userId));
  return v === "secure" ? "secure" : "cheap";
}
async function setMode(env: Env, userId: string, m: Mode): Promise<void> {
  await env.HISTORY.put(KV_MODE(userId), m);
}

// 重要情報の判定はGeminiに本文を渡さずローカルで（正規表現＋メディア種別）。
const SENSITIVE_RE =
  /(領収書|請求書|レシート|見積|契約|締結|口座|振込|送金|マイナンバー|個人番号|住所|電話番号|生年月日|パスワード|機密|社外秘|極秘|給与|給料|報酬|年収|診断|カルテ|病歴|履歴書|名簿|顧客|氏名|印鑑|¥|円|万円)/;
function looksSensitive(text: string, kind: "text" | "audio" | "image" | "file"): boolean {
  if (kind === "image" || kind === "file") return true; // 中身が不明なメディアは常に重要候補（Geminiに送る前に確認）
  return SENSITIVE_RE.test(text);
}

// KVの署名済みリースを検証して取得。未設定なら null（＝既定で稼働）。
// 署名検証つきで lease を取り出す。未発行・改ざん・鍵不一致・壊れKV はすべて null（＝無効）として扱う（throwしない）。
async function currentLease(env: Env): Promise<LeasePayload | null> {
  const raw = await env.HISTORY.get(KV_LEASE);
  if (!raw) return null;
  try {
    return await openLease(verifyJwkOf(env), JSON.parse(raw) as Envelope);
  } catch {
    return null;
  }
}

// 署名検証つきで config を取り出す（strict）。未発行・改ざん・鍵不一致は null（＝当社署名なし）。
// 既定フォールバックはしない：configも認証ゲートの対象（fail-closed）。
async function currentConfig(env: Env): Promise<ConfigPayload | null> {
  const raw = await env.HISTORY.get(KV_CONFIG);
  if (!raw) return null;
  try {
    return await openConfig(verifyJwkOf(env), JSON.parse(raw) as Envelope);
  } catch {
    return null;
  }
}

// 開発バイパス：DEV_USER_IDS（カンマ区切り）に載るアカウントだけ認証を飛ばす。本番は空＝全員ゲート対象。
const devAccounts = (env: Env): string[] =>
  (env.DEV_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const isDevAccount = (env: Env, userId: string): boolean => devAccounts(env).includes(userId);

const MSG_UNAUTHORIZED =
  "この環境はまだ提供元の承認を受けていないため、現在ご利用いただけません。承認後に自動で利用可能になります。";
const MSG_EXPIRED =
  "ご契約の有効期限が切れているため、現在ご利用を停止しています。更新後に自動で再開します（これまでのデータは保持しています）。";

type AuthResult = { ok: true; config: ConfigPayload; dev: boolean } | { ok: false; message: string };

// クライアント認証ゲート（fail-closed）：開発アカウントはバイパス、それ以外は
// 「有効な署名付き lease かつ 署名付き config」の両方が揃って初めて動作を許可する。
async function authorize(env: Env, userId: string): Promise<AuthResult> {
  // 開発バイパス：認証を飛ばす。configは当社発行があれば使い、無ければ既定v1で動かす。
  if (isDevAccount(env, userId)) {
    return { ok: true, config: (await currentConfig(env)) ?? CONFIGS.v1, dev: true };
  }
  // 本番：lease（契約）＋ config（人格/機能）の両方が当社署名で有効であること。
  const lease = await currentLease(env);
  if (!lease) return { ok: false, message: MSG_UNAUTHORIZED }; // 未発行・改ざん・偽造
  if (env.TENANT_ID && lease.tenant !== env.TENANT_ID) return { ok: false, message: MSG_UNAUTHORIZED }; // 別テナント宛の誤配信/横流し
  if (!licensed(lease, nowSec())) return { ok: false, message: MSG_EXPIRED }; // 期限切れ・停止
  const config = await currentConfig(env);
  if (!config) return { ok: false, message: MSG_UNAUTHORIZED }; // config未発行・改ざん
  return { ok: true, config, dev: false };
}

const KIND_LABEL: Record<string, string> = { plugin: "プラグイン", skill: "Agent Skill", api: "API", builtin: "内蔵" };

// エージェントとしての自己認識＋保有機能の把握。
const SELF_AWARENESS =
  "[あなたについて] あなたはLINE上で動く自律型AIエージェントです。単なるチャットボットではなく、以下の機能を自分の道具として持ち、依頼に応じて適切なツールを選んで実行します。自分が何をできるかを常に把握し、「何ができる？」と聞かれたら分かりやすく説明してください。実現できない依頼は正直に伝え、必要なら拡張方法（API/プラグイン追加）を案内します。\n" +
  "・会話、Web検索、難易度に応じたモデル自動切替\n" +
  "・メモ/タスク管理（保存・一覧・検索・削除・完了）\n" +
  "・リマインダー（指定時刻にLINEへ通知）\n" +
  "・画像の保存とOCR（領収書等の読み取り）、文書ファイル（PDF/Word/Excel/PowerPoint/テキスト）の内容取り込み\n" +
  "・文書の分類と期間検索（例『6月の領収書をまとめて』）\n" +
  "・資料・スライド生成（PowerPoint/PDF/Excel/Word）、議事録の作成\n" +
  "・音声入力の文字起こし（話者分離）と議事録化\n" +
  "・取り込んだファイル（PDF/テキスト）の内容を参照して回答（read_file・登録資料を根拠に回答）\n" +
  "・知識の保存と検索（save_knowledge/search_knowledge）\n" +
  "・組織での共有（個人/共有スコープ）\n" +
  "・人材ディレクトリ（メンバーの経歴・スキル・人脈の登録と横断検索＝『◯◯さんのスキル』『これができる人は？』『△△の人脈ある人は？』）";

// 人格 + 能力レジストリ をシステムプロンプトに合成（5-2bのオーケストレーション案内）。
function buildSystem(config: ConfigPayload): string {
  const caps = config.capabilities ?? BASE_CAPS; // 旧形式configがKVに残っていても落ちない
  const builtin = caps.filter((c) => c.kind === "builtin" && c.enabled).map((c) => c.label);
  const connected = caps.filter((c) => c.kind !== "builtin" && c.enabled).map((c) => c.label);
  const unset = caps.filter((c) => !c.enabled);

  let s = `${config.persona.system}\n\n${SELF_AWARENESS}\n\n`;
  if (builtin.length) {
    s += `[追加費用なしで実行できる処理] ${builtin.join("、")}。外部API不要のため、該当する依頼はそのまま実行してください。\n`;
  }
  if (connected.length) {
    s += `[接続済みの拡張能力] ${connected.join("、")}。\n`;
  }
  if (unset.length) {
    s +=
      `[未設定の能力] ` +
      unset.map((c) => `${c.label}（${KIND_LABEL[c.kind]}・要：${c.needs}）`).join("／") +
      `。これらが必要な依頼は、実行を装わず、必要な追加（Agent Skill有効化／外部APIのBYOK／プラグイン有効化）を簡潔に案内し、管理者への相談を促してください。`;
  }
  s += `\n\n[現在日時(JST)] ${fmtJst(nowSec())}。リマインダーの時刻はこの日時を基準に計算してください。`;
  s +=
    `\n\n[記憶の自律管理] あなたは自分の長期記憶を管理します。会話で今後役立つ情報（ユーザーの名前・所属・好み・定期的な予定・重要な決定）が出たら、明示の指示がなくても save_note（短い事実）または save_knowledge（長い参照情報）で控えめに記録してください。回答前に必要に応じて list_notes / search_notes / search_knowledge で過去の記録を確認し、一貫性を保ってください。ただし些末な雑談は記録しないこと。`;
  s +=
    `\n\n[人材ディレクトリ] ユーザーが自分（または誰か）のスキル・経歴・人脈を伝えたら save_profile で登録してください（氏名を確認する）。履歴書・経歴書PDFを取り込んだ場合もread_fileで読み取りsave_profileに登録できます。『◯◯さんのスキル/経歴を教えて』は get_profile、『これができる人いる？』『△△の人脈を持つ人は？』『◯◯さんのスキルでこれは可能？』などは search_people を使って実在のプロフィールに基づいて答えてください（人物を創作しない）。`;
  s +=
    `\n\n[組織共有] この公式アカウントは1つの組織です。データには「個人(personal)」と「組織共有(shared)」があり、共有にしたものは組織の全員が参照できます。保存する内容が組織全員に役立つ（共有の連絡事項・議事録・共通マニュアル・経費領収書など）と判断したら、保存時に「これは皆さんと共有しますか？」と一度確認してから scope を決めてください。ユーザーが「共有して」と言えば scope='shared' で保存、または既存のものは share_item で共有します。個人的な内容は personal のままにします。`;
  s +=
    `\n\n[資料の確認] ユーザーから質問・依頼が来たら、毎回まず関連する保存資料・ファイル・知識があるか search_knowledge / query_documents / read_file で確認してから答えてください。手元の資料に根拠があればそれを優先します。`;
  s +=
    `\n\n[ファイル参照] 取り込んだファイル（PDF・テキスト）の内容について聞かれたら read_file で参照して答えてください（取り込み時は中身を読まず保存だけしてあり、質問時に読みます）。` +
    `一度読んだ資料は要約がキャッシュされ、一般的・概要の質問は要約で軽く答えます。ただし、特定の資料について詳しく聞かれた場合、数値・契約条件・固有名詞など正確性が回答に影響する場合は、間違いを避けるため read_file を fresh=true で本文を都度確認してください。` +
    `『取り込めた？』『アップロードできた？』などの進捗確認には upload_status で状況（アップロード中/完了/失敗）を確認して答えてください。` +
    `Word/Excel/PowerPointは内容参照に未対応のため、必要ならPDF化を案内します。` +
    `ユーザーがGoogle Driveなどの共有URL（https://...）を送ってきたら register_link で登録してください（大容量ファイルはエージェント保存せずリンクで扱います）。`;
  s +=
    `\n\n[成果物の保存] 議事録・要約・レポート等のテキスト成果物を作ったら save_record で分類(category)付きで保存し、メモ・画像・文書と同じく一覧・検索・期間絞り込み・共有の対象にしてください。PDF/PPT/Excelファイルが要るなら make_document。これらの生成物も組織共有の対象です。`;
  s +=
    `\n\n[音声] 「（音声の文字起こし）」で始まる発話が届いたら、内容が短い指示・依頼ならそのまま実行してください。会議・打合せの録音のように複数話者の長い記録なら、議事録としてsave_record（category=議事録・話者の区別を保持・日付を付ける）するか「議事録として保存しますか？」と確認してください。`;
  s +=
    `\n\n[重要] メモ/タスクの保存・一覧・検索・削除・完了、画像/書類/記録の保存と呼び出し、リマインダーの登録・一覧・取消、成果物の保存・共有の依頼には、必ず対応するツールを実行し、実際のデータで応答してください。会話履歴や記憶だけで「ない」と判断してはいけません。`;
  return s;
}

const VISION_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

type ImageMeta = { doc: boolean; summary: string; text: string; category: string; date: string; amount: number | null };

const IMAGE_EXTRACT_PROMPT =
  "画像を分類して抽出する。領収書・請求書・書類・名刺・スクショ・テキストなど文字主体なら document、通常の写真・風景・人物・物なら photo。" +
  'JSONのみで返答: {"type":"document|photo",' +
  '"category":"分類（領収書/請求書/レシート/名刺/メモ/スクショ/写真 など）",' +
  '"summary":"日本語で短い説明（領収書なら店名と金額）",' +
  '"text":"文書なら本文を全文抽出・写真なら空文字",' +
  '"date":"文書内の日付 YYYY-MM-DD（無ければ空文字）",' +
  '"amount":金額の数値（領収書等・無ければ null）}';

function parseImageMeta(raw: string): ImageMeta {
  const fallback: ImageMeta = { doc: false, summary: "", text: "", category: "写真", date: "", amount: null };
  if (!raw) return fallback;
  try {
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as {
      type?: string;
      category?: string;
      summary?: string;
      text?: string;
      date?: string;
      amount?: number | null;
    };
    const doc = j.type === "document";
    return {
      doc,
      summary: String(j.summary ?? ""),
      text: String(j.text ?? ""),
      category: String(j.category ?? (doc ? "文書" : "写真")),
      date: typeof j.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(j.date) ? j.date : "",
      amount: typeof j.amount === "number" ? j.amount : null,
    };
  } catch {
    return fallback;
  }
}

// Vision（Gemini・無料）：base64廃止でFiles APIに生upload→file_uri参照（CPU回避）。
async function analyzeImage(env: Env, buf: ArrayBuffer, mime: string): Promise<ImageMeta> {
  if (!env.GEMINI_API_KEY) return parseImageMeta("");
  const media_type = VISION_TYPES.includes(mime) ? mime : "image/jpeg";
  const uri = await geminiUploadFile(env, buf, media_type);
  if (!uri) return parseImageMeta("");
  const raw = await geminiByUri(env, uri, media_type, IMAGE_EXTRACT_PROMPT);
  return parseImageMeta(raw);
}

// Vision（Claude・学習なし）：base64を使わずURL方式（/media配信URL）でClaudeに読ませる（CPU回避）。
async function analyzeImageClaude(env: Env, imageUrl: string): Promise<ImageMeta> {
  if (!env.ANTHROPIC_API_KEY) return parseImageMeta("");
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODELS.simple,
        max_tokens: 1500,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "url", url: imageUrl } },
              { type: "text", text: IMAGE_EXTRACT_PROMPT },
            ],
          },
        ],
      }),
    });
    if (!r.ok) return parseImageMeta("");
    const data = (await r.json()) as { content: Array<{ type: string; text?: string }> };
    const raw = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return parseImageMeta(raw);
  } catch {
    return parseImageMeta("");
  }
}

// 音声 → Geminiで文字起こし（話者分離込み）。長尺はinline不可なので上限を設ける。
async function transcribeAudio(env: Env, messageId: string): Promise<string> {
  if (!env.GEMINI_API_KEY) return "";
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) return "";
  const buf = await res.arrayBuffer();
  const mime = res.headers.get("content-type") || "audio/mp4";
  // base64廃止：Files APIに生upload→file_uri参照（CPU回避）。
  const uri = await geminiUploadFile(env, buf, mime);
  if (!uri) return "";
  return geminiByUri(
    env,
    uri,
    mime,
    "この音声を日本語で文字起こししてください。複数の話者がいれば「話者A」「話者B」のように区別。要約や解説は付けず、発話内容のみを出力。",
  );
}

// ファイルをAnthropic Files APIにアップロード → file_id（大きいファイルに強い・最大500MB）。
async function uploadToFiles(env: Env, buf: ArrayBuffer, fileName: string, mime: string): Promise<string> {
  try {
    const form = new FormData();
    form.append("file", new Blob([buf], { type: mime }), fileName || "file");
    const up = await fetch("https://api.anthropic.com/v1/files", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "files-api-2025-04-14",
      },
      body: form,
    });
    if (!up.ok) return "";
    return ((await up.json()) as { id?: string }).id ?? "";
  } catch {
    return "";
  }
}

// PDFを Files API + document block で本文抽出（base64 inlineより大ファイルに強い）。
async function claudePdfExtract(env: Env, buf: ArrayBuffer, fileName: string, mime: string): Promise<string> {
  const fid = await uploadToFiles(env, buf, fileName || "document.pdf", mime || "application/pdf");
  if (!fid) return "";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "files-api-2025-04-14",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODELS.normal,
        max_tokens: 32000,
        messages: [
          {
            role: "user",
            content: [
              { type: "document", source: { type: "file", file_id: fid } },
              { type: "text", text: "このPDFの本文を全てテキストで抽出してください。要約せず内容のみ。表は簡潔に整形。" },
            ],
          },
        ],
      }),
    });
    if (!r.ok) return "";
    const data = (await r.json()) as { content: Array<{ type: string; text?: string }> };
    return data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("")
      .slice(0, 200000);
  } catch {
    return "";
  }
}

// Office（docx/xlsx/pptx）を Files API + code execution + Agent Skills で本文抽出。
async function officeExtract(env: Env, ext: string, fileName: string, mime: string, buf: ArrayBuffer): Promise<string> {
  try {
    const fid = await uploadToFiles(env, buf, fileName, mime);
    if (!fid) return "";
    const skill = ext === "xlsx" ? "xlsx" : ext === "pptx" ? "pptx" : "docx";
    const messages: ApiMsg[] = [
      {
        role: "user",
        content: [
          { type: "container_upload", file_id: fid },
          { type: "text", text: "アップロードされたファイルの全テキスト内容を抽出して出力してください。要約はせず本文のみ。" },
        ],
      },
    ];
    let resp: AnthropicResp | null = null;
    for (let i = 0; i < 8; i++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "code-execution-2025-08-25,skills-2025-10-02,files-api-2025-04-14",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          container: { skills: [{ type: "anthropic", skill_id: skill, version: "latest" }] },
          tools: [{ type: "code_execution_20250825", name: "code_execution" }],
          messages,
        }),
      });
      if (!r.ok) return "";
      resp = (await r.json()) as AnthropicResp;
      if (resp.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: resp.content });
    }
    return (resp?.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("")
      .slice(0, 200000);
  } catch {
    return "";
  }
}

// 形式に応じてファイル本文を抽出。
async function extractFileText(env: Env, mime: string, fileName: string, buf: ArrayBuffer): Promise<string> {
  const ext = (fileName.split(".").pop() ?? "").toLowerCase();
  if (mime.startsWith("text/") || ["txt", "md", "csv", "json"].includes(ext)) {
    try {
      return new TextDecoder().decode(buf).slice(0, 200000);
    } catch {
      return "";
    }
  }
  if (mime === "application/pdf" || ext === "pdf") return claudePdfExtract(env, buf, fileName, mime);
  if (["docx", "xlsx", "pptx"].includes(ext)) return officeExtract(env, ext, fileName, mime, buf);
  return "";
}

// 抽出本文から分類とタイトルを判定（Haiku）。
async function classifyDoc(env: Env, text: string): Promise<{ category: string; summary: string }> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODELS.simple,
        max_tokens: 200,
        system:
          '文書を分類する。JSONのみ返答: {"category":"事業計画/契約書/議事録/請求書/領収書/マニュアル/レポート/その他","summary":"日本語で短いタイトル"}',
        messages: [{ role: "user", content: text.slice(0, 4000) }],
      }),
    });
    if (!r.ok) return { category: "書類", summary: "" };
    const data = (await r.json()) as { content: Array<{ type: string; text?: string }> };
    const raw = data.content.find((c) => c.type === "text")?.text ?? "";
    const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as { category?: string; summary?: string };
    return { category: String(j.category ?? "書類"), summary: String(j.summary ?? "") };
  } catch {
    return { category: "書類", summary: "" };
  }
}

// === ストレージ抽象化：25MB超はGoogle Drive、25MB以下はKV ===
const KV_LIMIT = 25 * 1024 * 1024;

async function driveAccessToken(env: Env): Promise<string> {
  const refresh = await env.HISTORY.get("drive_refresh_token");
  if (!refresh || !env.GOOGLE_CLIENT_ID) return "";
  try {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: refresh,
        grant_type: "refresh_token",
      }),
    });
    if (!r.ok) {
      console.log(`[drive-token] ${r.status}: ${(await r.text()).slice(0, 150)}`);
      return "";
    }
    return ((await r.json()) as { access_token?: string }).access_token ?? "";
  } catch {
    return "";
  }
}

async function driveConfigured(env: Env): Promise<boolean> {
  return !!env.GOOGLE_CLIENT_ID && !!(await env.HISTORY.get("drive_refresh_token"));
}

async function driveUpload(env: Env, buf: ArrayBuffer, mime: string): Promise<string> {
  const token = await driveAccessToken(env);
  if (!token) return "";
  try {
    const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=media", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": mime },
      body: buf,
    });
    if (!r.ok) {
      console.log(`[drive-upload] ${r.status}: ${(await r.text()).slice(0, 150)}`);
      return "";
    }
    return ((await r.json()) as { id?: string }).id ?? "";
  } catch {
    return "";
  }
}

// 大容量：res.body をそのままDriveへ流す（メモリに全部載せない）。25MB超のファイルに使う。
async function driveUploadStream(env: Env, stream: ReadableStream, mime: string, size: number): Promise<string> {
  const token = await driveAccessToken(env);
  if (!token) return "";
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": mime };
    if (size > 0) headers["content-length"] = String(size);
    const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=media", {
      method: "POST",
      headers,
      body: stream,
    });
    if (!r.ok) {
      console.log(`[drive-stream] ${r.status}: ${(await r.text()).slice(0, 150)}`);
      return "";
    }
    return ((await r.json()) as { id?: string }).id ?? "";
  } catch (e) {
    console.log(`[drive-stream] ${(e as Error).message}`);
    return "";
  }
}

// 本体をメモリに載せず ReadableStream で取り出す（size/mime はメタから）。大容量の resumable upload 用。
async function driveGetStream(env: Env, fileId: string): Promise<{ stream: ReadableStream; mime: string; size: number } | null> {
  const token = await driveAccessToken(env);
  if (!token) return null;
  try {
    const meta = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=size,mimeType`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!meta.ok) return null;
    const m = (await meta.json()) as { size?: string; mimeType?: string };
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok || !r.body) return null;
    return {
      stream: r.body,
      mime: m.mimeType ?? r.headers.get("content-type") ?? "application/octet-stream",
      size: Number(m.size ?? r.headers.get("content-length") ?? 0),
    };
  } catch {
    return null;
  }
}

async function driveGet(env: Env, fileId: string): Promise<{ buf: ArrayBuffer; mime: string } | null> {
  const token = await driveAccessToken(env);
  if (!token) return null;
  try {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    return { buf: await r.arrayBuffer(), mime: r.headers.get("content-type") ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

// 保存：Paid=R2があれば優先。無料は25MB以下をKVに据え置き（Driveへの自動移行はしない）。
// 参照: "r2:<key>"＝R2(Paid) / "drive:<id>"＝Drive(大容量) / "<key>"＝KV(無料) / "link:<url>"＝外部リンク。
async function putMedia(env: Env, key: string, buf: ArrayBuffer, mime: string): Promise<string> {
  if (env.MEDIA_R2) {
    await env.MEDIA_R2.put(key, buf, { httpMetadata: { contentType: mime } });
    return `r2:${key}`;
  }
  if (buf.byteLength > KV_LIMIT) return ""; // KV不可サイズ（大容量はsaveMedia側でDrive/案内）
  await env.MEDIA.put(key, buf, { metadata: { contentType: mime } });
  return key;
}

const kvKeyOf = (ref: string): string => (ref.startsWith("kvtmp:") ? ref.slice(6) : ref);

// 取得：参照(ref)から本体を取り出す（R2 / Drive / KV）。
async function getMedia(env: Env, ref: string): Promise<{ buf: ArrayBuffer; mime: string } | null> {
  if (ref.startsWith("r2:")) {
    if (!env.MEDIA_R2) return null;
    const obj = await env.MEDIA_R2.get(ref.slice(3));
    if (!obj) return null;
    return { buf: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType ?? "application/octet-stream" };
  }
  if (ref.startsWith("drive:")) return driveGet(env, ref.slice(6));
  const obj = await env.MEDIA.getWithMetadata<{ contentType?: string }>(kvKeyOf(ref), { type: "arrayBuffer" });
  if (!obj.value) return null;
  return { buf: obj.value, mime: obj.metadata?.contentType ?? "application/octet-stream" };
}

async function deleteMedia(env: Env, ref: string): Promise<void> {
  if (ref.startsWith("r2:")) {
    await env.MEDIA_R2?.delete(ref.slice(3));
    return;
  }
  if (ref.startsWith("drive:")) {
    const token = await driveAccessToken(env);
    if (token)
      await fetch(`https://www.googleapis.com/drive/v3/files/${ref.slice(6)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
    return;
  }
  await env.MEDIA.delete(kvKeyOf(ref));
}

// LINEの画像/書類 → 保存（KV/Drive）し、D1に参照を記録。画像は文書ならVisionでOCR、ファイルは自動要約ジョブ。
const UPLOAD_TIMEOUT_MS = 15000; // 無料枠のwaitUntil制限内に必ずreplyを返すため短め。これ以内＝「完了」、超＝「アップロード中」

async function saveMedia(
  env: Env,
  ctx: ExecutionContext,
  replyToken: string,
  userId: string,
  messageId: string,
  kind: "image" | "file",
  fileName?: string,
  engine: Engine = "gemini", // gemini=無料で抽出 / claude=学習なしで抽出 / none=抽出せず保管のみ
): Promise<void> {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) {
    await lineReply(env, replyToken, "ファイルの取得に失敗しました。");
    return;
  }
  const contentType = res.headers.get("content-type") ?? (kind === "image" ? "image/jpeg" : "application/octet-stream");
  const size = Number(res.headers.get("content-length") ?? "0");
  // 大容量ファイル(25MB超)：KVもメモリも不可。
  if (kind === "file" && size > KV_LIMIT) {
    const mb = Math.round(size / 1048576);
    // R2あり（Paid）→ ストリーミングでR2に直接保存（CF内・メモリ回避・最も簡単）。
    if (env.MEDIA_R2 && res.body) {
      const k2 = `media/${userId}/${messageId}`;
      await env.MEDIA_R2.put(k2, res.body, { httpMetadata: { contentType } });
      await env.DB.prepare(
        "INSERT INTO notes (user_id, kind, content, name, category, doc_date, amount, scope, file_id, status, done, created_at) VALUES (?, 'file', ?, ?, '書類', NULL, NULL, 'personal', NULL, 'done', 0, ?)",
      )
        .bind(userId, `r2:${k2}`, fileName ?? "ファイル", nowSec())
        .run();
      await lineReply(env, replyToken, `✅ 「${fileName ?? "ファイル"}」を保存しました（約${mb}MB・R2）。`);
      return;
    }
    // Drive連携あり（無料の大容量希望者）→ 即reply→裏でストリーミングDrive保存。
    if ((await driveConfigured(env)) && res.body) {
      const ins = await env.DB.prepare(
        "INSERT INTO notes (user_id, kind, content, name, category, doc_date, amount, scope, file_id, status, done, created_at) VALUES (?, 'file', 'uploading', ?, '書類', NULL, NULL, 'personal', NULL, 'uploading', 0, ?)",
      )
        .bind(userId, fileName ?? "ファイル", nowSec())
        .run();
      const noteId = ins.meta.last_row_id;
      const body = res.body;
      ctx.waitUntil(
        (async () => {
          const id = await driveUploadStream(env, body, contentType, size);
          if (id) await env.DB.prepare("UPDATE notes SET content = ?, status = 'done' WHERE id = ?").bind(`drive:${id}`, noteId).run();
          else await env.DB.prepare("UPDATE notes SET status = 'error' WHERE id = ?").bind(noteId).run();
        })(),
      );
      await lineReply(env, replyToken, `📥 大容量ファイル（約${mb}MB）をDriveにアップロード中です。完了後『取り込めた？』で確認してください。`);
      return;
    }
    // R2もDrive連携も無い → 選択肢を案内。
    await lineReply(
      env,
      replyToken,
      `📦 大容量ファイル（約${mb}MB）はそのままでは保存できません。次のいずれかでどうぞ：\n` +
        `①無料で扱う：Googleドライブ連携（ブラウザで /oauth/start を開く）→ 以降はエージェント経由でDriveへ\n` +
        `②Googleドライブに直接アップ→共有リンクをこのトークに送る（自動登録）\n` +
        `③しっかり使う：Workers Paid（月$5）でR2を有効化`,
    );
    return;
  }
  const buf = await res.arrayBuffer();
  const key = `media/${userId}/${messageId}`;
  const ref = await putMedia(env, key, buf, contentType);
  if (!ref) {
    await lineReply(env, replyToken, "保存に失敗しました（25MB超を保存するにはGoogle Drive連携が必要です。/oauth/start で連携できます）。");
    return;
  }
  const kb = Math.round(buf.byteLength / 1024);

  if (kind === "file") {
    // まず status='uploading' で記録（進捗確認できるように）。
    const ins = await env.DB.prepare(
      "INSERT INTO notes (user_id, kind, content, name, category, doc_date, amount, scope, file_id, status, done, created_at) VALUES (?, 'file', ?, ?, '書類', NULL, NULL, 'personal', NULL, 'uploading', 0, ?)",
    )
      .bind(userId, ref, fileName ?? "ファイル", nowSec())
      .run();
    const noteId = ins.meta.last_row_id;
    // 取り込み＝R2保存（済）＋status=done。PDF/テキストは取り込み時に自動で要約ジョブを起動（聞かれる前に裏で抽出）。
    const work = (async (): Promise<boolean> => {
      try {
        await env.DB.prepare("UPDATE notes SET status = 'done' WHERE id = ?").bind(noteId).run();
        const ext = (fileName ?? "").split(".").pop()?.toLowerCase() ?? "";
        if (engine !== "none" && ["pdf", "txt", "md", "csv"].includes(ext)) {
          await env.DB.prepare(
            "INSERT INTO summary_jobs (note_id, user_id, scope, engine, status, next_page, chunk_size, partial, created_at, updated_at) VALUES (?, ?, 'personal', ?, 'pending', 1, 3, '', ?, ?)",
          )
            .bind(noteId, userId, engine, nowSec(), nowSec())
            .run();
        }
        return true;
      } catch {
        await env.DB.prepare("UPDATE notes SET status = 'error' WHERE id = ?").bind(noteId).run();
        return false;
      }
    })();
    const result = await Promise.race([
      work,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), UPLOAD_TIMEOUT_MS)),
    ]);
    if (result === true) {
      await appendHistory(env, userId, "user", `（ファイルを送信しました：${fileName ?? "ファイル"}）`);
      await lineReply(env, replyToken, `✅ 「${fileName ?? "ファイル"}」を取り込みました。内容について質問できます。`);
    } else if (result === false) {
      await lineReply(env, replyToken, `❌ 「${fileName ?? "ファイル"}」のアップロードに失敗しました。お手数ですが再送してください。`);
    } else {
      ctx.waitUntil(work); // 裏で継続
      await appendHistory(env, userId, "user", `（ファイルを送信しました：${fileName ?? "ファイル"}）`);
      await lineReply(
        env,
        replyToken,
        `📥 「${fileName ?? "ファイル"}」をアップロード中です。少し待ってから『取り込めた？』と聞いてください。`,
      );
    }
    return;
  }

  // 画像：engine=noneなら抽出せず保管のみ（secureでClaude鍵が無いとき）。
  if (engine === "none") {
    await env.DB.prepare(
      "INSERT INTO notes (user_id, kind, content, name, category, doc_date, amount, scope, done, created_at) VALUES (?, 'image', ?, '機密画像（未解析）', '写真', NULL, NULL, 'personal', 0, ?)",
    )
      .bind(userId, ref, nowSec())
      .run();
    await appendHistory(env, userId, "user", "（画像を機密として保管しました・未解析）");
    await lineReply(
      env,
      replyToken,
      "🔒 画像を機密として保管しました（OCRせず＝Geminiに送っていません）。内容について聞きたいときはテキストで指示してください。",
    );
    return;
  }
  // 画像：受け取りを即返し、OCRは裏で（完了通知はせず、ユーザー確認時に答える）。
  await lineReply(
    env,
    replyToken,
    engine === "claude"
      ? "📥 画像を受け取りました。Claude（学習なし）で解析して保存します（『さっきの画像は？』で確認できます）。"
      : "📥 画像を受け取りました。解析して保存します（『さっきの画像は？』で確認できます）。",
  );

  {
    const a =
      engine === "claude"
        ? await analyzeImageClaude(env, `${env.PUBLIC_BASE_URL}/media/${encodeURIComponent(ref)}`)
        : await analyzeImage(env, buf, contentType);
    const label = a.summary || (a.doc ? "文書" : null);
    const docDate = a.date || null;
    const noteRes = await env.DB.prepare(
      "INSERT INTO notes (user_id, kind, content, name, category, doc_date, amount, scope, done, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'personal', 0, ?)",
    )
      .bind(userId, "image", ref, label, a.category, docDate, a.amount, nowSec())
      .run();
    if (a.doc && a.text) {
      // OCR本文は knowledge に保存（共有連動のため source_note_id を紐付け）
      await env.DB.prepare(
        "INSERT INTO knowledge (user_id, content, scope, source_note_id, created_at) VALUES (?, ?, 'personal', ?, ?)",
      )
        .bind(userId, `[画像OCR] ${label}\n${a.text}`, noteRes.meta.last_row_id, nowSec())
        .run();
    }
    // 会話文脈に痕跡を残す（「さっきの画像」が繋がるように）。
    await appendHistory(
      env,
      userId,
      "user",
      `（画像を送信しました：${label ?? a.category}${a.amount ? "・" + a.amount + "円" : ""}）`,
    );
    // 完了通知はpushしない（ユーザーが「さっきの画像は？」等で確認したらreplyで答える）。
  }
}

// === 重要情報の確認フロー（cheapモードのみ・Geminiに送る前に尋ねる） ===
type Pending = { kind: "image" | "file" | "audio" | "text"; messageId?: string; fileName?: string; text?: string };
async function savePending(env: Env, userId: string, p: Pending): Promise<void> {
  await env.HISTORY.put(KV_PENDING(userId), JSON.stringify(p), { expirationTtl: 600 });
}
async function readPending(env: Env, userId: string): Promise<Pending | null> {
  const raw = await env.HISTORY.get(KV_PENDING(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Pending;
  } catch {
    return null;
  }
}
const ASK_CLAUDE = "🔒 機密=Claudeで";
const ASK_GEMINI = "💰 このままGeminiで";
const ASK_NOASK = "今後は確認しない";
async function askSensitive(env: Env, replyToken: string, what: string): Promise<void> {
  await lineReplyQuick(
    env,
    replyToken,
    `⚠️ ${what}には重要な情報が含まれるかもしれません。どちらで処理しますか？\n🔒 Claude＝学習に使われない・高精度（課金）\n💰 Gemini＝無料だが学習に使われる可能性があります`,
    [ASK_CLAUDE, ASK_GEMINI, ASK_NOASK],
  );
}

// 音声を文字起こしせず保管のみ（Claudeは音声非対応のためsecure時の代替）。
async function saveAudioRaw(env: Env, replyToken: string, userId: string, messageId: string): Promise<void> {
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
    headers: { authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` },
  });
  if (!res.ok) {
    await lineReply(env, replyToken, "音声の取得に失敗しました。");
    return;
  }
  const mime = res.headers.get("content-type") || "audio/mp4";
  const buf = await res.arrayBuffer();
  const ref = await putMedia(env, `media/${userId}/${messageId}`, buf, mime);
  if (!ref) {
    await lineReply(env, replyToken, "音声の保管に失敗しました（容量超過の可能性）。");
    return;
  }
  await env.DB.prepare(
    "INSERT INTO notes (user_id, kind, content, name, category, doc_date, amount, scope, file_id, status, done, created_at) VALUES (?, 'audio', ?, '音声メモ', '音声', NULL, NULL, 'personal', NULL, 'done', 0, ?)",
  )
    .bind(userId, ref, nowSec())
    .run();
  await appendHistory(env, userId, "user", "（音声を機密として保管しました・未文字起こし）");
  await lineReply(
    env,
    replyToken,
    "🔒 音声を機密として保管しました（文字起こしせず＝Geminiに送っていません）。内容を扱うときはテキストで送るか、「さっきの音声を文字起こしして」（Geminiで良ければ）と指示してください。",
  );
}

// 確認後：選んだmode(cheap=Gemini抽出 / secure=保管のみ)で保留メッセージを処理。
async function processPending(
  env: Env,
  ctx: ExecutionContext,
  replyToken: string,
  userId: string,
  pend: Pending,
  decided: Mode,
  config: ConfigPayload,
): Promise<void> {
  const engine = engineFor(decided, env); // cheap=Gemini抽出 / secure=Claude抽出(鍵なければnone=保管のみ)
  if (pend.kind === "image" && pend.messageId) {
    await saveMedia(env, ctx, replyToken, userId, pend.messageId, "image", undefined, engine);
  } else if (pend.kind === "file" && pend.messageId) {
    await saveMedia(env, ctx, replyToken, userId, pend.messageId, "file", pend.fileName, engine);
  } else if (pend.kind === "audio" && pend.messageId) {
    if (decided === "cheap") {
      const t = await transcribeAudio(env, pend.messageId);
      if (!t) {
        await lineReply(env, replyToken, "音声を認識できませんでした。");
        return;
      }
      await runConversation(env, ctx, replyToken, userId, `（音声の文字起こし）\n${t}`, "cheap", config);
    } else {
      await saveAudioRaw(env, replyToken, userId, pend.messageId); // Claudeは音声非対応のため保管のみ
    }
  } else if (pend.kind === "text" && pend.text) {
    await runConversation(env, ctx, replyToken, userId, pend.text, decided, config);
  }
}

// 会話処理本体（mode＝cheap/secureでGemini/Claudeを切替）。テキスト・確認後の処理から呼ぶ。
async function runConversation(
  env: Env,
  ctx: ExecutionContext,
  replyToken: string,
  userId: string,
  userText: string,
  mode: Mode,
  config: ConfigPayload, // 認証ゲートで検証済みのconfig（当社署名 or 開発既定）
): Promise<void> {
  const recent = await recentHistory(env, userId, HISTORY_KEEP);
  const messages: ApiMsg[] = recent.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.text }));
  messages.push({ role: "user", content: userText });
  // 古い文脈はローリング要約をsystemに注入（生履歴は直近のみ＝文脈維持×トークン固定費）。
  const summary = await env.HISTORY.get(KV_SUM(userId));
  const system = summary ? `${buildSystem(config)}\n\n[これまでの会話の要約（古い履歴の圧縮）]\n${summary}` : buildSystem(config);
  try {
    const tier = await routeModel(env, userText);
    // secure(機微・精度優先)＝Claudeキーがあれば全部Claude（学習なし）。cheap＝従来どおりGemini優先（simple/Claude無し）。
    const useGemini = mode === "secure" && env.ANTHROPIC_API_KEY ? false : !env.ANTHROPIC_API_KEY || tier === "simple";
    const geminiModel = tier === "simple" ? GEMINI_LITE : GEMINI_MODEL;
    const { text, searchCount, media, inTok, outTok, costJpy } = useGemini
      ? await runAgentGemini(env, geminiModel, system, messages, userId, ctx)
      : await runAgent(env, MODELS[tier], system, messages, userId, ctx);
    await appendHistory(env, userId, "user", userText);
    await appendHistory(env, userId, "assistant", text);
    ctx.waitUntil(maybeFoldHistory(env, userId, mode)); // 履歴が伸びたら古い分を要約に畳む
    const usedModel = useGemini ? geminiModel : MODELS[tier];
    const modelLabel = MODEL_LABEL[usedModel] ?? usedModel;
    const cost = useGemini ? "無料枠" : `約${costJpy.toFixed(2)}円`;
    const modeMark = mode === "secure" ? "🔒精度優先" : "💰安さ優先";
    const note =
      `\n\n—(${modeMark} / ${modelLabel} / 検索:${searchCount > 0 ? searchCount + "回" : "なし"})` +
      `\n📊 入力${inTok} / 出力${outTok} tok ・ ${cost}`;
    const lineMessages: unknown[] = [{ type: "text", text: text + note }];
    for (const m of media) lineMessages.push({ type: "image", originalContentUrl: m.url, previewImageUrl: m.url });
    await lineReplyMessages(env, replyToken, lineMessages);
  } catch (e) {
    await lineReply(env, replyToken, `エラーが発生しました：${(e as Error).message}`);
  }
}

async function handleEvent(env: Env, event: LineEvent, ctx: ExecutionContext): Promise<void> {
  if (event.type !== "message" || !event.replyToken) return;
  const userId = event.source?.userId ?? "anon";
  const msg = event.message;

  // クライアント認証ゲート（fail-closed）：開発アカウント以外は、有効な署名付き lease＋config が無いと動かない。
  // データは保持＝人質にしない（機能だけ停止し、承認/更新で自動再開）。
  const auth = await authorize(env, userId);
  if (!auth.ok) {
    await lineReply(env, event.replyToken, auth.message);
    return;
  }
  const config = auth.config; // 下流（runConversation）はこの検証済みconfigを使う

  // === 確認待ちの解決（cheapモードで重要情報の確認を出していた場合、テキスト返信で選択） ===
  const pend = await readPending(env, userId);
  if (pend && msg?.type === "text") {
    const c = msg.text ?? "";
    if (/今後は確認しない|確認しない/.test(c)) {
      await env.HISTORY.put(KV_NOASK(userId), "1");
      await env.HISTORY.delete(KV_PENDING(userId));
      await processPending(env, ctx, event.replyToken, userId, pend, "cheap", config);
      return;
    }
    if (/機密|Claude|🔒|精度/i.test(c)) {
      await env.HISTORY.delete(KV_PENDING(userId));
      await processPending(env, ctx, event.replyToken, userId, pend, "secure", config);
      return;
    }
    if (/このまま|Gemini|💰|無料/i.test(c)) {
      await env.HISTORY.delete(KV_PENDING(userId));
      await processPending(env, ctx, event.replyToken, userId, pend, "cheap", config);
      return;
    }
    await env.HISTORY.delete(KV_PENDING(userId)); // 無関係な返信 → 保留破棄して通常処理へ
  }

  const mode = await getMode(env, userId);
  const noask = !!(await env.HISTORY.get(KV_NOASK(userId)));

  // 画像：secure=Claudeで解析(鍵なければ保管のみ)、cheap&未確認=尋ねる、cheap&noask=Geminiで解析
  if (msg?.type === "image" && msg.id) {
    if (mode === "secure") return void (await saveMedia(env, ctx, event.replyToken, userId, msg.id, "image", undefined, engineFor("secure", env)));
    if (noask) return void (await saveMedia(env, ctx, event.replyToken, userId, msg.id, "image", undefined, "gemini"));
    await savePending(env, userId, { kind: "image", messageId: msg.id });
    await askSensitive(env, event.replyToken, "画像");
    return;
  }
  if (msg?.type === "file" && msg.id) {
    if (mode === "secure") return void (await saveMedia(env, ctx, event.replyToken, userId, msg.id, "file", msg.fileName, engineFor("secure", env)));
    if (noask) return void (await saveMedia(env, ctx, event.replyToken, userId, msg.id, "file", msg.fileName, "gemini"));
    await savePending(env, userId, { kind: "file", messageId: msg.id, fileName: msg.fileName });
    await askSensitive(env, event.replyToken, "ファイル");
    return;
  }
  // 音声：secure=文字起こしせず保管、cheap&未確認=尋ねる、cheap&noask=Geminiで文字起こし
  if (msg?.type === "audio" && msg.id) {
    if (mode === "secure") {
      await saveAudioRaw(env, event.replyToken, userId, msg.id);
      return;
    }
    if (!noask) {
      await savePending(env, userId, { kind: "audio", messageId: msg.id });
      await askSensitive(env, event.replyToken, "音声");
      return;
    }
    const t = await transcribeAudio(env, msg.id);
    if (!t) {
      await lineReply(env, event.replyToken, "音声を認識できませんでした（音声機能が未設定の可能性があります）。");
      return;
    }
    await runConversation(env, ctx, event.replyToken, userId, `（音声の文字起こし）\n${t}`, "cheap", config);
    return;
  }

  if (msg?.type !== "text") return;
  const userText = msg.text ?? "";

  // === モード切替（ユーザー主導・既定=安さ優先） ===
  const cmd = userText.trim().replace(/[🔒💰\s]/g, "");
  if (cmd.length <= 12 && /(精度優先|機密優先|セキュア|機密モード|Claude優先)/i.test(cmd)) {
    await setMode(env, userId, "secure");
    await env.HISTORY.delete(KV_NOASK(userId)); // モードを明示したら確認抑制はリセット
    await lineReply(
      env,
      event.replyToken,
      "🔒 機密・精度優先モードにしました。以降はClaude（学習なし・課金）で処理します。「安さ優先」でいつでも戻せます。",
    );
    return;
  }
  if (cmd.length <= 12 && /(安さ優先|無料優先|節約モード|Gemini優先)/i.test(cmd)) {
    await setMode(env, userId, "cheap");
    await lineReply(
      env,
      event.replyToken,
      "💰 安さ優先モードにしました。雑談などはGemini無料（学習あり）で処理します。重要そうな内容は都度確認します。「精度優先」でいつでも機密モードにできます。",
    );
    return;
  }
  if (cmd.length <= 8 && /^(モード|設定|今のモード|モード確認)$/.test(cmd)) {
    const m = await getMode(env, userId);
    const label = m === "secure" ? "🔒 機密・精度優先（Claude・学習なし）" : "💰 安さ優先（Gemini無料・学習あり）";
    await lineReplyQuick(env, event.replyToken, `現在のモード：${label}\n切り替えますか？`, ["💰 安さ優先", "🔒 精度優先"]);
    return;
  }

  // 重要テキスト：cheap&未確認&機微キーワード → 尋ねる。それ以外は現モードで会話。
  if (mode === "cheap" && !noask && looksSensitive(userText, "text")) {
    await savePending(env, userId, { kind: "text", text: userText });
    await askSensitive(env, event.replyToken, "この内容");
    return;
  }
  await runConversation(env, ctx, event.replyToken, userId, userText, mode, config);
}

// --- admin（承認サーバ相当・開発鍵で署名してKVへ） ---
// 署名済みエンベロープの配信：ホスト分離時(CLIENT_BASE_URL)はクライアントへpush、
// 単一Worker/dev時は自分のKVへ直書き（クライアントが同じKVから読む）。
type TenantEntry = { url: string; provisionKey?: string };

async function tenantEntry(env: Env, tenant: string): Promise<TenantEntry | null> {
  if (!env.TENANTS) return null;
  const raw = await env.TENANTS.get(`tenant:${tenant}`);
  return raw ? (JSON.parse(raw) as TenantEntry) : null;
}

async function postProvision(url: string, provisionKey: string, kind: string, envlp: Envelope): Promise<boolean> {
  const r = await fetch(`${url.replace(/\/$/, "")}/provision`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-provision-key": provisionKey },
    body: JSON.stringify({ kind, env: envlp }),
  });
  if (!r.ok) console.log(`[deliver] ${kind} -> ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.ok;
}

// 署名済みエンベロープの配信。tenant指定（多数顧客）は台帳のURLへ、未指定(self)は Service Binding/既定URL/ローカルKV。
async function deliver(env: Env, kind: "lease" | "config", envlp: Envelope, tenant?: string): Promise<boolean> {
  // 多テナント：台帳に登録された顧客のURLへ配信。
  if (tenant && tenant !== "self") {
    const t = await tenantEntry(env, tenant);
    if (!t) {
      console.log(`[deliver] unknown tenant: ${tenant}`);
      return false;
    }
    return postProvision(t.url, t.provisionKey ?? "", kind, envlp);
  }
  // 既定(self)：同一アカウントは Service Binding（workers.dev同士の直fetchはCFが遮断）。
  if (env.CLIENT) {
    const r = await env.CLIENT.fetch("https://client.internal/provision", {
      method: "POST",
      headers: { "content-type": "application/json", "x-provision-key": env.PROVISION_KEY ?? "" },
      body: JSON.stringify({ kind, env: envlp }),
    });
    if (!r.ok) console.log(`[deliver] ${kind} -> ${r.status}: ${(await r.text()).slice(0, 120)}`);
    return r.ok;
  }
  // 既定(self)：別アカウント等はURL直叩き（カスタムドメイン推奨）。
  if (env.CLIENT_BASE_URL) return postProvision(env.CLIENT_BASE_URL, env.PROVISION_KEY ?? "", kind, envlp);
  // 単一Worker/dev：自分のKVへ直書き。
  await env.HISTORY.put(kind === "lease" ? KV_LEASE : KV_CONFIG, JSON.stringify(envlp));
  return true;
}

async function handleAdmin(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.headers.get("x-admin-key") !== env.ADMIN_KEY) {
    return new Response("forbidden", { status: 403 });
  }
  // 公開検証鍵を返す（顧客へ配る VERIFY_PUBLIC_JWK の取得用）。
  if (req.method === "GET" && url.pathname === "/admin/pubkey") {
    const jwk = jwkOf(env);
    return Response.json({ kty: jwk.kty, crv: jwk.crv, x: jwk.x });
  }
  // テナント台帳：登録／一覧（多数顧客の配信先URLとprovision鍵を管理）。
  if (url.pathname === "/admin/tenant") {
    if (!env.TENANTS) return new Response("TENANTS KV 未設定", { status: 400 });
    const id = url.searchParams.get("id");
    const turl = url.searchParams.get("url");
    if (!id || !turl) return new Response("id と url が必要", { status: 400 });
    const entry: TenantEntry = { url: turl, provisionKey: url.searchParams.get("provisionKey") ?? "" };
    await env.TENANTS.put(`tenant:${id}`, JSON.stringify(entry));
    return Response.json({ ok: true, tenant: id, url: turl });
  }
  if (req.method === "GET" && url.pathname === "/admin/tenants") {
    if (!env.TENANTS) return Response.json({ tenants: [] });
    const list = await env.TENANTS.list({ prefix: "tenant:" });
    return Response.json({ tenants: list.keys.map((k) => k.name.slice("tenant:".length)) });
  }
  if (url.pathname === "/admin/lease") {
    const days = Number(url.searchParams.get("days") ?? "30");
    const version = url.searchParams.get("version") ?? "v1";
    const tenant = url.searchParams.get("tenant") ?? "self";
    const lease: LeasePayload = {
      tenant,
      status: "active",
      paid_through: nowSec() + Math.round(days * 86400),
      config_version: version,
    };
    const envlp = await signLease(jwkOf(env), lease);
    const ok = await deliver(env, "lease", envlp, tenant);
    return Response.json({ ok, lease });
  }
  if (url.pathname === "/admin/config") {
    const version = url.searchParams.get("version") ?? "v1";
    const tenant = url.searchParams.get("tenant") ?? "self";
    const cfg = CONFIGS[version];
    if (!cfg) return new Response("unknown version", { status: 400 });
    const envlp = await signConfig(jwkOf(env), cfg);
    const ok = await deliver(env, "config", envlp, tenant);
    return Response.json({ ok, version, persona: cfg.persona.name, tenant });
  }
  return new Response("not found", { status: 404 });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") {
      return new Response("baku-office: ok", { status: 200 });
    }
    // 画像・ファイル配信（KV or Driveから取り出して返す）。
    if (req.method === "GET" && url.pathname.startsWith("/media/")) {
      const ref = decodeURIComponent(url.pathname.slice("/media/".length));
      const obj = await getMedia(env, ref);
      if (!obj) return new Response("not found", { status: 404 });
      return new Response(obj.buf, {
        headers: { "content-type": obj.mime, "cache-control": "private, max-age=3600" },
      });
    }
    // 自己連鎖Cron：内部秘密で保護。即ACK→裏で次バッチ処理。
    if (req.method === "POST" && url.pathname === "/internal/drain") {
      if (req.headers.get("x-internal-key") !== env.INTERNAL_KEY) return new Response("forbidden", { status: 403 });
      ctx.waitUntil(processSummaryJobs(env, ctx));
      return new Response("ok");
    }
    // Google Drive OAuth：大容量ストレージ連携。
    if (req.method === "GET" && url.pathname === "/oauth/start") {
      if (!env.GOOGLE_CLIENT_ID) return new Response("GOOGLE_CLIENT_ID 未設定", { status: 400 });
      const redirect = `${env.PUBLIC_BASE_URL}/oauth/callback`;
      const auth =
        `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(env.GOOGLE_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(redirect)}&response_type=code` +
        `&scope=${encodeURIComponent("https://www.googleapis.com/auth/drive.file")}&access_type=offline&prompt=consent`;
      return Response.redirect(auth, 302);
    }
    if (req.method === "GET" && url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("認可コードがありません", { status: 400 });
      const redirect = `${env.PUBLIC_BASE_URL}/oauth/callback`;
      const tr = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirect,
          grant_type: "authorization_code",
        }),
      });
      if (!tr.ok) return new Response("トークン取得に失敗：" + (await tr.text()).slice(0, 200), { status: 500 });
      const data = (await tr.json()) as { refresh_token?: string };
      if (!data.refresh_token) return new Response("refresh_token が取得できませんでした（既に連携済みかも）。", { status: 200 });
      await env.HISTORY.put("drive_refresh_token", data.refresh_token);
      return new Response("✅ Google Drive連携が完了しました。LINEに戻って大容量ファイルを送れます。", { status: 200 });
    }
    // クライアント側：ホストから署名済みlease/configを受け取って自分のKVへ保存（配信受け口）。
    // 署名を必ず検証してから保存するので、偽造は保存されない。PROVISION_KEY があれば一次フィルタ。
    if (req.method === "POST" && url.pathname === "/provision") {
      if (env.PROVISION_KEY && req.headers.get("x-provision-key") !== env.PROVISION_KEY) {
        return new Response("forbidden", { status: 403 });
      }
      const { kind, env: envlp } = (await req.json()) as { kind?: string; env?: Envelope };
      if (!envlp || (kind !== "lease" && kind !== "config")) return new Response("bad request", { status: 400 });
      try {
        if (kind === "lease") await openLease(verifyJwkOf(env), envlp);
        else await openConfig(verifyJwkOf(env), envlp);
      } catch {
        return new Response("invalid signature", { status: 400 });
      }
      await env.HISTORY.put(kind === "lease" ? KV_LEASE : KV_CONFIG, JSON.stringify(envlp));
      return new Response("ok");
    }
    if (url.pathname.startsWith("/admin/")) {
      return handleAdmin(req, env, url);
    }
    if (req.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("not found", { status: 404 });
    }

    const body = await req.text();
    const sig = req.headers.get("x-line-signature") ?? "";
    if (!(await verifyLineSignature(env.LINE_CHANNEL_SECRET, body, sig))) {
      return new Response("invalid signature", { status: 401 });
    }

    const payload = JSON.parse(body) as { events?: LineEvent[] };
    // LINEは5秒以内のACKを要求。重い処理は waitUntil に逃がして即200を返す。
    for (const event of payload.events ?? []) {
      // 冪等化：LINEはタイムアウト/5xxでWebhookを再送する。webhookEventId で一度きりに絞り、
      // AI課金・返信・保存の二重化を防ぐ（check-then-set。短時間の競合はKVの結果整合で稀に取りこぼすが実害は再送1回分）。
      const id = event.webhookEventId;
      if (id) {
        if (await env.HISTORY.get(KV_SEEN(id))) continue; // 既処理 → スキップ
        await env.HISTORY.put(KV_SEEN(id), "1", { expirationTtl: 86400 }); // 24h保持（LINEの再送窓を十分カバー）
      }
      ctx.waitUntil(handleEvent(env, event, ctx));
    }
    return new Response("ok", { status: 200 });
  },

  // Cron：リマインダーPush＋大PDF分割要約を1ステップ進める。
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const { results } = await env.DB.prepare(
      "SELECT id, user_id, content FROM reminders WHERE done = 0 AND remind_at <= ? ORDER BY remind_at ASC LIMIT 50",
    )
      .bind(nowSec())
      .all<{ id: number; user_id: string; content: string }>();
    for (const r of results) {
      await linePush(env, r.user_id, `⏰ リマインド：${r.content}`);
      await env.DB.prepare("UPDATE reminders SET done = 1 WHERE id = ?").bind(r.id).run();
    }
    await processSummaryJobs(env, ctx);
  },
};

// 複数ジョブを並行処理し、残れば自分の内部エンドポイントを叩いて次バッチへ（毎分Cron縛りを外す）。
// 律速はCPUでもwallでもなく「サブリクエスト50回/起動」。1ジョブ≒upload+要約で数回なのでLIMITは控えめに。
const MAX_JOBS_PER_INVOCATION = 5;

async function processSummaryJobs(env: Env, ctx: ExecutionContext): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, note_id, user_id, scope, file_uri, total_pages, next_page, chunk_size, partial, status, engine FROM summary_jobs WHERE status IN ('pending','running') ORDER BY id ASC LIMIT ?",
  )
    .bind(MAX_JOBS_PER_INVOCATION)
    .all<JobRow>();
  await Promise.all(results.map((job) => processOneStep(env, job)));
  // まだpendingが残っていれば、毎分Cronを待たず自己連鎖で次バッチを起動（待ち時間は無料無制限）。
  const more = await env.DB.prepare("SELECT 1 FROM summary_jobs WHERE status = 'pending' LIMIT 1").first();
  if (more) ctx.waitUntil(kickContinue(env));
}

async function kickContinue(env: Env): Promise<void> {
  if (!env.PUBLIC_BASE_URL || !env.INTERNAL_KEY) return;
  await fetch(`${env.PUBLIC_BASE_URL}/internal/drain`, {
    method: "POST",
    headers: { "x-internal-key": env.INTERNAL_KEY },
  }).catch(() => {
    /* 連鎖が切れても次のCronが拾う */
  });
}

// 1ジョブを1ステップだけ進める（upload→ページ数→3ページずつ要約→完了でキャッシュ）。
async function processOneStep(env: Env, job: JobRow): Promise<void> {
  const fail = () => env.DB.prepare("UPDATE summary_jobs SET status = 'error', updated_at = ? WHERE id = ?").bind(nowSec(), job.id).run();
  try {
    const note = await env.DB.prepare("SELECT content, name FROM notes WHERE id = ?")
      .bind(job.note_id)
      .first<{ content: string; name: string | null }>();
    if (!note) {
      await fail();
      return;
    }
    const mime = fileMime(note.name);
    const summaryQ =
      "この資料の内容を、主要な数値・項目・結論を漏れなく日本語で詳しく要約してください。後で質問に答えるための参照用です。";
    // engine=claude（機微・学習なし）：Anthropic Files APIへupload→document参照で要約（base64なし）。
    if (job.engine === "claude" && env.ANTHROPIC_API_KEY) {
      const obj = await getMedia(env, note.content);
      if (!obj) {
        await fail();
        return;
      }
      const fid = await uploadToFiles(env, obj.buf, note.name ?? "document.pdf", mime);
      if (!fid) {
        await fail();
        return;
      }
      const summary = await readFile(env, fid, summaryQ);
      if (!summary) {
        await fail();
        return;
      }
      await env.DB.prepare(
        "INSERT INTO knowledge (user_id, content, scope, source_note_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(job.user_id, `[資料キャッシュ] ${note.name ?? "資料"}\n${summary}`.slice(0, 200000), job.scope, job.note_id, nowSec())
        .run();
      await env.DB.prepare("UPDATE summary_jobs SET status = 'done', updated_at = ? WHERE id = ?").bind(nowSec(), job.id).run();
      return;
    }
    // レビュー反映：分割（ページごと）をやめ、1リクエストで丸ごと要約する（段数=リクエスト数を最小化）。
    // 1) まだ Gemini Files にアップロードしていなければ生のままupload（base64なし）。
    let fileUri = job.file_uri;
    if (!fileUri) {
      // drive: は全バッファせずストリームで resumable upload（KV等はバッファで簡易upload）。
      fileUri = await geminiUploadFromRef(env, note.content, mime);
      if (!fileUri) {
        await fail();
        return;
      }
      await env.DB.prepare("UPDATE summary_jobs SET file_uri = ?, status = 'running', updated_at = ? WHERE id = ?")
        .bind(fileUri, nowSec(), job.id)
        .run();
      // アップロード〜要約はどちらも「待ち時間」なので、同じ起動でそのまま続ける。
    }
    // 2) 1リクエストで全文要約（Geminiは1回で大きな文書を読める）。
    const summary = await geminiByUri(
      env,
      fileUri,
      mime,
      "この資料の内容を、主要な数値・項目・結論を漏れなく日本語で詳しく要約してください。後で質問に答えるための参照用です。",
    );
    if (!summary) {
      await fail();
      return;
    }
    await env.DB.prepare(
      "INSERT INTO knowledge (user_id, content, scope, source_note_id, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(job.user_id, `[資料キャッシュ] ${note.name ?? "資料"}\n${summary}`.slice(0, 200000), job.scope, job.note_id, nowSec())
      .run();
    await env.DB.prepare("UPDATE summary_jobs SET status = 'done', updated_at = ? WHERE id = ?")
      .bind(nowSec(), job.id)
      .run();
  } catch {
    await fail();
  }
}
