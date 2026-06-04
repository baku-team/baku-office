import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { createSkill, setSkillEnabled, deleteSkill } from "../../lib/skills.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// Agent Skills 管理（高度なオプション・管理者のみ）。任意コード実行を含むため承認制。
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; id?: string; name?: string; description?: string; skill_md?: string; mode?: string; enabled?: boolean };

  switch (b._action) {
    case "create":
      if (!b.name || !b.skill_md) return json({ error: "name と skill_md が必要" }, 400);
      return json({ ok: true, id: await createSkill(env, ses.uid, { name: b.name, description: b.description, skill_md: b.skill_md, mode: b.mode ?? "instruction" }) });
    case "enable":
      if (b.id) await setSkillEnabled(env, b.id, !!b.enabled);
      return json({ ok: true });
    case "delete":
      if (b.id) await deleteSkill(env, b.id);
      return json({ ok: true });
    default:
      return json({ error: "不明な操作" }, 400);
  }
};
