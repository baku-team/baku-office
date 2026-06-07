// 共有型（設計書 v1.0 準拠）。

// エンタイトルメント状態（§2・§4）。free=無料 / plus=AI / pro=エージェント / test=全機能解放（管理画面で付与・非売）。
export type Entitlement = "free" | "plus" | "pro" | "test";

// プラン（申込時の選択。入金前は free 相当で稼働＝プロビジョナル§2.3）。test は購入プランではない。
export type Plan = "free" | "plus" | "pro";

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

// エンタイトルメントの序列（free < plus < pro < test=全機能）。
export const ENTITLEMENT_RANK: Record<Entitlement, number> = { free: 0, plus: 1, pro: 2, test: 99 };

// min 以上のエンタイトルメントか（例：atLeast(e,"plus") で AI 系を判定）。
export function atLeast(e: Entitlement, min: Entitlement): boolean {
  return ENTITLEMENT_RANK[e] >= ENTITLEMENT_RANK[min];
}

// ユーザー向けプラン表示名。
export function planLabel(p: Plan | Entitlement): string {
  return p === "test" ? "テスト（全機能解放）" : p === "pro" ? "Pro（エージェント）" : p === "plus" ? "Plus（AI）" : "Free（無料）";
}
