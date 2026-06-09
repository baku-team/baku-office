// Proプランの会計・庶務エージェント（設計書§2/付録B）。
// Gemini function-calling のツールループで、新データモデル（personal_items/knowledge/reminders/users）を操作。
// APIキーは連携設定の暗号KVから復号して使用。
import { getApiKey, entitlementForGate } from "./client.ts";
import { type Role, atLeast } from "@baku-office/shared";
import type { Ctx } from "../core/ports.ts";
import { enabledParts, toolsOf, enabledPartIds, type AgentTool } from "../core/parts.ts";
import { runToolLoop, type ToolDecl, type Turn, type ChatModel } from "../core/ai.ts";
import { ROLES, toolsForRole, normalizeRole, ROLE_LIST } from "./multi-agent.ts";
import { maxParallelAgents, agentMaxHops } from "./settings.ts";
import { callPartner, groupRelayCall } from "./a2a.ts";
import { autonomyReady, AUTONOMY_TOOLS, AUTONOMY_POLICY, runAutonomyTool } from "./autonomy.ts";
import { localChatModel } from "../core/models/local.ts";
import { geminiModel } from "../core/models/gemini.ts";
import { claudeModel } from "../core/models/claude.ts";
import "../parts/index.ts"; // 組み込みパーツを登録（副作用・移植性アーキ §4）
import { webSearch, makeDocument } from "./media-ai.ts";
import { listSkills, runSkill, generateSkill } from "./skills.ts";
import { createDraft } from "./external-apps.ts";
import { listCapabilities, invokeCapability, capabilitySummary, videoStatusText } from "./capabilities.ts";
import { getAiEngine, getCustomPrompt } from "./settings.ts";
import { recordUsage, overBudget } from "./usage.ts";

const SYSTEM =
  "あなたは団体の会計・庶務を補助するLINEアシスタント『baku-office』です。日本語で簡潔に。" +
  "支出/領収書は record_expense、メモは save_memo、リマインダーは set_reminder（日時はISO 例2026-06-20T10:00）、" +
  "ナレッジ保存は save_knowledge、検索は search_knowledge、メンバー照会は search_members、領収書一覧は list_expenses、予定確認は list_reminders。" +
  "最新情報が要る質問は web_search、資料作成依頼は make_document（type=md/csv/txt）を使う。" +
  "ツールが不要な質問・雑談は通常のテキストで短く答える。" +
  "アプリ開発の依頼では、いきなり実装せず必ず①企画・仕様を整理→propose_app に name/spec/permissions/estimated_tokens を渡し、" +
  "事前確認（環境/権限/安全/コスト）を通す。確認が全てOKのときだけ実装に進む。";

