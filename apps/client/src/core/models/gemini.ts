// Gemini アダプタ（移植性アーキ §2.3）。既存の generateContent function-calling を ChatModel 契約へ移植。
// wire 形式（systemInstruction / contents / functionCall / functionResponse / generationConfig）は従来どおり。
import type { ChatModel, Turn, ToolDecl, ToolCall } from "../ai.ts";

type GPart = { text?: string; functionCall?: { name: string; args: Record<string, unknown> }; functionResponse?: { name: string; response: unknown }; inlineData?: { mimeType: string; data: string } };
type GContent = { role: string; parts: GPart[] };

function toContents(history: Turn[]): GContent[] {
  const out: GContent[] = [];
  for (const t of history) {
    if (t.role === "user") {
      const parts: GPart[] = [{ text: t.text || "（画像）" }];
      if (t.image) parts.push({ inlineData: { mimeType: t.image.mimeType, data: t.image.dataB64 } });
      out.push({ role: "user", parts });
    } else if (t.role === "assistant") {
      const parts: GPart[] = [];
      if (t.text) parts.push({ text: t.text });
      for (const c of t.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args } });
      out.push({ role: "model", parts });
    } else {
      // 関数結果は name で対応づけ（Gemini は id を使わない）。
      out.push({ role: "user", parts: t.results.map((r) => ({ functionResponse: { name: r.name, response: { result: r.content } } })) });
    }
  }
  return out;
}

export function geminiModel(key: string): ChatModel {
  return {
    name: "gemini-2.5-flash",
    async turn(system, history, tools) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: toContents(history), tools: [{ functionDeclarations: tools as ToolDecl[] }], generationConfig: { temperature: 0.3, maxOutputTokens: 800 } }),
      });
      if (!r.ok) { console.log("[gemini]", r.status, (await r.text()).slice(0, 200)); return { text: "（AIの応答に失敗しました）" }; }
      const data = (await r.json()) as { candidates?: { content?: GContent }[] };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const calls = parts.filter((p) => p.functionCall);
      if (calls.length) {
        const toolCalls: ToolCall[] = calls.map((p, i) => ({ id: `g${i}_${p.functionCall!.name}`, name: p.functionCall!.name, args: p.functionCall!.args ?? {} }));
        return { toolCalls };
      }
      return { text: parts.map((p) => p.text ?? "").join("") };
    },
  };
}
