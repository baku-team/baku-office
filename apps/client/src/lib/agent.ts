// Zプランの会計・庶務エージェント（設計書§2/付録B）。
// 既存LINEエージェントの思想を、新データモデル（personal_items/transactions/knowledge）へマップした集約版。
// 保存済みAPIキー（連携設定・暗号化KV）を復号して使用。まずは Gemini（無料スタック）で会話＋構造化アクション。
import { randomId } from "@baku-office/shared";
import { getApiKey } from "./client.ts";
import { nowSec } from "./accounting.ts";

const SYSTEM =
  "あなたは団体の会計・庶務を補助するLINEアシスタント『baku-office』です。日本語で簡潔に。" +
  "ユーザーの発話が支出/領収書なら JSON だけを返す: {\"action\":\"expense\",\"amount\":数値,\"title\":\"店名や用途\",\"date\":\"YYYY-MM-DD\"}。" +
  "メモ/備忘なら {\"action\":\"memo\",\"title\":\"内容\"}。" +
  "それ以外の質問・雑談は action を使わず、通常の短い日本語テキストで答える。JSONを返すときは前後に文章を付けない。";

// Gemini で1ターン応答（テキスト）。
async function geminiOnce(geminiKey: string, userText: string): Promise<string> {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiKey)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: { maxOutputTokens: 400, temperature: 0.4 },
      }),
    },
  );
  if (!r.ok) return "（AIの応答に失敗しました）";
  const data = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "（応答が空でした）";
}

type Action = { action: "expense"; amount: number; title: string; date?: string } | { action: "memo"; title: string };
function parseAction(text: string): Action | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Action;
    if (o.action === "expense" && typeof o.amount === "number") return o;
    if (o.action === "memo" && typeof o.title === "string") return o;
  } catch { /* not json */ }
  return null;
}

// エージェント実行：LINE発話 → 会話 or 構造化アクション（personal_items へ記録）→ 返信文。
export async function runAgent(env: Env, lineUserId: string, text: string): Promise<string> {
  const geminiKey = await getApiKey(env, "gemini");
  if (!geminiKey) return "AI機能が未設定です。管理画面の『連携設定』で Gemini APIキーを登録してください。";

  const raw = await geminiOnce(geminiKey, text);
  const act = parseAction(raw);
  const owner = `line:${lineUserId}`;

  if (act?.action === "expense") {
    await env.DB.prepare(
      "INSERT INTO personal_items (id,owner_user_id,type,title,amount,date,share_scope,review_status,created_at) VALUES (?,?,?,?,?,?,'personal','none',?)",
    )
      .bind(randomId(), owner, "receipt", act.title, Math.round(act.amount), act.date ?? new Date().toISOString().slice(0, 10), nowSec())
      .run();
    return `📝 領収書として記録しました：${act.title} ¥${Math.round(act.amount).toLocaleString("ja-JP")}\n（管理画面の個人→「組織へ共有」で会計に申請できます）`;
  }
  if (act?.action === "memo") {
    await env.DB.prepare(
      "INSERT INTO personal_items (id,owner_user_id,type,title,share_scope,review_status,created_at) VALUES (?,?,?,?,'personal','none',?)",
    )
      .bind(randomId(), owner, "memo", act.title, nowSec())
      .run();
    return `🗒 メモしました：${act.title}`;
  }
  return raw;
}

// LINE署名検証（HMAC-SHA256）。
export async function verifyLineSignature(secret: string, body: string, signature: string): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === signature;
}

// LINE 返信（Reply API）。
export async function lineReply(accessToken: string, replyToken: string, text: string): Promise<void> {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text: text.slice(0, 4900) }] }),
  });
}
