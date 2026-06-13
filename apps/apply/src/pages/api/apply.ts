import type { APIRoute } from "astro";
import { initialEntitlement, randomId, provisionRepo, type Plan } from "@baku-office/shared";
import { env } from "cloudflare:workers";

export const prerender = false;
const nowSec = (): number => Math.floor(Date.now() / 1000);

// 申込（申込専用Worker）：団体情報＋プラン → customers/licenses 作成。free は即時、plus/pro は入金前 free 相当（§2.3）。
// ホストポータルと同じ D1 を共有。本番は Google ログイン後に呼ぶ（Phase1 は googleSub 任意）。
// IP単位のレート制限（SESSION KV・1時間に5件まで）。WHY: 無認証導線のため、customer/license量産＋
// GitHubリポ生成のスパムで GitHub レート/リポ上限を消費されるのを防ぐ。
const RL_MAX = 5;
const RL_TTL = 3600;

export const POST: APIRoute = async ({ request, locals }) => {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const rlKey = `apply_rl:${ip}`;
  const cur = Number((await env.SESSION.get(rlKey)) ?? "0");
  if (cur >= RL_MAX) return json({ error: "短時間に申込が集中しています。しばらく待って再度お試しください。" }, 429);
  await env.SESSION.put(rlKey, String(cur + 1), { expirationTtl: RL_TTL });

  const b = (await request.json().catch(() => ({}))) as {
    orgName?: string;
    contactName?: string;
    contactEmail?: string;
    googleSub?: string;
    nonprofit?: { orgType?: string; docRef?: string; description?: string };
  };
  const orgName = (b.orgName ?? "").trim();
  const contactEmail = (b.contactEmail ?? "").trim();
  const contactName = (b.contactName ?? "").trim();
  if (!orgName || !contactEmail) return json({ error: "orgName・contactEmail が必要" }, 400);
  // 入力検証（D1肥大・偽メールでのなりすまし突合汚染を防ぐ）。
  if (orgName.length > 200) return json({ error: "団体名が長すぎます" }, 400);
  if (contactName.length > 100) return json({ error: "担当者名が長すぎます" }, 400);
  if (contactEmail.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) return json({ error: "メールアドレスの形式が不正です" }, 400);
  // 基本 Free で開始（後から /billing で Plus/Pro）。NonProfit のみ申込時選択＝審査待ち（通過まで free 相当）。
  const plan: Plan = b.nonprofit ? "nonprofit" : "free";
  const now = nowSec();
  const customerId = randomId();
  const licenseId = randomId();
  await env.DB.prepare("INSERT INTO customers (id, org_name, contact_name, contact_email, created_at) VALUES (?,?,?,?,?)")
    .bind(customerId, orgName, contactName || null, contactEmail, now)
    .run();
  // 使い捨て deploy_code（nonce）。団体ごとリポに焼き込み、初回デプロイの自動点灯に使う（§2.2）。
  const deployCode = randomId();
  await env.DB.prepare(
    "INSERT INTO licenses (license_id, customer_id, plan, entitlement, status, google_sub, deploy_code, created_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(licenseId, customerId, plan, initialEntitlement(plan), "active", b.googleSub ?? null, deployCode, now)
    .run();

  // NonProfit 申込は審査レコードを作成（ホストが /nonprofit で承認 → entitlement=nonprofit）。
  if (b.nonprofit) {
    await env.DB.prepare("INSERT INTO nonprofit_applications (license_id,org_type,doc_ref,description,status,created_at) VALUES (?,?,?,?,'pending',?) ON CONFLICT(license_id) DO UPDATE SET org_type=excluded.org_type, doc_ref=excluded.doc_ref, description=excluded.description, status='pending', created_at=excluded.created_at")
      .bind(licenseId, b.nonprofit.orgType ?? null, b.nonprofit.docRef ?? null, b.nonprofit.description ?? null, now).run().catch(() => {});
  }

  // 入力ゼロの初回デプロイ：団体ごと公開リポ（throwaway）を生成し report.json を焼き込む（§2.2）。
  // 失敗時は共有リポにフォールバック（自動点灯なしでも導入は完了＝§2.7）。
  let deployRepo = `${env.GITHUB_OWNER ?? "baku-team"}/${env.GITHUB_TEMPLATE_REPO ?? "baku-office-app"}`;
  if (env.GITHUB_TOKEN && env.GITHUB_OWNER && env.GITHUB_TEMPLATE_REPO && env.HOST_BASE_URL) {
    try {
      deployRepo = await provisionRepo(
        { token: env.GITHUB_TOKEN, owner: env.GITHUB_OWNER, templateRepo: env.GITHUB_TEMPLATE_REPO, hostBaseUrl: env.HOST_BASE_URL },
        licenseId,
        deployCode,
      );
    } catch (e) {
      console.error("provision failed, fallback to shared repo", e);
    }
  }
  const deployUrl = "https://deploy.workers.cloudflare.com/?url=https://github.com/" + deployRepo;

  return json({ ok: true, licenseId, plan, entitlement: initialEntitlement(plan), deployUrl });
};

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
