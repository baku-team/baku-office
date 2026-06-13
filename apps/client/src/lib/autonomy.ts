import { kvPut } from "./kv.ts";
// オートパイロット（Pro・opt-in・管理者）：団体自身の Cloudflare/GitHub を、破壊的（コア損害）以外の範囲でAIに任せる。
// 方針：read/create 中心。削除・force-push・課金/権限変更・シークレット開示・他テナントは「ツール自体を提供しない」。
import { getApiKey, saveApiKey, hostFetch } from "./client.ts";
import { getDeployHook } from "./update.ts";
import { logDiag } from "./diag.ts";

const KV_ON = "org_autonomy";       // "true" でAIにサーバー操作を許可（既定OFF）
const KV_CF_ACCT = "cf_account_id"; // CFアカウントID（非秘匿）
const KV_GH_REPO = "gh_repo";        // owner/repo（非秘匿）

// できること/できないことのポリシー（自治有効時に agent SYSTEM へ注入＝AIが可否を理解する）。
export const AUTONOMY_POLICY =
  "【オートパイロット（この団体自身のCloudflare/GitHubを運用代行）】\n" +
  "できること：CFのKV/D1リソースの一覧・作成、Deploy Hookによるデプロイ、GitHubリポの読取・ブランチ作成・非コアファイルのコミット・PR作成、PRのマージ（CI/チェックが全て成功のときのみ・squash）。\n" +
  "できないこと（コア損害＝ツール自体が無い・絶対に試みない）：アカウントや本番DB/KVの削除、リポジトリ削除、force-push、main等の保護ブランチへの直接コミット、チェック未通過/コンフリクトのままのマージ、課金/プラン/メンバー権限の変更、シークレット/トークンの開示・外部送信、他団体・他テナントへの操作。\n" +
  "不可逆・影響の大きい操作（デプロイ、リソース作成、PR）は実行前に要点を述べ、ユーザーの意図に沿うときだけ行う。";

export async function isAutonomyOn(env: Env): Promise<boolean> {
  return (await env.LICENSE.get(KV_ON)) === "true";
}
export async function setAutonomy(env: Env, on: boolean): Promise<void> {
  await kvPut(env, KV_ON, on ? "true" : "false");
}
export async function getAutonomyConfig(env: Env): Promise<{ on: boolean; cfToken: boolean; cfAccount: string; ghToken: boolean; ghRepo: string }> {
  return {
    on: await isAutonomyOn(env),
    cfToken: !!(await getApiKey(env, "cloudflare_token")),
    cfAccount: (await env.LICENSE.get(KV_CF_ACCT)) ?? "",
    ghToken: !!(await getApiKey(env, "github_token")),
    ghRepo: (await env.LICENSE.get(KV_GH_REPO)) ?? "",
  };
}
export async function saveAutonomyConfig(env: Env, a: { cfToken?: string; cfAccount?: string; ghToken?: string; ghRepo?: string }): Promise<{ cfAccount?: string; cfError?: string }> {
  const out: { cfAccount?: string; cfError?: string } = {};
  if (a.cfToken) {
    await saveApiKey(env, "cloudflare_token", a.cfToken.trim());
    // アカウントIDを自動検出（初心者は入力不要）。明示指定があればそちらを優先。
    if (!a.cfAccount) {
      const det = await cfDetectAccount(a.cfToken.trim());
      if (det) { await kvPut(env, KV_CF_ACCT, det); out.cfAccount = det; }
      else out.cfError = "トークンからアカウントを検出できませんでした。権限（Account 読み取り）をご確認ください。";
    }
  }
  if (a.ghToken) await saveApiKey(env, "github_token", a.ghToken.trim());
  if (a.cfAccount) await kvPut(env, KV_CF_ACCT, a.cfAccount.trim());
  if (a.ghRepo !== undefined) await kvPut(env, KV_GH_REPO, a.ghRepo.trim());
  return out;
}

