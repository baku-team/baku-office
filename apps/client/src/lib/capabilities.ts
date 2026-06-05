// 任意API（能力レジストリ §5-2b の api 種別・高度なオプション）。BYOK・暗号化保存。
// AI/エージェントは「有効な能力」をツール／自己認識として参照し、設定時のみ実行。
import { randomId, encryptField, decryptField } from "@baku-office/shared";
import { masterKey } from "./client.ts";
import { saveFile } from "./storage.ts";
import { nowSec } from "./accounting.ts";
import { recordUsage } from "./usage.ts";

export type Capability = { id: string; capability: string; provider: string | null; endpoint: string | null; model: string | null; enabled: number; created_at: number };

export const CAPABILITY_LABEL: Record<string, string> = { image_gen: "画像生成", tts: "音声合成", video_gen: "動画生成", embed: "埋め込み(検索)", custom: "カスタムAPI" };

export async function listCapabilities(env: Env, onlyEnabled = false): Promise<Capability[]> {
  const sql = onlyEnabled ? "SELECT id,capability,provider,endpoint,model,enabled,created_at FROM capabilities WHERE enabled=1 ORDER BY capability" : "SELECT id,capability,provider,endpoint,model,enabled,created_at FROM capabilities ORDER BY created_at DESC";
  return (await env.DB.prepare(sql).all<Capability>()).results;
}
export async function createCapability(env: Env, a: { capability: string; provider?: string; endpoint?: string; model?: string; api_key?: string }): Promise<string> {
  const id = randomId();
  const enc = a.api_key ? await encryptField(await masterKey(env), a.api_key, "api-keys") : null;
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
  try { return await decryptField(await masterKey(env), row.api_key, "api-keys"); } catch { return null; }
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
  await recordUsage(env, capability);

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
    // video_gen：非同期。作成→ジョブ登録→推定時間後にポーリング（drain）で取得。
    {
      const url = cap.endpoint;
      if (!url) return "動画生成のエンドポイント（作成API）が未設定です（高度なオプション）。";
      const r = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: cap.model || undefined, prompt: input }) });
      if (!r.ok) return `動画生成APIエラー：${r.status}`;
      const d = (await r.json()) as { id?: string; task_id?: string; status_url?: string; eta_seconds?: number };
      const jobId = d.id || d.task_id || "";
      const statusUrl = d.status_url || (jobId ? `${url.replace(/\/$/, "")}/${jobId}` : "");
      const eta = nowSec() + (d.eta_seconds || 60);
      await env.DB.prepare("INSERT INTO video_jobs (id,owner,cap_id,job_id,status_url,prompt,status,eta,created_at,updated_at) VALUES (?,?,?,?,?,?,'pending',?,?,?)")
        .bind(randomId(), owner, cap.id, jobId, statusUrl, input, eta, nowSec(), nowSec()).run();
      return `🎬 動画生成を開始しました（目安 約${d.eta_seconds || 60}秒）。完成したらファイル一覧へ保存し、LINEにURLをお知らせします。「動画できた？」で確認もできます。`;
    }
  } catch (e) {
    return `${CAPABILITY_LABEL[capability]}の実行に失敗：${(e as Error).message}`;
  }
}

// 動画ジョブのポーリング（drainから定期実行）。推定時間到来分のステータスを確認し、完成→DL保存＋LINE通知。
export async function pollVideoJobs(env: Env, accessToken?: string, limit = 5): Promise<{ done: number; pending: number }> {
  const now = nowSec();
  const { results } = await env.DB.prepare("SELECT id,owner,cap_id,status_url,eta FROM video_jobs WHERE status='pending' AND eta<=? ORDER BY eta LIMIT ?").bind(now, limit).all<{ id: string; owner: string; cap_id: string; status_url: string | null; eta: number }>();
  let done = 0, pending = 0;
  for (const job of results) {
    if (!job.status_url) { await env.DB.prepare("UPDATE video_jobs SET status='error',updated_at=? WHERE id=?").bind(now, job.id).run(); continue; }
    const key = await capKey(env, job.cap_id);
    try {
      const r = await fetch(job.status_url, { headers: key ? { authorization: `Bearer ${key}` } : {} });
      if (!r.ok) { pending++; await env.DB.prepare("UPDATE video_jobs SET eta=?,updated_at=? WHERE id=?").bind(now + 30, now, job.id).run(); continue; }
      const d = (await r.json()) as { status?: string; state?: string; url?: string; output?: string | { url?: string } };
      const st = (d.status || d.state || "").toLowerCase();
      const outUrl = d.url || (typeof d.output === "string" ? d.output : d.output?.url);
      if ((st === "succeeded" || st === "completed" || st === "done") && outUrl) {
        const buf = await (await fetch(outUrl)).arrayBuffer();
        const saved = await saveFile(env, new File([buf], "video.mp4", { type: "video/mp4" }), job.owner);
        await env.DB.prepare("UPDATE video_jobs SET status='done',file_id=?,updated_at=? WHERE id=?").bind(saved.id, now, job.id).run();
        done++;
        // LINE通知（owner が line: かつ token あれば）。
        if (accessToken && job.owner.startsWith("line:")) {
          await fetch("https://api.line.me/v2/bot/message/push", { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ to: job.owner.slice(5), messages: [{ type: "text", text: `🎬 動画が完成しました。ファイル一覧またはこちら：/files/${saved.id}` }] }) });
        }
      } else if (st === "failed" || st === "error") {
        await env.DB.prepare("UPDATE video_jobs SET status='error',updated_at=? WHERE id=?").bind(now, job.id).run();
      } else {
        pending++;
        await env.DB.prepare("UPDATE video_jobs SET eta=?,updated_at=? WHERE id=?").bind(now + 30, now, job.id).run();
      }
    } catch {
      pending++;
      await env.DB.prepare("UPDATE video_jobs SET eta=?,updated_at=? WHERE id=?").bind(now + 30, now, job.id).run();
    }
  }
  return { done, pending };
}

// 「動画できた？」用：直近の動画ジョブ状況テキスト。
export async function videoStatusText(env: Env, owner: string, baseUrl: string): Promise<string> {
  const { results } = await env.DB.prepare("SELECT status,file_id FROM video_jobs WHERE owner=? ORDER BY created_at DESC LIMIT 5").bind(owner).all<{ status: string; file_id: string | null }>();
  if (!results.length) return "動画生成の依頼はありません。";
  return results.map((j) => (j.status === "done" && j.file_id ? `✅ 完成：${baseUrl}/files/${j.file_id}` : j.status === "error" ? "❌ 失敗" : "⏳ 生成中…")).join("\n");
}
