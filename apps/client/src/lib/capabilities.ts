// 任意API（能力レジストリ §5-2b の api 種別・高度なオプション）。BYOK・暗号化保存。
// AI/エージェントは「有効な能力」をツール／自己認識として参照し、設定時のみ実行。
import { randomId, encryptField, decryptField } from "@baku-office/shared";
import { masterKey } from "./client.ts";
import { saveFile } from "./storage.ts";
import { nowSec } from "./accounting.ts";

export type Capability = { id: string; capability: string; provider: string | null; endpoint: string | null; model: string | null; enabled: number; created_at: number };

export const CAPABILITY_LABEL: Record<string, string> = { image_gen: "画像生成", tts: "音声合成", video_gen: "動画生成", embed: "埋め込み(検索)", custom: "カスタムAPI" };

export async function listCapabilities(env: Env, onlyEnabled = false): Promise<Capability[]> {
  const sql = onlyEnabled ? "SELECT id,capability,provider,endpoint,model,enabled,created_at FROM capabilities WHERE enabled=1 ORDER BY capability" : "SELECT id,capability,provider,endpoint,model,enabled,created_at FROM capabilities ORDER BY created_at DESC";
  return (await env.DB.prepare(sql).all<Capability>()).results;
}
export async function createCapability(env: Env, a: { capability: string; provider?: string; endpoint?: string; model?: string; api_key?: string }): Promise<string> {
  const id = randomId();
  const enc = a.api_key ? await encryptField(masterKey(env), a.api_key, "api-keys") : null;
  await env.DB.prepare("INSERT INTO capabilities (id,capability,provider,endpoint,model,api_key,enabled,created_at) VALUES (?,?,?,?,?,?,0,?)")
    .bind(id, a.capability, a.provider ?? null, a.endpoint ?? null, a.model ?? null, enc, nowSec()).run();
  return id;
}
export async function setCapabilityEnabled(env: Env, id: string, enabled: boolean): Promise<void> {
  await env.DB.prepare("UPDATE capabilities SET enabled=? WHERE id=?").bind(enabled ? 1 : 0, id).run();
}
export async function deleteCapability(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM capabilities WHERE id=?").bind(id).run();
}
async function capKey(env: Env, id: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT api_key FROM capabilities WHERE id=?").bind(id).first<{ api_key: string | null }>();
  if (!row?.api_key) return null;
  try { return await decryptField(masterKey(env), row.api_key, "api-keys"); } catch { return null; }
}

// エージェントの自己認識用：有効な能力の一覧テキスト。
export async function capabilitySummary(env: Env): Promise<string> {
  const caps = await listCapabilities(env, true);
  if (!caps.length) return "";
  return "利用可能な追加能力：" + caps.map((c) => `${CAPABILITY_LABEL[c.capability] ?? c.capability}(${c.provider ?? ""})`).join("、");
}

// 能力の実行（設定済みの最初の有効プロバイダを使用）。成果物はファイル保存→DLリンク。
export async function invokeCapability(env: Env, owner: string, baseUrl: string, capability: "image_gen" | "tts" | "video_gen", input: string): Promise<string> {
  const cap = (await listCapabilities(env, true)).find((c) => c.capability === capability);
  if (!cap) return `${CAPABILITY_LABEL[capability]}は未設定です（高度なオプションで追加・有効化してください）。`;
  const key = await capKey(env, cap.id);
  if (!key) return `${CAPABILITY_LABEL[capability]}のAPIキーが未設定です。`;

  try {
    if (capability === "image_gen") {
      // OpenAI 互換 images（provider/endpoint で差し替え可）。
      const url = cap.endpoint || "https://api.openai.com/v1/images/generations";
      const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: cap.model || "gpt-image-1", prompt: input, n: 1, size: "1024x1024" }) });
      if (!r.ok) return `画像生成APIエラー：${r.status}`;
      const d = (await r.json()) as { data?: { b64_json?: string; url?: string }[] };
      const item = d.data?.[0];
      let buf: ArrayBuffer | null = null;
      if (item?.b64_json) buf = Uint8Array.from(atob(item.b64_json), (c) => c.charCodeAt(0)).buffer;
      else if (item?.url) buf = await (await fetch(item.url)).arrayBuffer();
      if (!buf) return "画像を取得できませんでした。";
      const saved = await saveFile(env, new File([buf], "image.png", { type: "image/png" }), owner);
      return `画像を生成しました：${baseUrl}/files/${saved.id}`;
    }
    if (capability === "tts") {
      const url = cap.endpoint || "https://api.openai.com/v1/audio/speech";
      const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: cap.model || "tts-1", voice: "alloy", input }) });
      if (!r.ok) return `音声合成APIエラー：${r.status}`;
      const saved = await saveFile(env, new File([await r.arrayBuffer()], "speech.mp3", { type: "audio/mpeg" }), owner);
      return `音声を生成しました：${baseUrl}/files/${saved.id}`;
    }
    // video_gen：多くは非同期ジョブのためv1は受付のみ案内。
    return "動画生成は受け付けましたが、非同期処理のため結果反映は次段で対応します。";
  } catch (e) {
    return `${CAPABILITY_LABEL[capability]}の実行に失敗：${(e as Error).message}`;
  }
}
