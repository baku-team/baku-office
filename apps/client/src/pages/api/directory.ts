import type { APIRoute } from "astro";
import { atLeast } from "@baku-office/shared";
import { getSession } from "../../lib/auth.ts";
import { cachedEntitlement } from "../../lib/client.ts";
import { kvPut } from "../../lib/kv.ts";
import { getPublicProfile, setPublicProfile, orgDisplayName, verifyOrgExistence, publishDirectory, unpublishDirectory, myDirectory, searchDirectory, reportDirectory, type Verification } from "../../lib/directory.ts";
import { listActions, createAction, deleteAction } from "../../lib/a2a-actions.ts";
import { getReceptionPolicy, setReceptionPolicy } from "../../lib/settings.ts";
import { listInquiries, decideInquiry, getInquiry, addBlock } from "../../lib/reception.ts";
import { establishPublicConnection, callPublic, sendInquiry } from "../../lib/a2a.ts";
import { generateOrgProfile } from "../../lib/media-ai.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 公開ディレクトリ管理（管理者・Plus 以上）：プロフィール/AI生成/実在検証/公開/探索/通報/受付ポリシー/公開アクション/受付箱。
export const POST: APIRoute = async ({ request, locals }) => {
  const ctx = locals.ctx;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  if (!atLeast(await cachedEntitlement(env), "plus")) return json({ error: "公開・探索は Plus 以上で利用できます" }, 402);
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const a = String(b._action ?? "");

  // プロフィール
  if (a === "profile_get") return json({ ok: true, profile: await getPublicProfile(ctx), orgName: await orgDisplayName(ctx), policy: await getReceptionPolicy(env), actions: await listActions(ctx), verification: JSON.parse((await env.LICENSE.get("directory_verification")) || "null"), mine: await myDirectory(env) });
  if (a === "profile_save") return json({ ok: true, profile: await setPublicProfile(ctx, { summary: b.summary as string, tags: b.tags as string[], contact: b.contact as string, website: b.website as string }) });
  if (a === "profile_generate") {
    const draft = await generateOrgProfile(env, { orgName: await orgDisplayName(ctx), hints: String(b.hints ?? "") });
    return draft ? json({ ok: true, draft }) : json({ ok: true, draft: null });
  }
  // 実在検証（結果をKVへ保存し公開時に同梱）
  if (a === "verify") {
    const p = await getPublicProfile(ctx);
    const v: Verification = await verifyOrgExistence(env, { orgName: await orgDisplayName(ctx), website: p.website });
    await kvPut(env, "directory_verification", JSON.stringify(v));
    return json({ ok: true, verification: v });
  }
  // 公開/取り下げ
  if (a === "publish") {
    const v = JSON.parse((await env.LICENSE.get("directory_verification")) || "null");
    return json(await publishDirectory(env, ctx, { listed: true, verification: v ?? undefined }));
  }
  if (a === "unpublish") return json(await unpublishDirectory(env));
  // 探索・通報・公開連絡
  if (a === "search") return json(await searchDirectory(env, String(b.query ?? ""), Array.isArray(b.tags) ? (b.tags as string[]) : undefined));
  if (a === "report") return json(await reportDirectory(env, String(b.target ?? ""), String(b.reason ?? "spam"), b.detail ? String(b.detail) : undefined));
  if (a === "send_inquiry") return json(await sendInquiry(env, String(b.to ?? ""), String(b.message ?? "")));
  if (a === "call_public") return json(await callPublic(env, String(b.to ?? ""), String(b.action ?? ""), (b.args ?? {}) as Record<string, unknown>));
  // 受付ポリシー
  if (a === "reception_get") return json({ ok: true, policy: await getReceptionPolicy(env) });
  if (a === "reception_set") return json({ ok: true, policy: await setReceptionPolicy(env, b as Record<string, never>) });
  // 公開アクション（Plus でも公開受付用に限定して作成・削除可）
  if (a === "pub_add") {
    if (!b.name || !b.declType) return json({ error: "name / declType が必要" }, 400);
    const spec = { type: String(b.declType), config: (b.config ?? {}) as Record<string, unknown>, label: String(b.label ?? b.name) };
    return json({ ok: true, id: await createAction(ctx, { name: String(b.name), kind: "decl", spec, scope: "public" }) });
  }
  if (a === "pub_remove") { await deleteAction(ctx, String(b.id ?? "")); return json({ ok: true }); }
  // 受付箱
  if (a === "inquiry_list") return json({ ok: true, inquiries: await listInquiries(ctx, b.status ? String(b.status) : undefined) });
  if (a === "inquiry_decide") {
    const inq = await getInquiry(ctx, String(b.id ?? ""));
    if (!inq) return json({ error: "見つかりません" }, 404);
    const decision = String(b.decision ?? "");
    if (decision === "blocked") await addBlock(ctx, inq.from_license, "受付箱でブロック");
    await decideInquiry(ctx, inq.id, decision === "approved" ? "approved" : decision === "blocked" ? "blocked" : "rejected");
    // 承認時：相手を恒久接続へ昇格（以後は通常の接続経路で双方向にやり取りできる）。
    let established = false;
    if (decision === "approved" && inq.from_license) { const e = await establishPublicConnection(env, inq.from_license); established = e.ok; }
    return json({ ok: true, established });
  }
  return json({ error: "不明な操作" }, 400);
};
