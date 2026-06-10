// 導入時の規約同意ゲート（GA要件）。団体管理者（admin・org）が baku-office を使い始める前に、
// 当社（ホスト＝提供者）が定める利用規約・プライバシーポリシー・重要事項を必ず全文確認し同意する。
// 同意済みバージョンを KV に記録し、CONSENT_VERSION と一致しなければ（＝未同意/改訂後）再同意を求める。
//
// 注意：本文は「記入式ドラフト」。実運用前に弁護士レビューのうえ確定版へ差し替えること（§GA法務）。
//   ここでの規約は「当社↔団体」間のもの。団体↔その会員向けの雛形は legal-templates.ts（別物）。

const KV_CONSENT = "host_terms_consent"; // 値＝同意した CONSENT_VERSION

// 文書を改訂したら日付を上げる＝既存団体に再同意を求める。
export const CONSENT_VERSION = "2026-06-11";

export const HOST_TERMS = `【baku-office 利用規約（ドラフト・要弁護士確認）】
第1条（適用）本規約は、提供者（baku-llc、以下「当社」）が提供する業務システム「baku-office」（以下「本サービス」）を、団体（以下「利用団体」）が自らの Cloudflare アカウント上で運用するにあたっての条件を定めます。
第2条（提供範囲）当社はライセンス発行・配信・課金・通知・障害集約を担います。利用団体の業務データ（会員名簿・会計・ファイル等）は利用団体自身の Cloudflare アカウント内に保存され、当社は通常これにアクセスしません。
第3条（利用団体の責任）利用団体は、自らの Cloudflare アカウントの認証情報・暗号鍵・連携用 API キー（BYOK）を適切に管理し、所属会員の個人情報の管理者として関係法令を遵守します。
第4条（費用）Cloudflare および外部 API（AI トークン等）の実費は利用団体の負担です。アプリ内の上限・推定表示は概算であり、実請求は各提供元の計上が優先します。
第5条（禁止事項）法令違反、第三者の権利侵害、本サービスの不正利用・リバースエンジニアリングによる加害行為を禁止します。
第6条（免責）当社は、AI 出力の正確性・完全性、外部サービスの中断・障害、利用団体の設定・運用に起因する損害について、法令で許容される範囲で責任を負いません。重要な判断は人による確認を前提とします。
第7条（変更）当社は必要に応じ本規約を改訂でき、改訂後は本同意画面で再同意を求めます。`;

export const HOST_PRIVACY = `【プライバシーポリシー（当社が扱う情報・ドラフト・要弁護士確認）】
・当社が扱うのはライセンス・配信・課金・通知に必要な情報（団体名・代表者連絡先・課金状態・デプロイ先URL・バージョン）に限られます。
・決済は Stripe が処理し、当社は業務データを Stripe へ送りません。組織ログインは Google OAuth を用います。
・利用団体の業務データ（会員名簿・会計・ファイル等）は利用団体の Cloudflare アカウント内に保存時暗号化で保持され、当社は通常これを閲覧しません。
・外部 AI/外部 API への送信は、利用団体が BYOK で有効化したものに限られ、その取扱いは各提供元の規約に従います。`;

export const IMPORTANT_NOTES = `【重要事項（必ずご確認ください・ドラフト）】
1. データと暗号鍵の保管：業務データおよびその暗号鍵は、利用団体自身の Cloudflare アカウント内（KV/D1/R2）に保管されます。したがって団体の Cloudflare アカウント（ログイン情報）の保護が安全性の前提であり、アカウントが第三者に侵害された場合、保存時暗号化は保護として機能しないことがあります。
2. 外部送信：外部 AI への送信可否は利用団体の判断（BYOK 有効化）に委ねられます。
3. 費用：クラウド・外部 API の実費は利用団体の負担です。
4. 開発段階：本サービスは継続的に更新されます。重要な業務判断は人による確認を前提としてください。`;

export async function consentedVersion(env: Env): Promise<string | null> {
  return env.LICENSE.get(KV_CONSENT);
}

// 現行バージョンに未同意（未記録 or 改訂後）か。
export async function needsConsent(env: Env): Promise<boolean> {
  return (await consentedVersion(env)) !== CONSENT_VERSION;
}

export async function recordConsent(env: Env): Promise<void> {
  await env.LICENSE.put(KV_CONSENT, CONSENT_VERSION);
}
