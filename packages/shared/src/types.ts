// 共有型（設計書 v1.0 準拠）。

// エンタイトルメント状態（§2・§4）。free=X相当 / Y=AI / Z=エージェント。
export type Entitlement = "free" | "Y" | "Z";

// プラン（申込時の選択。入金前は free 相当で稼働＝プロビジョナル§2.3）。
export type Plan = "X" | "Y" | "Z";

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

// プラン→初期エンタイトルメント（入金前/Xは free。Y/Zは入金確認で昇格＝§2.3）。
export function initialEntitlement(plan: Plan): Entitlement {
  return plan === "X" ? "free" : "free"; // Y/Zも入金前は free 相当（プロビジョナル）
}
