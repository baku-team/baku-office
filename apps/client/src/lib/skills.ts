// ユーザー追加の Agent Skills（設計書 能力レジストリ§5-2b の skill 種別）。
// スキルは「データ」（SKILL.md）として顧客が追加し、固定ランタイムがロードして実行（Worker内でevalは行わない）。
//   instruction：SKILL.md を Claude に注入して成果物（md等）を生成（通常LLM費）。
//   code：Anthropic code execution（コンテナ実行＝従量課金・高度なオプション）。pptx/docx等の本格生成向け。
import { randomId } from "@baku-office/shared";
import { getApiKey } from "./client.ts";
import { saveFile } from "./storage.ts";
import { nowSec } from "./accounting.ts";
import { recordUsage, recordTokens } from "./usage.ts";

export type Skill = { id: string; name: string; description: string | null; skill_md: string; mode: string; enabled: number; created_at: number };

export async function listSkills(env: Env, onlyEnabled = false): Promise<Skill[]> {
  const sql = onlyEnabled ? "SELECT * FROM skills WHERE enabled=1 ORDER BY name" : "SELECT * FROM skills ORDER BY created_at DESC";
  return (await env.DB.prepare(sql).all<Skill>()).results;
}
export async function createSkill(env: Env, by: string, a: { name: string; description?: string; skill_md: string; mode: string }): Promise<string> {
  const id = randomId();
  await env.DB.prepare("INSERT INTO skills (id,name,description,skill_md,mode,enabled,created_by,created_at) VALUES (?,?,?,?,?,0,?,?)")
    .bind(id, a.name, a.description ?? null, a.skill_md, a.mode === "code" ? "code" : "instruction", by, nowSec()).run();
  return id;
}
export async function setSkillEnabled(env: Env, id: string, enabled: boolean): Promise<void> {
  await env.DB.prepare("UPDATE skills SET enabled=? WHERE id=?").bind(enabled ? 1 : 0, id).run();
}
export async function deleteSkill(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM skills WHERE id=?").bind(id).run();
}

// --- AIによるスキル検索・自動反映（Plus以上）。要望からSKILL.mdを設計し、無効状態で登録（管理者が有効化）。
type SkillDraft = { name: string; description?: string; skill_md: string; mode: string };
function parseSkillJSON(raw: string): SkillDraft | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    if (!o.name || !o.skill_md) return null;
    return {
      name: String(o.name).slice(0, 60),
      description: o.description ? String(o.description).slice(0, 200) : undefined,
      skill_md: String(o.skill_md).slice(0, 20000),
      mode: o.mode === "code" ? "code" : "instruction",
    };
  } catch { return null; }
}
async function geminiJSON(env: Env, key: string, sys: string, prompt: string): Promise<string> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 1500 } }),
  });
  if (!r.ok) return "";
  const d = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
  await recordTokens(env, "gemini", { inputTokens: d.usageMetadata?.promptTokenCount ?? 0, outputTokens: d.usageMetadata?.candidatesTokenCount ?? 0 });
  return d.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
}
async function claudeJSON(env: Env, key: string, sys: string, prompt: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1500, system: sys, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) return "";
  const d = (await r.json()) as { content?: { text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
  await recordTokens(env, "claude", { inputTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0 });
  return (d.content ?? []).map((c) => c.text ?? "").join("");
}
export async function generateSkill(env: Env, by: string, request: string): Promise<{ ok: boolean; id?: string; name?: string; error?: string }> {
  const gkey = await getApiKey(env, "gemini");
  const ckey = await getApiKey(env, "claude");
  if (!gkey && !ckey) return { ok: false, error: "AIキーが未設定です（連携設定で Gemini か Claude を登録してください）。" };
  const sys = "あなたは業務自動化スキルの設計者。ユーザーの要望から再利用可能な業務スキルを1つ設計する。";
  const prompt =
    `次の要望に応えるスキルを設計し、JSONのみ出力（前置き・コードフェンス無し）。\n要望:${request}\n` +
    `形式:{"name":"短い日本語の呼び出し名","description":"用途の1行説明","mode":"instruction または code","skill_md":"# スキル名\\n手順・テンプレート(Markdown)"}\n` +
    `表計算・ファイルの本格生成・計算処理が要るなら mode=code、文書テンプレ中心なら instruction。`;
  const raw = gkey ? await geminiJSON(env, gkey, sys, prompt) : await claudeJSON(env, ckey!, sys, prompt);
  await recordUsage(env, gkey ? "gemini" : "claude");
  const draft = parseSkillJSON(raw);
  if (!draft) return { ok: false, error: "スキル生成に失敗しました（応答を解釈できません）。" };
  const id = await createSkill(env, by, draft);
  return { ok: true, id, name: draft.name };
}

// スキル実行：有効スキルを名前で探し、mode に応じて Claude で実行。Claudeキー必須。
export async function runSkill(env: Env, owner: string, baseUrl: string, name: string, input: string): Promise<string> {
  const key = await getApiKey(env, "claude");
  if (!key) return "スキル実行には Claude APIキーが必要です（連携設定で登録）。";
  const skill = await env.DB.prepare("SELECT * FROM skills WHERE name=? AND enabled=1").bind(name).first<Skill>();
  if (!skill) return `有効なスキル「${name}」が見つかりません（高度なオプションで追加・有効化してください）。`;

  if (skill.mode === "code") {
    // Anthropic code execution（コンテナ・従量課金）。スキル手順に従い処理・成果物生成。
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-beta": "code-execution-2025-05-22", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6", max_tokens: 4000,
        tools: [{ type: "code_execution_20250522", name: "code_execution" }],
        messages: [{ role: "user", content: `次のスキル手順に従って処理してください。\n\n# SKILL\n${skill.skill_md}\n\n# 入力\n${input}` }],
      }),
    });
    if (!r.ok) { console.log("[skill-code]", r.status, (await r.text()).slice(0, 150)); return "スキル実行（コード）に失敗しました。アカウントで code execution が有効か確認してください。"; }
    const data = (await r.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    await recordTokens(env, "claude", { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 });
    const text = (data.content ?? []).map((c) => c.text ?? "").join("").trim();
    return text || "（実行は完了しましたが、テキスト出力はありません。生成ファイルの取得は次段で対応）";
  }

  // instruction：SKILL.md を注入して成果物（md）を生成→保存→DLリンク。
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 4000, system: `あなたは次のスキル手順に従う作成アシスタント。本文(Markdown)のみ出力。\n\n${skill.skill_md}`, messages: [{ role: "user", content: input }] }),
  });
  if (!r.ok) return "スキル実行に失敗しました。";
  const data = (await r.json()) as { content?: { text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
  await recordTokens(env, "claude", { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 });
  const out = (data.content ?? []).map((c) => c.text ?? "").join("");
  const file = new File([new TextEncoder().encode(out)], `${skill.name}.md`, { type: "text/markdown" });
  const saved = await saveFile(env, file, owner);
  return `スキル「${skill.name}」を実行しました。\nダウンロード：${baseUrl}/files/${saved.id}`;
}
