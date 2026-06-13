// HP/LP 公開パーツ（アプリ）。実体は /settings/site の管理画面（Pro）。
import type { Part } from "../core/parts.ts";

export const sitePart: Part = {
  id: "site",
  name: "HP/LP 公開",
  version: "1.0.0",
  category: "公開",
  description: "サイト/LP の公開・会員申込フォーム。",
  minPlan: "pro",
  orgOnly: true,
  menu: [{ href: "/settings/site", label: "HP/LP 公開" }],
};
