// 署名config（人格・機能）＋ライセンス（paid_throughで停止）。#2機構の本番接続。
import {
  type Envelope,
  type Ed25519Jwk,
  importSignKey,
  importVerifyKey,
  signEnvelope,
  verifyEnvelope,
  payloadOf,
} from "./crypto";

// 能力レジストリ（5-2b）：4種別で解決手段を整理しオーケストレーション案内する。
//   builtin = ブレインが素で実行（外部API不要・追加費用なし）
//   skill   = Claude Agent Skills（SKILL.md＋code execution・betaヘッダ・コンテナ実行課金）
//   api     = 外部サービスのBYOKが必要
//   plugin  = Worker側の機能モジュール（有効化が必要）
// enabled=false の能力が必要な依頼には、実行を装わず needs を案内する。
export type CapKind = "builtin" | "skill" | "api" | "plugin";
export type Capability = { id: string; label: string; kind: CapKind; enabled: boolean; needs?: string };

export const BASE_CAPS: Capability[] = [
  // --- builtin（API不要・そのまま実行） ---
  { id: "chat", label: "会話・文章生成", kind: "builtin", enabled: true },
  { id: "summarize", label: "要約", kind: "builtin", enabled: true },
  { id: "translate", label: "翻訳", kind: "builtin", enabled: true },
  { id: "proofread", label: "文章校正・敬語調整", kind: "builtin", enabled: true },
  { id: "extract", label: "情報抽出・表/箇条書き整形", kind: "builtin", enabled: true },
  // --- skill（Claude Agent Skills） ---
  { id: "doc_gen", label: "資料・スライド・PDF・Excel生成", kind: "skill", enabled: true }, // make_document で接続済み
  { id: "custom_skill", label: "独自業務手順スキル", kind: "skill", enabled: false, needs: "Agent Skills有効化（独自SKILL.md登録）" },
  // --- API（外部サービスのBYOK） ---
  { id: "web_search", label: "Web検索", kind: "api", enabled: true }, // Anthropic公式・接続済み
  { id: "image_gen", label: "画像生成", kind: "api", enabled: false, needs: "画像生成API（例：OpenAI gpt-image / Stability）のBYOK" },
  { id: "transcribe", label: "音声の文字起こし・議事録", kind: "api", enabled: true }, // Gemini で接続済み
  { id: "tts", label: "音声読み上げ", kind: "api", enabled: false, needs: "音声合成API（例：OpenAI / ElevenLabs）のBYOK" },
  { id: "video_gen", label: "動画生成", kind: "api", enabled: false, needs: "動画生成API（例：Runway / Luma）のBYOK" },
  // --- プラグイン（Worker側機能・要有効化） ---
  { id: "reminder", label: "リマインダー・定期通知", kind: "plugin", enabled: false, needs: "プラグイン有効化（Cron/Push設定）" },
  { id: "knowledge", label: "組織ナレッジ参照（RAG）", kind: "plugin", enabled: false, needs: "プラグイン有効化（ナレッジ登録）" },
];

export type ConfigPayload = {
  version: string;
  persona: { name: string; system: string };
  capabilities: Capability[];
};

export type LeasePayload = {
  tenant: string;
  status: "active" | "suspended";
  paid_through: number; // epoch秒。これを過ぎたら未払い扱いで停止。
  config_version: string;
};

// admin が選べる人格プリセット（コードは固定・configデータだけ差し替えで挙動が変わる）。
export const CONFIGS: Record<string, ConfigPayload> = {
  v1: {
    version: "v1",
    persona: {
      name: "丁寧アシスタント",
      system:
        "あなたはLINE上で動く日本語アシスタントです。常に敬語（です・ます調）で簡潔に答えます。" +
        "あなたはAIであり、医療・法律・税務などの専門判断は確定的な助言をせず、専門家への相談を促します。",
    },
    capabilities: BASE_CAPS,
  },
  v2: {
    version: "v2",
    persona: {
      name: "関西弁ガイド",
      system:
        "あなたはLINE上で動く、親しみやすい関西弁で話すアシスタントです。フレンドリーかつ簡潔に答えます。" +
        "あなたはAIであり、医療・法律・税務などの専門判断は断定せず、専門家への相談をすすめます。",
    },
    capabilities: BASE_CAPS,
  },
};

// --- 署名（admin / 承認サーバ相当） ---
export async function signConfig(jwk: Ed25519Jwk, cfg: ConfigPayload): Promise<Envelope> {
  return signEnvelope(await importSignKey(jwk), cfg);
}
export async function signLease(jwk: Ed25519Jwk, lease: LeasePayload): Promise<Envelope> {
  return signEnvelope(await importSignKey(jwk), lease);
}

// --- 検証（runtime / 顧客エージェント・公開鍵のみ） ---
export async function openConfig(jwk: Ed25519Jwk, env: Envelope): Promise<ConfigPayload> {
  if (!(await verifyEnvelope(await importVerifyKey(jwk), env))) throw new Error("config signature invalid");
  return payloadOf(env) as ConfigPayload;
}
export async function openLease(jwk: Ed25519Jwk, env: Envelope): Promise<LeasePayload> {
  if (!(await verifyEnvelope(await importVerifyKey(jwk), env))) throw new Error("lease signature invalid");
  return payloadOf(env) as LeasePayload;
}

// 有効ライセンス＝active かつ paid_through 未経過。
export function licensed(lease: LeasePayload, nowSec: number): boolean {
  return lease.status === "active" && nowSec < lease.paid_through;
}