// CF トークンからアカウントIDを自動検出（最初のアカウント）。
export async function cfDetectAccount(token: string): Promise<string | null> {
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=1", { headers: { authorization: `Bearer ${token}` } });
    const j = (await r.json().catch(() => ({}))) as { success?: boolean; result?: { id: string }[] };
    return j.success && j.result?.[0]?.id ? j.result[0].id : null;
  } catch { return null; }
}

// ===== GitHub OAuth デバイスフロー（PAT作成不要・コード入力だけで接続） =====
const GH_SCOPE = "repo";

// 公開 client_id の解決：env → KVキャッシュ → ホスト配布(/api/gh-client-id)。
// ＝各団体での設定不要。ホストに一度設定すれば全クライアントが自動取得する。
export async function resolveGhClientId(env: Env): Promise<string> {
  if (env.GITHUB_OAUTH_CLIENT_ID) return env.GITHUB_OAUTH_CLIENT_ID;
  const cached = await env.LICENSE.get("gh_client_id");
  if (cached) return cached;
  try {
    const r = await hostFetch(env, "/api/gh-client-id");
    if (r.ok) { const j = (await r.json()) as { clientId?: string }; if (j.clientId) { await kvPut(env, "gh_client_id", j.clientId, { expirationTtl: 86400 }); return j.clientId; } }
  } catch { /* offline */ }
  return "";
}
export async function ghDeviceAvailable(env: Env): Promise<boolean> { return !!(await resolveGhClientId(env)); }

export async function ghDeviceStart(env: Env): Promise<{ ok: boolean; user_code?: string; verification_uri?: string; device_code?: string; interval?: number; error?: string }> {
  const cid = await resolveGhClientId(env);
  if (!cid) return { ok: false, error: "GitHub接続は未設定です（手動トークンをご利用ください）" };
  try {
    const r = await fetch("https://github.com/login/device/code", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "baku-office" }, body: JSON.stringify({ client_id: cid, scope: GH_SCOPE }) });
    const j = (await r.json().catch(() => ({}))) as { device_code?: string; user_code?: string; verification_uri?: string; interval?: number };
    if (!j.device_code) return { ok: false, error: "開始に失敗しました" };
    return { ok: true, user_code: j.user_code, verification_uri: j.verification_uri, device_code: j.device_code, interval: j.interval ?? 5 };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
export async function ghDevicePoll(env: Env, deviceCode: string): Promise<{ ok: boolean; pending?: boolean; error?: string }> {
  const cid = await resolveGhClientId(env);
  if (!cid) return { ok: false, error: "未設定" };
  try {
    const r = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": "baku-office" }, body: JSON.stringify({ client_id: cid, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }) });
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; error?: string };
    if (j.access_token) { await saveApiKey(env, "github_token", j.access_token); return { ok: true }; }
    if (j.error === "authorization_pending" || j.error === "slow_down") return { ok: false, pending: true };
    return { ok: false, error: j.error || "取得に失敗しました" };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
// 接続済みトークンでリポ一覧（接続先の自動選択用）。
export async function ghListRepos(env: Env): Promise<string[]> {
  const token = await getApiKey(env, "github_token");
  if (!token) return [];
  try {
    const r = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "baku-office" } });
    const j = await r.json().catch(() => []);
    return Array.isArray(j) ? (j as { full_name: string }[]).map((x) => x.full_name) : [];
  } catch { return []; }
}

// 自治ツールを提示できる状態か（ON＋少なくとも片方のトークン）。
export async function autonomyReady(env: Env): Promise<boolean> {
  if (!(await isAutonomyOn(env))) return false;
  return !!(await getApiKey(env, "cloudflare_token")) || !!(await getApiKey(env, "github_token"));
}

