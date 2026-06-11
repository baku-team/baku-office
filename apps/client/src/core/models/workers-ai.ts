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

export function workersAiChatModel(ai: AiBinding, model: string): ChatModel {
  return {
    name: `workers-ai:${model}`,
    // tools は受け取るが Workers AI には渡さない（互換性優先・ツール実行なし）。
    async turn(system, history, _tools: ToolDecl[]) {
      let resp: AiResp;
      try {
        resp = (await ai.run(model, { prompt: toPrompt(system, history), max_tokens: 1024, stream: false })) as AiResp;
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        console.log("[workers-ai]", msg);
        return { text: `（Workers AI の応答に失敗しました：${msg.slice(0, 140)}）` };
      }
      const data: AiResp = resp?.result ? { ...resp, ...resp.result } : resp;
      const usage: TokenUsage = { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 };
      return { text: (data.response ?? "").trim(), usage };
    },
  };
}
