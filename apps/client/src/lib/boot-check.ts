// 本番起動 preflight（レビュー003 §7・action#7）。
// WHY: ENV/ENVIRONMENT/MASTER_KEY/Stripe/Google など本番分岐が複数箇所にあり、設定漏れで
//   「暗号処理が無言で止まる」「dev経路が露出する」等の事故になりやすい。起動時に一括点検し診断へ残す。
// middleware から初回1回だけ呼ぶ（KVフラグで以後スキップ＝ホットパス負荷を避ける）。
import { logDiag } from "./diag.ts";
import { masterKeySource } from "./client.ts";

const KV_FLAG = "bootcheck_done";

type Finding = { level: "error" | "warn"; key: string; detail: string };

// 本番（ENVIRONMENT=production）で満たすべき条件を点検（環境変数の参照のみ・副作用なし）。
export function checkProdEnv(env: Env): Finding[] {
  const out: Finding[] = [];
  if (env.ENVIRONMENT !== "production") return out; // 本番のみ点検（dev/test は対象外）
  // 暗号処理の根。未投入だと masterKey() が throw＝保存/セッションが全面停止。
  if (!env.MASTER_KEY) out.push({ level: "error", key: "MASTER_KEY", detail: "未設定。保存時暗号化・セッション署名が停止する（wrangler secret put MASTER_KEY --env production）。" });
  // A2A/ライセンス検証の公開鍵。
  if (!env.VERIFY_PUBLIC_JWK) out.push({ level: "warn", key: "VERIFY_PUBLIC_JWK", detail: "未設定。A2A受信の署名検証が 503 になる。" });
  // スケジューラ連携の共有秘密（cron/drain 保護）。
  if (!env.INTERNAL_KEY) out.push({ level: "warn", key: "INTERNAL_KEY", detail: "未設定。リマインダー drain の保護が効かない。" });
  // 組織ログイン（Google OAuth）。両方未設定なら dev ログインのまま＝本番として危険。
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) out.push({ level: "warn", key: "GOOGLE_OAUTH", detail: "GOOGLE_CLIENT_ID/SECRET 未設定。組織ログインが dev 経路にフォールバックする。" });
  return out;
}

// isolate 内で一度実行したら以後スキップ（毎リクエストの KV 読みを避ける）。
// KV_FLAG は isolate 横断の診断重複抑止用。早めに true にして isolate 内の重複実行も防ぐ。
let isolateChecked = false;

// 初回リクエスト時に一度だけ点検して診断に残す（冪等・失敗は握りつぶす）。
export async function bootCheck(env: Env): Promise<void> {
  if (isolateChecked) return;
  isolateChecked = true; // KV 読み前に立てる＝isolate 内の並行リクエストで多重実行しない
  try {
    if ((await env.LICENSE.get(KV_FLAG)) === "1") return;
    // 本番（自社 env.production）の env 設定点検。
    if (env.ENVIRONMENT === "production") {
      for (const f of checkProdEnv(env)) {
        await logDiag(env, f.level, "bootcheck", `本番設定点検: ${f.key} — ${f.detail}`);
      }
    }
    // 鍵保管の点検（全環境・§3-1/P1-2）。配布顧客環境は ENVIRONMENT 未設定のため production 限定だと
    // 一度も発火しない＝顧客は全件 KV 自動生成（鍵と暗号文が同一 KV に同居）が既定になる。環境を問わず診断に残す。
    const src = await masterKeySource(env);
    if (src === "missing-prod") {
      await logDiag(env, "error", "security",
        "本番で MASTER_KEY が未投入＝暗号処理をブロック中。`wrangler secret put MASTER_KEY --env production` で投入してください（§10.1）。");
    } else if (src === "kv-autogen") {
      await logDiag(env, env.ENVIRONMENT === "production" ? "error" : "warn", "security",
        "MASTER_KEY が KV 自動生成です（鍵と暗号文が同一 KV に同居）。アカウント侵害時にアプリ層暗号化が無力化します。Worker Secret(MASTER_KEY) の投入を強く推奨します（§3-1/§10.1）。");
    }
    // 鍵保管が未確定（初回リクエストで暗号未実行＝"unknown"）のうちは KV_FLAG を立てず、次リクエストで再点検する。
    // WHY: bootCheck は1回しか走らないため、鍵生成より前に確定させると kv-autogen 警告を取り逃す。
    if (src !== "unknown") await env.LICENSE.put(KV_FLAG, "1");
  } catch { /* 点検自体の失敗は本処理を止めない */ }
}