// ===== Cloudflare（安全サブセット：一覧・作成・デプロイのみ） =====
async function cf(env: Env, method: string, path: string, body?: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const token = await getApiKey(env, "cloudflare_token");
  const acct = (await env.LICENSE.get(KV_CF_ACCT)) ?? "";
  if (!token || !acct) return { ok: false, error: "Cloudflareトークン/アカウントIDが未設定です" };
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const j = (await r.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: { message: string }[] };
    return r.ok && j.success ? { ok: true, result: j.result } : { ok: false, error: j.errors?.map((e) => e.message).join(", ") || `CF ${r.status}` };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
export async function cfListResources(env: Env): Promise<string> {
  const kv = await cf(env, "GET", "/storage/kv/namespaces?per_page=50");
  const d1 = await cf(env, "GET", "/d1/database?per_page=50");
  const kvs = kv.ok ? (kv.result as { title: string }[]).map((x) => x.title) : [];
  const d1s = d1.ok ? (d1.result as { name: string }[]).map((x) => x.name) : [];
  return `KV: ${kvs.join(", ") || "（なし）"}\nD1: ${d1s.join(", ") || "（なし）"}`;
}
export async function cfCreateKv(env: Env, title: string): Promise<string> {
  const r = await cf(env, "POST", "/storage/kv/namespaces", { title });
  return r.ok ? `KV namespace「${title}」を作成しました。` : `作成失敗：${r.error}`;
}
export async function cfCreateD1(env: Env, name: string): Promise<string> {
  const r = await cf(env, "POST", "/d1/database", { name });
  return r.ok ? `D1「${name}」を作成しました。` : `作成失敗：${r.error}`;
}
export async function cfDeploy(env: Env): Promise<string> {
  const hook = await getDeployHook(env);
  if (!hook) return "Deploy Hook が未設定です（設定→アプリの更新 で登録してください）。";
  try { const r = await fetch(hook, { method: "POST" }); return r.ok ? "デプロイをトリガーしました。" : `デプロイ失敗（${r.status}）`; } catch (e) { return `デプロイ失敗：${(e as Error).message}`; }
}

// ===== GitHub（安全サブセット：読取・ブランチ・非コアコミット・PR） =====
const CORE_DENY = [/^src\/core\//, /^wrangler/, /^package\.json$/, /^package-lock\.json$/, /^\.github\//, /^migrations\//];
function isCorePath(path: string): boolean { return CORE_DENY.some((re) => re.test(path)); }

async function gh(env: Env, method: string, path: string, body?: unknown): Promise<{ ok: boolean; data?: any; error?: string }> {
  const token = await getApiKey(env, "github_token");
  const repo = (await env.LICENSE.get(KV_GH_REPO)) ?? "";
  if (!token || !repo) return { ok: false, error: "GitHubトークン/リポジトリ(owner/repo)が未設定です" };
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "baku-office", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, data } : { ok: false, error: (data as { message?: string }).message || `GitHub ${r.status}` };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
async function defaultBranch(env: Env): Promise<string> {
  const r = await gh(env, "GET", ""); return r.ok ? (r.data.default_branch as string) || "main" : "main";
}
export async function ghReadFile(env: Env, path: string): Promise<string> {
  const r = await gh(env, "GET", `/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`);
  if (!r.ok) return `読取失敗：${r.error}`;
  if (Array.isArray(r.data)) return `（ディレクトリ）${(r.data as { name: string }[]).map((x) => x.name).join(", ")}`;
  try { return atob((r.data.content as string).replace(/\n/g, "")).slice(0, 8000); } catch { return "（内容を取得できません）"; }
}
export async function ghCreateBranch(env: Env, name: string): Promise<string> {
  const base = await defaultBranch(env);
  const ref = await gh(env, "GET", `/git/ref/heads/${base}`);
  if (!ref.ok) return `基点ブランチ取得失敗：${ref.error}`;
  const r = await gh(env, "POST", "/git/refs", { ref: `refs/heads/${name}`, sha: ref.data.object.sha });
  return r.ok ? `ブランチ「${name}」を作成しました。` : `作成失敗：${r.error}`;
}
export async function ghCommitFile(env: Env, branch: string, path: string, content: string, message: string): Promise<string> {
  const base = await defaultBranch(env);
  if (branch === base) return "保護ブランチ（既定ブランチ）への直接コミットは禁止です。新しいブランチを作成し PR で反映してください。";
  if (isCorePath(path)) return `コア領域（${path}）への変更は禁止です。`;
  // 既存sha取得（更新時）。
  const cur = await gh(env, "GET", `/contents/${path}?ref=${branch}`);
  const sha = cur.ok && !Array.isArray(cur.data) ? (cur.data.sha as string) : undefined;
  const r = await gh(env, "PUT", `/contents/${path}`, { message: message || `update ${path}`, content: btoa(unescape(encodeURIComponent(content))), branch, sha });
  return r.ok ? `${path} を ${branch} にコミットしました。` : `コミット失敗：${r.error}`;
}
export async function ghOpenPr(env: Env, head: string, title: string, body?: string): Promise<string> {
  const base = await defaultBranch(env);
  const r = await gh(env, "POST", "/pulls", { title: title || head, head, base, body: body ?? "" });
  return r.ok ? `PRを作成しました：${r.data.html_url}` : `PR作成失敗：${r.error}`;
}
// PRのマージ（CI/チェックが全て success のときのみ・squash）。チェック未通過/コンフリクト/チェック無しは拒否。
export async function ghMergePr(env: Env, number: number): Promise<string> {
  const pr = await gh(env, "GET", `/pulls/${number}`);
  if (!pr.ok) return `PR取得失敗：${pr.error}`;
  if (pr.data.state !== "open") return "オープンなPRではありません。";
  // mergeable は GitHub が非同期算出。null（算出中）は1回だけ再取得し、true 以外は拒否（コンフリクト/不明を素通りさせない）。
  let mergeable = pr.data.mergeable;
  if (mergeable === null || mergeable === undefined) {
    await new Promise((s) => setTimeout(s, 1500));
    const pr2 = await gh(env, "GET", `/pulls/${number}`);
    mergeable = pr2.ok ? pr2.data.mergeable : null;
  }
  if (mergeable !== true) return "コンフリクトがあるか可否を確認できないため自動マージしません。解消後に再依頼してください。";
  // コア領域を含むPRはマージ禁止（gh_commit_file の denylist を PR 経由で回避させない）。
  // 全ページ取得＝101件目以降のコア領域ファイルを見逃さない。多すぎる場合は安全側で拒否。
  const files: { filename: string }[] = [];
  for (let page = 1; page <= 10; page++) {
    const fl = await gh(env, "GET", `/pulls/${number}/files?per_page=100&page=${page}`);
    if (!fl.ok) return `PRファイル取得失敗：${fl.error}`;
    const batch = (fl.data ?? []) as { filename: string }[];
    files.push(...batch);
    if (batch.length < 100) break;
    if (page === 10) return "変更ファイルが多すぎて安全確認できないため自動マージしません（手動レビューしてください）。";
  }
  const core = files.find((f) => isCorePath(f.filename));
  if (core) return `コア領域（${core.filename}）を含むPRは自動マージできません。手動レビューが必要です。`;
  const sha = pr.data.head?.sha as string;
  // check-runs も全ページ取得（31件目以降の失敗チェックを見逃さない）。
  const runs: { name: string; status: string; conclusion: string | null }[] = [];
  {
    const cr = await gh(env, "GET", `/commits/${sha}/check-runs?per_page=100`);
    if (cr.ok) {
      runs.push(...((cr.data.check_runs ?? []) as { name: string; status: string; conclusion: string | null }[]));
      const total = (cr.data.total_count ?? runs.length) as number;
      for (let page = 2; runs.length < total && page <= 10; page++) {
        const more = await gh(env, "GET", `/commits/${sha}/check-runs?per_page=100&page=${page}`);
        if (!more.ok) break;
        runs.push(...((more.data.check_runs ?? []) as { name: string; status: string; conclusion: string | null }[]));
      }
    }
  }
  const st = await gh(env, "GET", `/commits/${sha}/status`);
  const statuses = (st.ok ? st.data.statuses : []) as { context: string; state: string }[];
  if ((runs?.length ?? 0) + (statuses?.length ?? 0) === 0) return "CI/チェックが見つからないため自動マージしません（安全のため手動マージしてください）。";
  const badRun = (runs ?? []).find((r) => r.status !== "completed" || !["success", "neutral", "skipped"].includes(r.conclusion ?? ""));
  if (badRun) return `チェック「${badRun.name}」が未通過のためマージしません（${badRun.conclusion ?? badRun.status}）。`;
  if (st.ok && (statuses?.length ?? 0) > 0 && st.data.state !== "success") return `コミットステータスが ${st.data.state} のためマージしません。`;
  const m = await gh(env, "PUT", `/pulls/${number}/merge`, { merge_method: "squash" });
  return m.ok ? `PR #${number} を squash マージしました（チェック成功を確認済み）。本番デプロイが走る場合があります。` : `マージ失敗：${m.error}`;
}

// 監査つき実行ディスパッチ（agent から呼ぶ）。
export async function runAutonomyTool(env: Env, name: string, a: Record<string, unknown>): Promise<string> {
  let out: string;
  switch (name) {
    case "cf_list_resources": out = await cfListResources(env); break;
    case "cf_create_kv": out = await cfCreateKv(env, String(a.title ?? "")); break;
    case "cf_create_d1": out = await cfCreateD1(env, String(a.name ?? "")); break;
    case "cf_deploy": out = await cfDeploy(env); break;
    case "gh_read_file": out = await ghReadFile(env, String(a.path ?? "")); break;
    case "gh_create_branch": out = await ghCreateBranch(env, String(a.name ?? "")); break;
    case "gh_commit_file": out = await ghCommitFile(env, String(a.branch ?? ""), String(a.path ?? ""), String(a.content ?? ""), String(a.message ?? "")); break;
    case "gh_open_pr": out = await ghOpenPr(env, String(a.head ?? ""), String(a.title ?? ""), a.body ? String(a.body) : undefined); break;
    case "gh_merge_pr": out = await ghMergePr(env, Number(a.number) || 0); break;
    default: return "未知の自治ツール";
  }
  await logDiag(env, "info", "other", `自治ツール ${name}：${out.slice(0, 120)}`).catch(() => {});
  return out;
}

// 道具宣言（破壊系は含めない）。
export const AUTONOMY_TOOLS = [
  { name: "cf_list_resources", description: "自団体CloudflareのKV/D1リソースを一覧", parameters: { type: "object", properties: {} } },
  { name: "cf_create_kv", description: "CloudflareにKV namespaceを作成", parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
  { name: "cf_create_d1", description: "CloudflareにD1データベースを作成", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "cf_deploy", description: "Deploy Hook で自団体アプリをデプロイ", parameters: { type: "object", properties: {} } },
  { name: "gh_read_file", description: "自団体リポのファイル/ディレクトリを読む", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "gh_create_branch", description: "新しいブランチを作成（既定ブランチから分岐）", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "gh_commit_file", description: "ブランチに非コアファイルをコミット（main直/コア領域は禁止）", parameters: { type: "object", properties: { branch: { type: "string" }, path: { type: "string" }, content: { type: "string" }, message: { type: "string" } }, required: ["branch", "path", "content"] } },
  { name: "gh_open_pr", description: "ブランチから既定ブランチへPRを作成", parameters: { type: "object", properties: { head: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["head", "title"] } },
  { name: "gh_merge_pr", description: "PRをマージ（CI/チェックが全て成功のときのみ・squash）。未通過/コンフリクト/チェック無しは拒否", parameters: { type: "object", properties: { number: { type: "number", description: "PR番号" } }, required: ["number"] } },
];