// 業務道具（record_expense / list_expenses / save_memo / set_reminder / list_reminders /
// save_knowledge / search_knowledge / search_members）は各パーツが登録する（§4）。宣言は allAgentTools() から得る。
// コア組み込み道具（業務パーツではない・常時提示）。スキル生成。
const CORE_TOOLS = [
  { name: "install_skill", description: "ユーザーの要望から新しい業務スキルを設計して登録（無効状態で保存。管理者が高度なオプションで有効化）", parameters: { type: "object", properties: { request: { type: "string", description: "欲しいスキルの要望" } }, required: ["request"] } },
  { name: "propose_app", description: "アプリ（業務機能）の草案を作成。まず企画・仕様(spec)をまとめ、要求権限・推定トークンを添えて呼ぶ。保存時に実装前の事前確認（環境/権限/安全/コスト）を自動実行し、全て問題なければ実装可となる。", parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, spec: { type: "string", description: "企画・仕様（目的・データ・操作・画面・想定利用）" }, permissions: { type: "array", items: { type: "string" }, description: "要求権限（例 db:read, db:write, ai, agent, members:read, net）" }, definition: { type: "object", description: "宣言的アプリ定義（任意）" }, estimated_tokens: { type: "number", description: "1実行あたりの推定消費トークン" } }, required: ["name", "spec"] } },
];
// API依存ツール（キーがある時だけ宣言＝モデルに見せる）。
const GEMINI_TOOLS = [
  { name: "web_search", description: "最新情報をWeb検索（Google grounding）", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];
const CLAUDE_TOOLS = [
  { name: "make_document", description: "資料を生成（type=md/csv/txt）してDLリンクを返す", parameters: { type: "object", properties: { type: { type: "string" }, title: { type: "string" }, content: { type: "string" } }, required: ["title", "content"] } },
];
// マルチエージェント（Pro 以上）：スーパーバイザーが子エージェントへ委譲する道具＋他団体連携(A2A)。
const MULTI_TOOLS = [
  { name: "run_subagent", description: `専門の子エージェントに1つのタスクを委譲して結果を得る（役割: ${ROLE_LIST}）`, parameters: { type: "object", properties: { role: { type: "string" }, task: { type: "string", description: "委譲する具体的なタスク" } }, required: ["role", "task"] } },
  { name: "run_team", description: "複数タスクを子エージェントに同時並行で委譲し、結果をまとめて得る（独立タスクの並列処理に使う）", parameters: { type: "object", properties: { tasks: { type: "array", items: { type: "object", properties: { role: { type: "string" }, task: { type: "string" } }, required: ["role", "task"] } } }, required: ["tasks"] } },
  { name: "call_partner", description: "連携済みの他団体（partner=相手のライセンスID）の公開アクション（action=公開名）を呼ぶ（A2A 1:1・相互同意済みのみ）", parameters: { type: "object", properties: { partner: { type: "string", description: "相手のライセンスID" }, action: { type: "string", description: "公開アクション名" }, args: { type: "object" } }, required: ["partner", "action"] } },
  { name: "broadcast_group", description: "A2Aグループの全メンバーへ同じ公開アクション（action=公開名）を同報し、各社の結果をまとめて得る", parameters: { type: "object", properties: { group: { type: "string", description: "グループID" }, action: { type: "string", description: "公開アクション名" }, args: { type: "object" } }, required: ["group", "action"] } },
  { name: "call_group_member", description: "A2Aグループ内の特定メンバー（partner=ライセンスID）の公開アクション（action=公開名）を呼ぶ", parameters: { type: "object", properties: { group: { type: "string" }, partner: { type: "string" }, action: { type: "string", description: "公開アクション名" }, args: { type: "object" } }, required: ["group", "partner", "action"] } },
];
// 高度なオプション：有効化済みのユーザー追加スキル（要Claudeキー）。
function skillTool(names: string[]) {
  return { name: "run_skill", description: `登録済みの業務スキルを実行（利用可能: ${names.join(", ")}）`, parameters: { type: "object", properties: { name: { type: "string" }, input: { type: "string" } }, required: ["name", "input"] } };
}
// 任意API能力（設定済みのものだけツール提示）。
const CAP_TOOLS: Record<string, unknown> = {
  image_gen: { name: "generate_image", description: "画像を生成してDLリンクを返す", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
  tts: { name: "synthesize_speech", description: "テキストを音声合成してDLリンクを返す", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  video_gen: { name: "generate_video", description: "動画を生成（非同期）", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
};
const VIDEO_STATUS_TOOL = { name: "video_status", description: "依頼した動画生成の状況を確認（完成ならDLリンク）", parameters: { type: "object", properties: {} } };

async function execTool(ctx: Ctx, owner: string, baseUrl: string, name: string, args: Record<string, unknown>, role: Role, activeTools: AgentTool[]): Promise<string> {
  // 1) 有効パーツの業務道具のみ：認可（§14-1）を評価してから実行。
  const tool = activeTools.find((t) => t.name === name);
  if (tool) {
    if (tool.requiredRole && !tool.requiredRole.includes(role)) return `「${name}」を実行する権限がありません（${tool.requiredRole.join("・")}のみ）。`;
    return tool.run(ctx, owner, baseUrl, args);
  }
  // 2) コア組み込み道具（スキル・AI能力）。
  const env = ctx.env;
  switch (name) {
    case "install_skill": { const g = await generateSkill(env, owner, String(args.request ?? "")); return g.ok ? `スキル「${g.name}」を作成しました（無効状態）。管理者が高度なオプションで有効化すると使えます。` : (g.error ?? "スキル生成に失敗しました。"); }
    case "propose_app": {
      const name = String(args.name ?? "").trim();
      const spec = String(args.spec ?? "").trim();
      if (!name) return "アプリ名が必要です。";
      if (!spec) return "実装前に企画・仕様（spec）をまとめてください。";
      const perms = Array.isArray(args.permissions) ? (args.permissions as unknown[]).map(String) : [];
      const res = await createDraft(ctx, { name, description: args.description ? String(args.description) : undefined, spec, permissions: perms, definition: args.definition, estTokens: Number(args.estimated_tokens) || undefined }, owner);
      const icon = (s: string) => (s === "ok" ? "✅" : s === "warn" ? "⚠️" : "⛔");
      const lines = res.preflight.checks.map((c) => `${icon(c.status)} ${c.label}：${c.detail}`).join("\n");
      return `企画・仕様を受け付け、実装前の事前確認を実施しました（草案ID: ${res.id}）。\n${lines}\n\n` +
        (res.gate === "ready"
          ? "→ 4確認OK。実装に進めます。管理者が高度なオプション → アプリ開発でレビュー後、公開申請できます。"
          : "→ ⛔ 問題があるため実装はブロックされました。上記の指摘を解消してから再依頼してください。");
    }
    case "web_search": return (await webSearch(env, String(args.query))) ?? "web検索は未設定です。";
    case "make_document": return makeDocument(env, owner, baseUrl, { type: String(args.type ?? "md"), title: String(args.title), content: String(args.content) });
    case "run_skill": return runSkill(env, owner, baseUrl, String(args.name), String(args.input ?? ""));
    case "generate_image": return invokeCapability(env, owner, baseUrl, "image_gen", String(args.prompt));
    case "synthesize_speech": return invokeCapability(env, owner, baseUrl, "tts", String(args.text));
    case "generate_video": return invokeCapability(env, owner, baseUrl, "video_gen", String(args.prompt));
    case "video_status": return videoStatusText(env, owner, baseUrl);
    default: return "未知のツール";
  }
}

// テキスト発話 → ツールループ。最大4ホップで関数呼び出しを解決して最終テキストを返す。
// owner はデータスコープ識別子（LINE は `line:<userId>`、Web は session.uid）。呼び出し側で付与する。
// API依存ツール（web_search=Gemini／make_document=Claude）は対応キーがある時だけモデルに提示。
export async function runAgent(ctx: Ctx, owner: string, text: string, image?: { mimeType: string; dataB64: string }, baseUrl = "", role: Role = "member", opts: { history?: Turn[]; model?: "gemini" | "claude" | "local" } = {}): Promise<string> {
  const env = ctx.env;
  const geminiKey = await getApiKey(env, "gemini");
  const claudeKey = await getApiKey(env, "claude");
  if (!geminiKey && !claudeKey && !env.LOCAL_AI_BASE_URL) return "AI機能が未設定です。管理画面の『連携設定』または『高度なオプション』で Gemini か Claude のAPIキーを登録してください。";
  const hasClaude = !!claudeKey;
  const engine = await getAiEngine(env);
  const enabledSkills = hasClaude ? await listSkills(env, true) : [];
  const caps = await listCapabilities(env, true);
  const capDecls = caps.map((c) => CAP_TOOLS[c.capability]).filter(Boolean);
  if (caps.some((c) => c.capability === "video_gen")) capDecls.push(VIDEO_STATUS_TOOL);
  // 道具宣言：団体が有効化したパーツの業務道具（§5）＋コア組み込み＋API依存（キーがある時だけ）。
  const parts = enabledParts(await enabledPartIds(ctx));
  const activeTools = toolsOf(parts);
  const partDecls = activeTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  // マルチエージェント（Pro 以上）：スーパーバイザー道具を提示。
  const ent = await entitlementForGate(env).catch(() => "free" as const);
  const isPro = atLeast(ent, "pro");
  // オートパイロット（Pro＋opt-in＋トークン有＋管理者）：CF/GitHub の限定ツールを提示。
  const autonomy = isPro && role === "admin" && (await autonomyReady(env).catch(() => false));
  const decls = [...partDecls, ...CORE_TOOLS, ...GEMINI_TOOLS, ...(hasClaude ? CLAUDE_TOOLS : []), ...(isPro ? MULTI_TOOLS : []), ...(autonomy ? AUTONOMY_TOOLS : []), ...(enabledSkills.length ? [skillTool(enabledSkills.map((s) => s.name))] : []), ...capDecls];
  // 自己認識：有効な追加能力＋団体のカスタム指示（口調・人格・回答形式）をシステム文脈へ。安全制約は不変。
  const capInfo = await capabilitySummary(env);
  const custom = await getCustomPrompt(env);
  const multiNote = isPro ? "複雑な依頼は役割ごとに run_subagent へ委譲し、独立した複数タスクは run_team で並列化して、結果を統合して答える。" : "";
  const sys = [SYSTEM, multiNote, autonomy && AUTONOMY_POLICY, capInfo, custom && `団体の追加指示（口調・人格・回答形式など。安全制約は変更しない）:\n${custom}`].filter(Boolean).join("\n");

  const history = opts.history ?? [];
  const want = opts.model; // チャットごとのモデル選択（gemini/claude/local）。未指定は設定/キーで自動。

  // 使うモデルを1つに解決（予算チェック込み）。pause 時は文言を返して終了。
  let model: ChatModel | null = null;
  let provider: "gemini" | "claude" | "local" = "gemini";
  if ((want === "local" || (!geminiKey && !claudeKey)) && env.LOCAL_AI_BASE_URL) {
    model = localChatModel(env.LOCAL_AI_BASE_URL, env.LOCAL_AI_MODEL ?? "llama3.1");
    provider = "local";
  } else {
    const useClaude = !!claudeKey && (want === "claude" || (!want && (engine === "claude" || !geminiKey))) && !image;
    if (useClaude) {
      const b = await overBudget(env, "claude");
      if (b === "pause") return "Claudeの今月の利用上限に達しました（設定 → API使用量 で変更できます）。";
      if (b !== "switch_free") { await recordUsage(env, "claude"); model = claudeModel(claudeKey!); provider = "claude"; }
      else if (!geminiKey) return "Claudeの上限に達しました（Gemini未設定のため停止）。設定で上限を変更してください。";
    }
    if (!model) {
      if (!geminiKey) return "選択中のエンジンが未設定です。『設定 → 連携設定』で Gemini APIキーを登録するか、エンジンを Claude に切り替えてください。";
      const gb = await overBudget(env, "gemini");
      if (gb !== "ok") return "Geminiの今月の利用上限に達しました（設定 → API使用量 で変更できます）。";
      await recordUsage(env, "gemini"); model = geminiModel(geminiKey); provider = "gemini";
    }
  }
  const first = { text: text || "（依頼）", image: provider === "claude" ? undefined : image };

  // 子エージェント起動（同じモデルを使い回す）。役割の道具だけを見せ、ネスト委譲は不可。
  const subDeclsFor = (subTools: AgentTool[]) => [
    ...subTools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    ...GEMINI_TOOLS, ...(hasClaude ? CLAUDE_TOOLS : []),
  ] as ToolDecl[];
  async function spawn(roleStr: string, task: string): Promise<string> {
    const roleKey = normalizeRole(roleStr);
    const subTools = toolsForRole(roleKey, parts);
    const subExec = (n: string, a: Record<string, unknown>) => execTool(ctx, owner, baseUrl, n, a, role, subTools);
    await recordUsage(env, provider); // 子エージェント分のコストも計上
    return runToolLoop(model!, `${ROLES[roleKey].system}\n割り当てられたタスクのみを遂行し、結果を簡潔に返す。`, { text: task || "（タスク）" }, subDeclsFor(subTools), subExec, 3, []);
  }

  const cap = await maxParallelAgents(env);
  // スーパーバイザーの exec：マルチエージェント道具を捌き、それ以外は通常の execTool。
  const exec = async (n: string, a: Record<string, unknown>): Promise<string> => {
    if (isPro && n === "run_subagent") return spawn(String(a.role ?? "general"), String(a.task ?? ""));
    if (isPro && n === "run_team") {
      const tasks = (Array.isArray(a.tasks) ? a.tasks : []) as { role?: string; task?: string }[];
      const run = tasks.slice(0, cap);
      const out = await Promise.all(run.map((t) => spawn(String(t.role ?? "general"), String(t.task ?? ""))));
      const over = tasks.length > cap ? `\n\n（同時実行は最大${cap}件のため ${tasks.length - cap} 件は省略しました。Workers Paid で上限を拡張できます）` : "";
      return out.map((r, i) => `【${normalizeRole(String(run[i].role ?? "general"))}】\n${r}`).join("\n\n") + over;
    }
    if (isPro && n === "call_partner") {
      const r = await callPartner(env, String(a.partner ?? ""), String(a.action ?? ""), (a.args as Record<string, unknown>) ?? {});
      return r.ok ? `連携先の応答：\n${typeof r.result === "string" ? r.result : JSON.stringify(r.result)}` : `連携に失敗：${r.error ?? ""}`;
    }
    if (isPro && (n === "broadcast_group" || n === "call_group_member")) {
      const to = n === "call_group_member" ? String(a.partner ?? "") : null;
      const r = await groupRelayCall(env, String(a.group ?? ""), to, String(a.action ?? ""), (a.args as Record<string, unknown>) ?? {});
      if (!r.ok) return `グループ連携に失敗：${r.error ?? ""}`;
      const fmt = (x: { member: string; ok: boolean; result?: unknown; error?: string }) => `・${x.member}：${x.ok ? (typeof x.result === "string" ? x.result : JSON.stringify(x.result)) : "失敗（" + (x.error ?? "") + "）"}`;
      return (r.results ?? []).map(fmt).join("\n") || "対象メンバーがいません。";
    }
    if (autonomy && AUTONOMY_TOOLS.some((t) => t.name === n)) return runAutonomyTool(env, n, a);
    return execTool(ctx, owner, baseUrl, n, a, role, activeTools);
  };

  const hops = await agentMaxHops(env);
  return runToolLoop(model, sys, first, decls as ToolDecl[], exec, hops, history);
}

// LINE署名検証（HMAC-SHA256・定数時間比較）。
export async function verifyLineSignature(secret: string, body: string, signature: string): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  if (expected.length !== signature.length) return false;
  let r = 0;
  for (let i = 0; i < expected.length; i++) r |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return r === 0;
}

// LINE 返信／プッシュ。
export async function lineReply(accessToken: string, replyToken: string, text: string): Promise<void> {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
}
export async function linePush(accessToken: string, to: string, text: string): Promise<void> {
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
}

// LINE画像メッセージの本体を取得（OCR用）。
export async function fetchLineImage(accessToken: string, messageId: string): Promise<{ mimeType: string; dataB64: string } | null> {
  const r = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return null;
  const buf = await r.arrayBuffer();
  const mimeType = r.headers.get("content-type") ?? "image/jpeg";
  const dataB64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return { mimeType, dataB64 };
}
