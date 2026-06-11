// Cloudflare Workers AI アダプタ（CF上で稼働＝ローカル/クラウドAI）。env.AI.run で text-generation を叩く。
// OpenAI互換の messages/tools 形式。応答 usage（prompt/completion tokens）から実費・ニューロンを推定。
import type { ChatModel, Turn, ToolDecl, ToolCall, TokenUsage } from "../ai.ts";

type AiBinding = { run: (model: string, inputs: unknown, options?: unknown) => Promise<unknown> };
type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

function toMessages(system: string, history: Turn[]): Msg[] {
  const msgs: Msg[] = [{ role: "system", content: system }];
  for (const t of history) {
    if (t.role === "user") msgs.push({ role: "user", content: t.text });
    else if (t.role === "assistant") {
      msgs.push({
        role: "assistant",
        content: t.text ?? null,
        tool_calls: t.toolCalls?.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
      });
    } else {
      for (const r of t.results) msgs.push({ role: "tool", tool_call_id: r.id, content: r.content });
    }
  }
  return msgs;
}

type AiResp = {
  response?: string;
  result?: { response?: string; tool_calls?: unknown[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  // Workers AI の function calling 応答（モデルにより name/arguments の形が異なるため両対応）。
  tool_calls?: { id?: string; name?: string; arguments?: unknown; function?: { name: string; arguments: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export function workersAiChatModel(ai: AiBinding, model: string): ChatModel {
  return {
    name: `workers-ai:${model}`,
    async turn(system, history, tools) {
      const inputs: Record<string, unknown> = {
        messages: toMessages(system, history),
        max_tokens: 1024,
        stream: false,
      };
      // 道具がある時だけ tools を渡す（tool 非対応モデルでの失敗を避ける）。
      if (tools.length) inputs.tools = tools.map((d: ToolDecl) => ({ type: "function", function: { name: d.name, description: d.description, parameters: d.parameters } }));
      let raw0: AiResp;
      try {
        raw0 = (await ai.run(model, inputs)) as AiResp;
      } catch (e) {
        const msg = (e as Error)?.message ?? String(e);
        console.log("[workers-ai]", msg);
        return { text: `（Workers AI の応答に失敗しました：${msg.slice(0, 140)}）` };
      }
      // バインディングは通常 {response,...} を返すが、念のため {result:{...}} ラッパにも対応。
      const data: AiResp = raw0?.result ? { ...raw0, ...raw0.result } as AiResp : raw0;
      const usage: TokenUsage = { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 };
      const raw = data.tool_calls ?? [];
      if (raw.length) {
        const toolCalls: ToolCall[] = raw.map((c, i) => {
          const name = c.name ?? c.function?.name ?? "";
          const argsRaw = c.arguments ?? c.function?.arguments ?? {};
          let args: Record<string, unknown> = {};
          if (typeof argsRaw === "string") { try { args = JSON.parse(argsRaw || "{}"); } catch { /* 空扱い */ } }
          else if (argsRaw && typeof argsRaw === "object") args = argsRaw as Record<string, unknown>;
          return { id: c.id ?? `wai_${i}`, name, args };
        }).filter((c) => c.name);
        if (toolCalls.length) return { text: data.response || undefined, toolCalls, usage };
      }
      return { text: data.response ?? "", usage };
    },
  };
}
