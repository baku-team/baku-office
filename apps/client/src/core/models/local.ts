// ローカルLLM アダプタ（移植性アーキ §3・Profile C）。OpenAI互換 /v1/chat/completions を叩く
// （Ollama / llama.cpp server / LM Studio 等）。外部送信ゼロのオフライン運用に使う。
import type { ChatModel, Turn, ToolDecl, ToolCall } from "../ai.ts";

type OaiMsg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

function toMessages(system: string, history: Turn[]): OaiMsg[] {
  const msgs: OaiMsg[] = [{ role: "system", content: system }];
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

export function localChatModel(baseUrl: string, model: string): ChatModel {
  const url = baseUrl.replace(/\/$/, "") + "/v1/chat/completions";
  return {
    name: `local:${model}`,
    async turn(system, history, tools) {
      const body = {
        model,
        messages: toMessages(system, history),
        tools: tools.map((d: ToolDecl) => ({ type: "function", function: { name: d.name, description: d.description, parameters: d.parameters } })),
        temperature: 0.3,
      };
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { console.log("[local-llm]", r.status, (await r.text()).slice(0, 200)); return { text: "（ローカルLLMの応答に失敗しました）" }; }
      const data = (await r.json()) as { choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
      const msg = data.choices?.[0]?.message;
      const calls = msg?.tool_calls ?? [];
      if (calls.length) {
        const toolCalls: ToolCall[] = calls.map((c) => {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* 引数パース失敗は空扱い */ }
          return { id: c.id, name: c.function.name, args };
        });
        return { text: msg?.content ?? undefined, toolCalls };
      }
      return { text: msg?.content ?? "" };
    },
  };
}
