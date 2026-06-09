// 定期巡回スケジューラ（Cloudflare Cron Triggers）。
// 各対象 Worker を Service Binding 経由で叩く（同一 workers.dev 直fetchは CF が遮断＝error 1042 のため）。
// CRON_TARGETS（JSON配列）で {binding, path, key} を指定。Astroビルド非依存・CF内で自動送信を完結。

type Target = { label?: string; binding: string; path: string; key: string };
interface Env {
  CRON_TARGETS?: string; // JSON: [{label,binding,path,key}, ...]
  [key: string]: unknown; // Service Binding（Fetcher）を動的参照
}

function parseTargets(raw: string | undefined): Target[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((t) => t && typeof t.binding === "string" && typeof t.path === "string" && typeof t.key === "string");
  } catch {
    return [];
  }
}

async function hit(env: Env, t: Target): Promise<{ label: string; ok: boolean; status?: number; error?: string }> {
  const label = t.label ?? `${t.binding}${t.path}`;
  const svc = env[t.binding] as { fetch: typeof fetch } | undefined;
  if (!svc || typeof svc.fetch !== "function") return { label, ok: false, error: `binding ${t.binding} 未設定` };
  try {
    const r = await svc.fetch(new Request("https://internal" + t.path, {
      method: "POST",
      headers: { "x-internal-key": t.key, "content-type": "application/json" },
      body: "{}",
    }));
    return { label, ok: r.ok, status: r.status };
  } catch (e) {
    return { label, ok: false, error: (e as Error).message };
  }
}

async function runAll(env: Env): Promise<{ label: string; ok: boolean; status?: number; error?: string }[]> {
  const targets = parseTargets(env.CRON_TARGETS);
  return Promise.all(targets.map((t) => hit(env, t)));
}

export default {
  // Cron Triggers のエントリ。全巡回先を並列で叩く。
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runAll(env).then((res) => {
      const failed = res.filter((r) => !r.ok);
      if (failed.length) console.error("cron targets failed:", JSON.stringify(failed));
    }));
  },
  // 手動トリガ／死活確認（GET=設定確認、POST=即時巡回）。秘匿情報は返さない。
  // POST は乱用防止のため、設定済みターゲット鍵のいずれかを x-internal-key で要求する。
  async fetch(request: Request, env: Env): Promise<Response> {
    const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
    if (request.method === "POST") {
      const targets = parseTargets(env.CRON_TARGETS);
      const provided = request.headers.get("x-internal-key");
      if (!provided || !targets.some((t) => t.key === provided)) return json({ error: "forbidden" }, 403);
      return json({ ok: true, results: await runAll(env) });
    }
    return json({ ok: true, targets: parseTargets(env.CRON_TARGETS).map((t) => t.label ?? `${t.binding}${t.path}`) });
  },
};
