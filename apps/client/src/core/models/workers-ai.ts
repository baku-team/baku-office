// Cloudflare Workers AI アダプタ（CF上で稼働＝ローカル/クラウドAI）。env.AI.run で text-generation を叩く。
// 入力は最も互換性の高い prompt 文字列形式（messages+tools は一部モデルのスキーマで弾かれるため）。
// ＝ツール実行は行わない簡易チャット。応答 usage から実費・ニューロンを推定する。
import type { ChatModel, Turn, ToolDecl, TokenUsage } from "../ai.ts";

type AiBinding = { run: (model: string, inputs: unknown, options?: unknown) => Promise<unknown> };
type AiResp = {
  response?: string;
  result?: { response?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

// 中立履歴を1本のプロンプト文字列へ（system＋会話＋"Assistant:" で続きを書かせる）。
function toPrompt(system: string, history: Turn[]): string {
  const lines: string[] = [];
  for (const t of history) {
    if (t.role === "user") lines.push("User: " + t.text);
    else if (t.role === "assistant") { if (t.text) lines.push("Assistant: " + t.text); }
    else for (const r of t.results) lines.push(`Tool(${r.name}): ${r.content}`);
  }
  return `${system}\n\n${lines.join("\n")}\nAssistant:`;
}

// 軽量モデルは自分の回答後に "User:"/"Assistant:" 等の偽ターンを捏造して続け、1メッセージ内で
// 会話をループさせがち（stopトークン非対応のモデルがある）。最初のロールマーカー以降を切り捨て、
// 当該ターンのアシスタント応答だけを残す。WHY: stop 指定が効かないモデルでも確実に止める保険。
const ROLE_MARKERS = ["\nUser:", "\nAssistant:", "\nTool(", "\nSystem:", "\nuser:", "\nassistant:"];
const STOP_SEQUENCES = ["\nUser:", "\nAssistant:", "\nTool(", "User:", "Assistant:"];
function firstTurnOnly(text: string): string {
  let cut = text.length;
  for (const m of ROLE_MARKERS) {
    const i = text.indexOf(m);
    if (i >= 0 && i < cut) cut = i;
  }
  return text.slice(0, cut).trim();
}

export function workersAiChatModel(ai: AiBinding, model: string): ChatModel {
  return {
    name: `workers-ai:${model}`,
    // tools は受け取るが Workers AI には渡さない（互換性優先・ツール実行なし）。
    async turn(system, history, _tools: ToolDecl[]) {
      let resp: AiResp;
      try {
        resp = (await ai.run(model, { prompt: toPrompt(system, history), max_tokens: 1024, stream: false, stop: STOP_SEQUENCES, repetition_penalty: 1.1 })) as AiResp;
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        console.log("[workers-ai]", msg);
        return { text: `（Workers AI の応答に失敗しました：${msg.slice(0, 140)}）` };
      }
      const data: AiResp = resp?.result ? { ...resp, ...resp.result } : resp;
      const usage: TokenUsage = { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 };
      return { text: firstTurnOnly(data.response ?? ""), usage };
    },
  };
}
