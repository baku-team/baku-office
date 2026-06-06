// AIプロバイダ抽象（移植性アーキ §2.3）：モデル非依存のツールループ。
// CF(Gemini/Claude) も Profile C のローカルLLM(OAI互換) も、同じ ChatModel 契約・同じループで動く。
// 会話履歴は中立表現（Turn）で持ち、各モデルアダプタが自分の wire 形式へ変換する。

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };
export type Turn =
  | { role: "user"; text: string; image?: { mimeType: string; dataB64: string } }
  | { role: "assistant"; text?: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: { id: string; name: string; content: string }[] };

export type ToolDecl = { name: string; description: string; parameters: unknown };

export interface ChatModel {
  name: string;
  // 1ターン：system＋中立履歴＋道具宣言 → アシスタント応答（テキスト or 道具呼び出し）。
  turn(system: string, history: Turn[], tools: ToolDecl[]): Promise<{ text?: string; toolCalls?: ToolCall[] }>;
}

// モデル非依存のツールループ。最大 maxHops 回、道具呼び出しを解決して最終テキストを返す。
export async function runToolLoop(
  model: ChatModel,
  system: string,
  first: { text: string; image?: { mimeType: string; dataB64: string } },
  tools: ToolDecl[],
  exec: (name: string, args: Record<string, unknown>) => Promise<string>,
  maxHops = 4,
): Promise<string> {
  const history: Turn[] = [{ role: "user", text: first.text, image: first.image }];
  for (let h = 0; h < maxHops; h++) {
    const res = await model.turn(system, history, tools);
    if (!res.toolCalls?.length) return (res.text ?? "").trim() || "（応答が空でした）";
    history.push({ role: "assistant", text: res.text, toolCalls: res.toolCalls });
    const results = [];
    for (const c of res.toolCalls) results.push({ id: c.id, name: c.name, content: await exec(c.name, c.args) });
    history.push({ role: "tool", results });
  }
  return "処理が長くなりました。もう一度お試しください。";
}
