import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { setMaxUploadMb, setRetentionDays } from "../../lib/storage.ts";
import { setAiEngine, setCustomPrompt, setWorkersPaid, setNotifyWebhook, setWorkersAiModel, setBookkeepingMode } from "../../lib/settings.ts";
import { setAutonomy, saveAutonomyConfig } from "../../lib/autonomy.ts";
import { setStorageLimits } from "../../lib/storage-usage.ts";
import { partCatalog, enabledPartIds, setEnabledPartIds } from "../../core/parts.ts";
import { setTheme } from "../../core/theme.ts";
import { setNavOverrides } from "../../core/nav.ts";
import { setHomeLayout } from "../../core/home.ts";
import { setCustomDomain } from "../../core/custom-domain.ts";
import { nowSec } from "../../lib/accounting.ts";
import { appCatalog, installApp, uninstallApp, installedAppIds } from "../../core/apps.ts";
import { fetchAndInstall, listExternalApps, uninstallExternal, listDrafts, submitDraft, deleteDraft } from "../../lib/external-apps.ts";
import { env } from "cloudflare:workers";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

// 高度なオプションの各種設定（管理者のみ）。
export const POST: APIRoute = async ({ request, locals }) => {
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return json({ error: "管理者のみ" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; mb?: number; days?: number; engine?: string; model?: string; mode?: string; prompt?: string; webhook?: string; limits?: Record<string, number>; parts?: string[]; theme?: unknown; nav?: { hidden?: string[]; labels?: Record<string, string>; order?: string[] }; appId?: string; draftId?: string; layout?: { order?: string[]; hidden?: string[] }; domain?: string; workersPaid?: boolean; on?: boolean; cfToken?: string; cfAccount?: string; ghToken?: string; ghRepo?: string };
  if (b._action === "max_upload") {
    const v = await setMaxUploadMb(env, Number(b.mb));
    return json({ ok: true, mb: v });
  }
  // ファイル保持期限（日数・0=無期限）。超過分は削除ジョブが物理削除（P0-5）。
  if (b._action === "file_retention") {
    const v = await setRetentionDays(env, Number(b.days));
    return json({ ok: true, days: v });
  }
  // エージェント承認ゲート（対外/破壊系の人間承認・P0-4）。既定 on。
  if (b._action === "agent_approval") {
    const { setApprovalMode } = await import("../../lib/approvals.ts");
    const v = await setApprovalMode(env, b.on === true);
    return json({ ok: true, on: v });
  }
  if (b._action === "ai_engine") {
    const v = await setAiEngine(env, String(b.engine ?? "gemini"));
    return json({ ok: true, engine: v });
  }
  // クラウドAI（Workers AI）の使用モデル（上位モデル選択）。妥当でないIDは既定へ。
  if (b._action === "workers_ai_model") {
    const v = await setWorkersAiModel(env, String(b.model ?? ""));
    return json({ ok: true, model: v });
  }
  // 記帳方式（単式/複式）。
  if (b._action === "bookkeeping_mode") {
    const v = await setBookkeepingMode(env, String(b.mode ?? "single"));
    return json({ ok: true, mode: v });
  }
  if (b._action === "custom_prompt") {
    const v = await setCustomPrompt(env, String(b.prompt ?? ""));
    return json({ ok: true, prompt: v });
  }
  if (b._action === "notify_webhook") {
    const v = await setNotifyWebhook(env, String(b.webhook ?? ""));
    return json({ ok: true, webhook: v });
  }
  if (b._action === "workers_paid") {
    const v = await setWorkersPaid(env, b.workersPaid === true);
    return json({ ok: true, workersPaid: v });
  }
  // オートパイロット（AIにCF/GitHub運用代行を許可）。トグル＋トークン/アカウント/リポ登録。
  if (b._action === "autonomy_toggle") { await setAutonomy(env, b.on === true); return json({ ok: true, on: b.on === true }); }
  if (b._action === "autonomy_config") { await saveAutonomyConfig(env, { cfToken: b.cfToken, cfAccount: b.cfAccount, ghToken: b.ghToken, ghRepo: b.ghRepo }); return json({ ok: true }); }
  if (b._action === "storage_limits") {
    const inc = b.limits ?? {};
    const clean: Record<string, number> = {};
    for (const k of ["d1", "kv", "r2", "drive"]) {
      const v = Number(inc[k]);
      if (Number.isFinite(v) && v > 0) clean[k] = v; // GB単位
    }
    await setStorageLimits(env, clean);
    return json({ ok: true });
  }
  // 有効パーツの選択（団体ごとの組み立て・§5）。
  if (b._action === "enabled_parts") {
    const v = await setEnabledPartIds(locals.ctx, Array.isArray(b.parts) ? b.parts : []);
    return json({ ok: true, enabled: v, catalog: partCatalog() });
  }
  if (b._action === "list_parts") {
    return json({ ok: true, enabled: await enabledPartIds(locals.ctx), catalog: partCatalog() });
  }
  // UIテーマ（第1層）。
  if (b._action === "ui_theme") {
    try {
      const v = await setTheme(locals.ctx, b.theme);
      return json({ ok: true, theme: v });
    } catch (e) {
      return json({ error: "テーマの保存に失敗しました：" + (e as Error).message }, 500);
    }
  }
  // ナビ上書き（第2層）。
  if (b._action === "nav_overrides") {
    const v = await setNavOverrides(locals.ctx, b.nav ?? {});
    return json({ ok: true, nav: v });
  }
  // ホームのセクション構成（並べ替え/非表示）。
  if (b._action === "home_layout") {
    const v = await setHomeLayout(locals.ctx, b.layout ?? {});
    return json({ ok: true, layout: v });
  }
  // カスタムドメイン（希望ドメインの保存。実紐付けは顧客がCFダッシュボードで実施）。
  if (b._action === "custom_domain") {
    const v = await setCustomDomain(locals.ctx, b.domain ?? "", nowSec());
    return json({ ok: true, domain: v });
  }
  // アプリ（マーケット）：導入/削除/一覧。
  if (b._action === "install_app") {
    const installed = await installApp(locals.ctx, String(b.appId ?? ""));
    return json({ ok: true, installed });
  }
  if (b._action === "uninstall_app") {
    try {
      const installed = await uninstallApp(locals.ctx, String(b.appId ?? ""));
      return json({ ok: true, installed });
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }
  }
  if (b._action === "list_apps") {
    return json({ ok: true, catalog: appCatalog(), installed: await installedAppIds(locals.ctx) });
  }
  // 外部アプリ（レジストリから署名検証して取り込み）。
  if (b._action === "fetch_app") {
    const r = await fetchAndInstall(locals.ctx, String(b.appId ?? ""));
    return json(r, r.ok ? 200 : 400);
  }
  if (b._action === "uninstall_external") {
    await uninstallExternal(locals.ctx, String(b.appId ?? ""));
    return json({ ok: true });
  }
  if (b._action === "list_external") {
    return json({ ok: true, external: await listExternalApps(locals.ctx) });
  }
  // AI開発：ドラフトのレビュー→公開申請。
  if (b._action === "list_drafts") {
    return json({ ok: true, drafts: await listDrafts(locals.ctx) });
  }
  if (b._action === "submit_draft") {
    const r = await submitDraft(locals.ctx, String(b.draftId ?? ""));
    return json(r, r.ok ? 200 : 400);
  }
  if (b._action === "delete_draft") {
    await deleteDraft(locals.ctx, String(b.draftId ?? ""));
    return json({ ok: true });
  }
  return json({ error: "不明な操作" }, 400);
};
