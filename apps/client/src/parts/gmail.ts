// Gmail 連携パーツ（Pro以上）。統合 Google 連携（lib/google.ts）の access token で Gmail API を
// オンデマンド呼び出し。メールの一覧・検索・本文取得・送信。PII を扱うため要約・引用は呼び出し側で配慮。
import type { Part } from "../core/parts.ts";
import type { Ctx } from "../core/ports.ts";

const GM = "https://gmail.googleapis.com/gmail/v1/users/me";
const NEED_CONNECT = "Google 連携が未設定です。連携設定（Gmail画面）から連携してください。";

// base64url（送信用）。UTF-8バイト列 → base64url。
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// base64url デコード（受信本文用）→ UTF-8 文字列。
function decodeB64url(data: string): string {
  const s = data.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bin = atob(s);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch { return ""; }
}

type GmPart = { mimeType?: string; filename?: string; body?: { data?: string; attachmentId?: string }; parts?: GmPart[] };
function extractText(p: GmPart | undefined): string {
  if (!p) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return decodeB64url(p.body.data);
  for (const c of p.parts ?? []) { const t = extractText(c); if (t) return t; }
  // text/plain が無ければ html を素のまま（タグ除去は最小限）
  if (p.mimeType === "text/html" && p.body?.data) return decodeB64url(p.body.data).replace(/<[^>]+>/g, " ");
  return "";
}

