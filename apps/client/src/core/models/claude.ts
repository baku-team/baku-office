// Claude アダプタ（移植性アーキ §2.3）。Anthropic Messages API のツールループを ChatModel 契約へ移植。
// wire 形式（tools=input_schema / tool_use / tool_result / model claude-sonnet-4-6）は従来どおり。画像は非対応（Geminiパス）。
import type { ChatModel, Turn, ToolDecl, ToolCall } from "../ai.ts";

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

export function claudeModel(key: string): ChatModel {
  return {
    name: "claude-sonnet-4-6",
    async turn(system, history, tools) {
      const t = (tools as ToolDecl[]).map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters }));
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1500, system, tools: t, messages: toMessages(history) }),
      });
      if (!r.ok) { console.log("[claude]", r.status, (await r.text()).slice(0, 200)); return { text: "（Claudeの応答に失敗しました）" }; }
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
