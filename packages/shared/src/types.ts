// 共有型（設計書 v1.0 準拠）。

// エンタイトルメント状態（§2・§4）。free=無料 / plus=AI / pro=エージェント /
// nonprofit=非営利（全機能無料・要審査） / enterprise=大企業・組織向け（個別相談・全機能解放） / test=全機能解放（管理画面で付与・非売）。
export type Entitlement = "free" | "plus" | "pro" | "nonprofit" | "enterprise" | "test";

// プラン（申込時の選択。入金前は free 相当で稼働＝プロビジョナル§2.3）。test は購入プランではない。
// nonprofit は申込で選べるが、ホスト審査を通過するまでは free 相当（プロビジョナル）。
export type Plan = "free" | "plus" | "pro" | "nonprofit";

// 署名ライセンストークンのペイロード（当社発行・初回アクティベートで取得）。
export type LicensePayload = {
  licenseId: string;
  entitlement: Entitlement;
  // 失効（epoch秒）。定期更新で延長。
  exp: number;
  // 発行時刻（epoch秒）。
  iat: number;
};

// 統合チェック応答（§13.1・PIIなし）。
export type CheckResponse = {
  entitlement: Entitlement;
  latestVersion: string;
  notices: Notice[];
  // blocked/deleted にされたアプリ id。クライアントは取り込み済みでも無効化・撤去する（緊急停止）。
  revokedApps?: string[];
  // ホストが「除外」した標準同梱アプリ id。クライアントは導入集合から外す（標準同梱アプリの登録/除外）。
  disabledBuiltins?: string[];
  // この団体が送った報告のうち、ホスト側で対応済み（resolved/wontfix）になったもの。クライアントへ返信表示する。
  reportUpdates?: ReportUpdate[];
};

// クライアント報告へのホスト側の対応返信（自己修復の結果通知）。
export type ReportUpdate = {
  id: string;
  kind: string;       // error / request
  title: string | null;
  status: string;     // resolved / wontfix
  resolution: string | null;
  pr_url?: string | null;
  updated_at: number;
};

export type Notice = {
  id: string;
  severity: "info" | "important" | "critical";
  body: string;
  // 次回ポーリングまでの推奨秒（サーバ推奨値）。
  nextPollHint?: number;
};

// 組織ロール（§6.4）。
export type Role = "admin" | "accounting" | "clerical" | "other" | "member";

// プラン→初期エンタイトルメント（free は即時。plus/pro も入金確認まで free 相当＝§2.3）。
export function initialEntitlement(_plan: Plan): Entitlement {
  return "free"; // plus/pro も入金前は free 相当（プロビジョナル）
}

// プラン→そのプランに見合う実体エンタイトルメント（課金確定後／資格喪失からの復帰先）。
// initialEntitlement（申込直後＝常に free のプロビジョナル）とは別物。billing.ts の昇格と同一規律。
// nonprofit は審査通過で初めて nonprofit 資格＝ここでは free（却下・剥奪時の戻し先）。
export function entitlementForPlan(plan: Plan): Entitlement {
  return plan === "plus" ? "plus" : plan === "pro" ? "pro" : "free";
}

// エンタイトルメントの序列（free < plus < pro < enterprise < test=全機能）。enterprise/test は全ゲート通過。
export const ENTITLEMENT_RANK: Record<Entitlement, number> = { free: 0, plus: 1, pro: 2, nonprofit: 40, enterprise: 50, test: 99 };

// min 以上のエンタイトルメントか（例：atLeast(e,"plus") で AI 系を判定）。
export function atLeast(e: Entitlement, min: Entitlement): boolean {
  return ENTITLEMENT_RANK[e] >= ENTITLEMENT_RANK[min];
}

// ユーザー向けプラン表示名。
export function planLabel(p: Plan | Entitlement): string {
  return p === "test" ? "テスト（全機能解放）" : p === "enterprise" ? "エンタープライズ（個別相談・全機能）" : p === "nonprofit" ? "NonProfit（非営利・全機能・要審査）" : p === "pro" ? "Pro（エージェント）" : p === "plus" ? "Plus（AI）" : "Free（無料）";
}