async function listMessages(ctx: Ctx, a: { query?: string; max?: number }): Promise<string> {
  const u = new URL(`${GM}/messages`);
  u.searchParams.set("maxResults", String(Math.min(a.max ?? 10, 25)));
  if (a.query) u.searchParams.set("q", a.query);
  else u.searchParams.set("labelIds", "INBOX");
  const r = await ctx.google.fetch(u.toString());
  if (!r) return NEED_CONNECT;
  if (!r.ok) return `メール一覧の取得に失敗しました（${r.status}）。`;
  const d = (await r.json()) as { messages?: { id: string }[] };
  const ids = (d.messages ?? []).map((m) => m.id);
  if (!ids.length) return "該当するメールはありません。";
  const lines: string[] = [];
  for (const id of ids) {
    const mr = await ctx.google.fetch(`${GM}/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
    if (!mr || !mr.ok) continue;
    const m = (await mr.json()) as { snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
    const h = (n: string) => m.payload?.headers?.find((x) => x.name === n)?.value ?? "";
    lines.push(`・[${id}] ${h("From")}\n  件名: ${h("Subject")}\n  ${(m.snippet ?? "").slice(0, 120)}`);
  }
  return lines.join("\n") || "メールを取得できませんでした。";
}

async function getMessage(ctx: Ctx, a: { message_id: string }): Promise<string> {
  const r = await ctx.google.fetch(`${GM}/messages/${encodeURIComponent(a.message_id)}?format=full`);
  if (!r) return NEED_CONNECT;
  if (!r.ok) return `メール本文の取得に失敗しました（${r.status}）。`;
  const m = (await r.json()) as { payload?: GmPart & { headers?: { name: string; value: string }[] } };
  const h = (n: string) => m.payload?.headers?.find((x) => x.name === n)?.value ?? "";
  const body = extractText(m.payload).slice(0, 4000);
  return `差出人: ${h("From")}\n件名: ${h("Subject")}\n日時: ${h("Date")}\n\n${body}`;
}

async function sendMessage(ctx: Ctx, a: { to: string; subject: string; body: string }): Promise<string> {
  const enc = new TextEncoder();
  const subjB64 = btoa(String.fromCharCode(...enc.encode(a.subject)));
  const raw = [
    `To: ${a.to}`,
    `Subject: =?UTF-8?B?${subjB64}?=`,
    'Content-Type: text/plain; charset="UTF-8"',
    "MIME-Version: 1.0",
    "",
    a.body,
  ].join("\r\n");
  const r = await ctx.google.fetch(`${GM}/messages/send`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ raw: b64url(enc.encode(raw)) }),
  });
  if (!r) return NEED_CONNECT;
  if (!r.ok) return `メール送信に失敗しました（${r.status}）。`;
  return `メールを送信しました：${a.to} 宛「${a.subject}」`;
}

// メール本文を辿って最初の添付（filename+attachmentId を持つ part）を見つける。
function findAttachment(p: GmPart | undefined): { attachmentId: string; filename: string; mimeType: string } | null {
  if (!p) return null;
  if (p.filename && p.body?.attachmentId) return { attachmentId: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType ?? "application/octet-stream" };
  for (const c of p.parts ?? []) { const f = findAttachment(c); if (f) return f; }
  return null;
}
// メールの添付（PDF/画像）を取得してストレージへ保存し file_id を返す（請求書登録などに使う）。
async function getAttachment(ctx: Ctx, owner: string, a: { message_id: string }): Promise<string> {
  const mr = await ctx.google.fetch(`${GM}/messages/${encodeURIComponent(a.message_id)}?format=full`);
  if (!mr) return NEED_CONNECT;
  if (!mr.ok) return `メールの取得に失敗しました（${mr.status}）。`;
  const m = (await mr.json()) as { payload?: GmPart };
  const found = findAttachment(m.payload);
  if (!found) return "このメールに添付ファイルはありません。";
  const ar = await ctx.google.fetch(`${GM}/messages/${encodeURIComponent(a.message_id)}/attachments/${found.attachmentId}`);
  if (!ar) return NEED_CONNECT;
  if (!ar.ok) return `添付の取得に失敗しました（${ar.status}）。`;
  const ad = (await ar.json()) as { data?: string };
  if (!ad.data) return "添付データが空です。";
  const bin = atob(ad.data.replace(/-/g, "+").replace(/_/g, "/"));
  const file = new File([Uint8Array.from(bin, (c) => c.charCodeAt(0))], found.filename || "attachment", { type: found.mimeType });
  const saved = await ctx.storage.saveFile(file, owner);
  return `添付「${found.filename}」を保存しました: file_id=${saved.id}`;
}

export const gmailPart: Part = {
  id: "gmail",
  name: "Gmail",
  version: "1.0.0",
  category: "庶務",
  description: "Gmail のメールを一覧・検索・閲覧・送信。",
  permissions: ["net", "storage:write"], // 添付の保存に storage:write が必要。

  minPlan: "pro",
  menu: [{ href: "/gmail", label: "Gmail" }],
  agentTools: [
    {
      name: "list_messages",
      description: "受信メールを一覧（query 未指定なら受信箱の最近分）",
      parameters: { type: "object", properties: { query: { type: "string", description: "Gmail検索クエリ（例 from:foo is:unread）" }, max: { type: "number" } } },
      run: (ctx, _o, _b, a) => listMessages(ctx, { query: a.query as string, max: a.max as number }),
    },
    {
      name: "search_messages",
      description: "Gmail を検索（query 必須）",
      parameters: { type: "object", properties: { query: { type: "string" }, max: { type: "number" } }, required: ["query"] },
      run: (ctx, _o, _b, a) => listMessages(ctx, { query: String(a.query), max: a.max as number }),
    },
    {
      name: "get_message",
      description: "メール本文を取得（message_id 指定）",
      parameters: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] },
      run: (ctx, _o, _b, a) => getMessage(ctx, { message_id: String(a.message_id) }),
    },
    {
      name: "send_message",
      description: "メールを送信",
      unattended: false, // 無人ジョブでメール送信させない（プロンプトインジェクション対策・道具レベル遮断）
      parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"] },
      run: (ctx, _o, _b, a) => sendMessage(ctx, { to: String(a.to), subject: String(a.subject), body: String(a.body) }),
    },
    {
      name: "get_attachment",
      description: "メールの添付ファイル(PDF/画像)を取得してストレージへ保存し file_id を返す（請求書登録等に使う）",
      parameters: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] },
      run: (ctx, owner, _b, a) => getAttachment(ctx, owner, { message_id: String(a.message_id) }),
    },
  ],
};
