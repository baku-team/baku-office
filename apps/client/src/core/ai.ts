// AIプロバイダ抽象（移植性アーキ §2.3）：モデル非依存のツールループ。
// CF(Gemini/Claude) も Profile C のローカルLLM(OAI互換) も、同じ ChatModel 契約・同じループで動く。
// 会話履歴は中立表現（Turn）で持ち、各モデルアダプタが自分の wire 形式へ変換する。

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type Turn =
  | { role: "user"; text: string; image?: { mimeType: string; dataB64: string } }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: { id: string; name: string; content: string }[] };

export type ToolDecl = { name: string; description: string; parameters: unknown };

// 1ターンの消費トークン（実費計測用・P0-2）。アダプタが応答の usage から埋める。
export type TokenUsage = { inputTokens: number; outputTokens: number };

export interface ChatModel {
  name: string;
  // 1ターン：system＋中立履歴＋道具宣言 → アシスタント応答（テキスト or 道具呼び出し／消費token）。
  turn(system: string, history: Turn[], tools: ToolDecl[]): Promise<{ text?: string; toolCalls?: ToolCall[]; usage?: TokenUsage }>;
}

// モデル非依存のツールループ。最大 maxHops 回、道具呼び出しを解決して最終テキストを返す。
export async function runToolLoop(
  model: ChatModel,
  system: string,
  first: { text: string; image?: { mimeType: string; dataB64: string } },
  tools: ToolDecl[],
  exec: (name: string, args: Record<string, unknown>) => Promise<string>,
  maxHops = 4,
  priorHistory: Turn[] = [],
  // 各ターンの消費tokenを受け取るシンク（実費計測・P0-2）。複数hop/子エージェント分も合算できる。
  onUsage?: (u: TokenUsage) => void,
): Promise<string> {
  const history: Turn[] = [...priorHistory, { role: "user", text: first.text, image: first.image }];
  for (let h = 0; h < maxHops; h++) {
    const res = await model.turn(system, history, tools);
    if (res.usage && onUsage) onUsage(res.usage);
    if (!res.toolCalls?.length) return (res.text ?? "").trim() || "（応答が空でした）";
    history.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls });
    // 1ターンに複数の道具呼び出しが来たら並列実行（スーパーバイザーが子エージェントを同時 delegate＝並列）。
    const calls = res.toolCalls;
    const results = calls.length > 1
      ? await Promise.all(calls.map(async (c) => ({ id: c.id, name: c.name, content: await exec(c.name, c.args) })))
      : [{ id: calls[0].id, name: calls[0].name, content: await exec(calls[0].name, calls[0].args) }];
    history.push({ role: "tool", results });
  }
  return "処理が長くなりました。もう一度お試しください。";
}
