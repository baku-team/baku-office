// 外部送信・AI利用・保存期間・削除方法の開示情報を、現在の連携設定から動的生成する（第三者レビュー P0-7）。
// 顧客（団体）が自社のプライバシーポリシー/利用者向け説明にそのまま転記できる素材を作る。
// 注意：本生成物は素材であり、法的有効性は専門家レビューが必要（実装は「表示と同意取得」まで）。
import { getApiKey } from "./client.ts";
import { googleStatus, SCOPE_GROUPS, type ScopeGroupId } from "./google.ts";
import { listCapabilities, CAPABILITY_LABEL } from "./capabilities.ts";
import { getRetentionDays } from "./storage.ts";

export type Destination = {
  name: string;       // 送信先サービス
  purpose: string;    // 利用目的
  dataKinds: string;  // 送信され得るデータ種別
  region: string;     // 主な所在地（越境の有無の目安）
  note?: string;      // 学習利用・無料/有料枠などの注意
};

export type Disclosure = {
  destinations: Destination[];
  retentionDays: number;       // ファイル保持期限（0=無期限）
  encryptedAtRest: boolean;    // 保存時暗号化（本実装では常に true）
  generatedNote: string;
  googleConnected: boolean;    // Google Workspace 連携の有無（Limited Use 表示の出し分け）
  limitedUse?: string;         // Google API Limited Use Disclosure（Restricted scope 連携時に表示）
  responsibilityNote: string;  // 責任分界（ホスト/顧客/BYOK）
};

// Google API Services User Data Policy の Limited Use 開示（Restricted scope を使う場合に必須）。
// 参照: https://developers.google.com/terms/api-services-user-data-policy
const LIMITED_USE = [
  "本アプリの Google ユーザーデータの利用は、Google API Services User Data Policy（Limited Use 要件を含む）に準拠します。具体的には：",
  "・取得した Gmail 等のデータは、ユーザーが要求した機能の提供のみに利用します。",
  "・人による閲覧は、ユーザーの明示的同意、セキュリティ・不正対策・法令遵守、または集計・匿名化された場合を除き行いません。",
  "・第三者への譲渡・販売は行わず、広告目的には利用しません。",
  "・データはユーザーの Cloudflare アカウント内に保存時暗号化（AES-GCM）で保持し、連携解除でアクセスを失効します。",
].join("\n");

export async function buildDisclosure(env: Env): Promise<Disclosure> {
  const dest: Destination[] = [];

  // インフラ（自己ホスト・常時）。顧客の Cloudflare アカウント内に業務データが保存される。
  dest.push({
    name: "Cloudflare（Workers / D1 / KV / R2）",
    purpose: "アプリ稼働・業務データの保存（顧客自身のCloudflareアカウント内）",
    dataKinds: "会員名簿・会計・ファイル等の業務データ全般（ファイル本体は保存時暗号化）",
    region: "顧客が選択するCloudflareのリージョン",
  });

  const has = async (k: string) => !!(await getApiKey(env, k));

  if (await has("gemini")) dest.push({
    name: "Google（Gemini API）", purpose: "AIによる応答・要約・検索の生成", dataKinds: "チャット入力・要約対象テキスト/ファイル・Web検索クエリ",
    region: "Google（米国等・越境の可能性）", note: "有料APIのプロンプトはモデル学習に使用されない旨を提供元規約で確認のこと。",
  });
  if (await has("claude")) dest.push({
    name: "Anthropic（Claude API）", purpose: "AIによる資料生成・抽出・スキル実行", dataKinds: "チャット入力・資料要件・請求書/領収書の画像/PDF",
    region: "Anthropic（米国等・越境の可能性）", note: "有料APIのプロンプトはモデル学習に使用されない旨を提供元規約で確認のこと。",
  });

  const g = await googleStatus(env);
  const googleConnected = g.connected && g.groups.length > 0;
  // Restricted scope（Gmail）を付与しているか＝Limited Use 開示の要否。
  const usesRestricted = g.groups.some((gr: ScopeGroupId) => SCOPE_GROUPS[gr]?.restricted);
  if (googleConnected) {
    const labels = g.groups.map((gr: ScopeGroupId) => SCOPE_GROUPS[gr]?.label).filter(Boolean).join(" / ");
    dest.push({
      name: "Google Workspace（Calendar / Gmail / Meet）", purpose: `連携機能（付与: ${labels}）`,
      dataKinds: "予定・メール本文/添付・会議記録（付与した範囲のみ）",
      region: "Google（米国等・越境の可能性）", note: "Gmail の閲覧/送信は Restricted scope。最終利用日時・付与scopeは連携画面で確認可。",
    });
  }
  if (await has("line_token")) dest.push({
    name: "LINE（Messaging API）", purpose: "LINEでの通知・チャット応答", dataKinds: "送受信メッセージ・宛先ユーザーID",
    region: "LINEヤフー（日本等）",
  });

  const caps = await listCapabilities(env, true).catch(() => []);
  for (const c of caps) {
    dest.push({
      name: `任意API：${CAPABILITY_LABEL[c.capability] ?? c.capability}（${c.provider ?? "不明"}）`,
      purpose: "画像/音声/動画生成など団体が有効化した追加AI機能", dataKinds: "各機能への入力（プロンプト・テキスト等）",
      region: "各提供元（越境の可能性）", note: "団体がBYOKで有効化。利用前に提供元のデータ利用条件を確認のこと。",
    });
  }

  // 決済（課金）はホスト(baku-office)が Stripe 経由で処理（顧客の業務データは送信しない）。
  dest.push({
    name: "Stripe（決済・ホスト経由）", purpose: "プラン課金の決済処理（ホストが実施）", dataKinds: "課金に必要な範囲（業務データは含まない）",
    region: "Stripe（米国・日本等）",
  });

  return {
    destinations: dest,
    retentionDays: await getRetentionDays(env).catch(() => 0),
    encryptedAtRest: true,
    generatedNote: "本一覧は現在の連携設定から自動生成されています。連携の追加・解除で内容は変わります。上記の各送信先は、個人情報の取扱いを委託する「サブプロセッサ（委託先）」一覧としても利用できます。",
    googleConnected,
    limitedUse: usesRestricted ? LIMITED_USE : undefined,
    responsibilityNote: [
      "・業務データ（会員名簿・会計・ファイル等）は顧客（団体）自身の Cloudflare アカウント内に保存され、ホスト（baku-office 提供者）は通常これを閲覧しません。ホストはライセンス・配信・課金・通知のみを担います。",
      "・外部AI/外部API（BYOK で団体が有効化したもの）に送信されるデータの取扱いは各提供元の規約に従い、その有効化判断と費用負担は団体に帰属します。",
      "・Cloudflare/外部API の実費（Workers/D1/KV/R2、AIトークン等）は顧客負担です。アプリ内の上限は推定であり、実請求は各プロバイダの計上が正です。",
    ].join("\n"),
  };
}
