import type { APIRoute } from "astro";
import { getSession } from "../../lib/auth.ts";
import { buildBackup, backupFileName, recordBackupDone, restoreBackup, getBackupSchedule, setBackupSchedule, getBackupState, backupAlert, type BackupMode } from "../../lib/backup.ts";
import { uploadBufferToDrive, driveConnected } from "../../lib/drive.ts";
import { audit } from "../../lib/storage.ts";
import { logDiag } from "../../lib/diag.ts";

export const prerender = false;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const isAdminOrg = (ses: { role: string; ctx: string } | null) => !!ses && ses.role === "admin" && ses.ctx === "org";
const asMode = (m: unknown): BackupMode => (m === "raw" ? "raw" : "decrypted");

// ローカルダウンロード：アーカイブを添付ファイルとして返す（GET＝状態変更なし扱い。最終実行のみ記録）。
export const GET: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!isAdminOrg(ses)) return json({ error: "権限がありません（管理者のみ）" }, 403);
  const mode = asMode(new URL(request.url).searchParams.get("mode"));
  try {
    const { json: body, tables, files } = await buildBackup(env, { decrypt: mode === "decrypted" });
    await recordBackupDone(env, "local", mode, tables, files);
    await audit(env, ses!.uid, "backup.download", `mode=${mode} tables=${tables} files=${files}`);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${backupFileName(mode === "decrypted")}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    await logDiag(env, "error", "backup", `download 失敗: ${(e as Error).message}`);
    return json({ error: (e as Error).message }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime.env;
  const ses = await getSession(env, request);
  if (!isAdminOrg(ses)) return json({ error: "権限がありません（管理者のみ）" }, 403);
  const b = (await request.json().catch(() => ({}))) as { _action?: string; mode?: BackupMode; enabled?: boolean; archive?: unknown };

  switch (b._action) {
    case "status": {
      const state = await getBackupState(env);
      const schedule = await getBackupSchedule(env);
      const alert = await backupAlert(env);
      const drive = await driveConnected(env).catch(() => false);
      return json({ ok: true, state, schedule, alert, drive });
    }
    case "drive": {
      if (!(await driveConnected(env))) return json({ error: "Google ドライブが未連携です。" }, 400);
      const mode = asMode(b.mode);
      try {
        const { json: body, tables, files } = await buildBackup(env, { decrypt: mode === "decrypted" });
        const buf = new TextEncoder().encode(body).buffer;
        const up = await uploadBufferToDrive(env, backupFileName(mode === "decrypted"), "application/json", buf);
        if (!up.ok) return json({ error: up.error ?? "アップロードに失敗しました。" }, 502);
        await recordBackupDone(env, "drive", mode, tables, files);
        await audit(env, ses!.uid, "backup.drive", `mode=${mode} tables=${tables} files=${files} id=${up.id}`);
        return json({ ok: true, tables, files, id: up.id });
      } catch (e) {
        await logDiag(env, "error", "backup", `drive 失敗: ${(e as Error).message}`);
        return json({ error: (e as Error).message }, 500);
      }
    }
    case "schedule": {
      await setBackupSchedule(env, { enabled: !!b.enabled, mode: asMode(b.mode) });
      return json({ ok: true });
    }
    case "restore": {
      if (!b.archive) return json({ error: "アーカイブが空です。" }, 400);
      try {
        const r = await restoreBackup(env, b.archive);
        await audit(env, ses!.uid, "backup.restore", `tables=${r.tables} rows=${r.rows} kv=${r.kv} files=${r.files}`);
        return json({ ok: true, ...r });
      } catch (e) {
        await logDiag(env, "error", "backup", `restore 失敗: ${(e as Error).message}`);
        return json({ error: (e as Error).message }, 500);
      }
    }
    default:
      return json({ error: "不明な操作" }, 400);
  }
};
