// Claude アダプタ（移植性アーキ §2.3）。Anthropic Messages API のツールループを ChatModel 契約へ移植。
// wire 形式（tools=input_schema / tool_use / tool_result / model claude-sonnet-4-6）は従来どおり。画像は非対応（Geminiパス）。
import type { ChatModel, Turn, ToolDecl, ToolCall } from "../ai.ts";
import { DEFAULT_MODELS } from "./config.ts";

type CBlock = { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: string };

function toMessages(history: Turn[]): { role: string; content: unknown }[] {
  const msgs: { role: string; content: unknown }[] = [];
  for (const t of history) {
    if (t.role === "user") {
      msgs.push({ role: "user", content: t.text || "（依頼）" });
    } else if (t.role === "assistant") {
      const blocks: CBlock[] = [];
      if (t.text) blocks.push({ type: "text", text: t.text });
      for (const c of t.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      msgs.push({ role: "assistant", content: blocks });
    } else {
      msgs.push({ role: "user", content: t.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content })) });
    }
  }
  return msgs;
}

export function claudeModel(key: string, modelId: string = DEFAULT_MODELS.claude): ChatModel {
  return {
    name: modelId,
    async turn(system, history, tools) {
      const t = (tools as ToolDecl[]).map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters }));
      let r: Response;
      try {
        r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: modelId, max_tokens: 1500, system, tools: t, messages: toMessages(history) }),
        });
      } catch (e) { return { error: { message: "claude network: " + ((e as Error).message ?? String(e)) } }; }
      if (!r.ok) { const body = (await r.text()).slice(0, 200); console.log("[claude]", r.status, body); return { error: { status: r.status, message: `claude ${r.status}: ${body}` } }; }
      const data = (await r.json()) as { content?: CBlock[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      const usage = { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 };
      const content = data.content ?? [];
      const toolUses = content.filter((c) => c.type === "tool_use");
      if (toolUses.length && data.stop_reason === "tool_use") {
        const toolCalls: ToolCall[] = toolUses.map((c) => ({ id: c.id!, name: c.name!, args: c.input ?? {} }));
        return { toolCalls, usage };
      }
      return { text: content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""), usage };
    },
  };
}
