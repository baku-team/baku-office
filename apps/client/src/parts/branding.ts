// ブランド設定（見た目・テーマ）パーツ（アプリ）。実体は /settings/theme の管理画面（Plus）。
import type { Part } from "../core/parts.ts";

export const brandingPart: Part = {
  id: "branding",
  name: "ブランド設定（見た目）",
  version: "1.0.0",
  category: "カスタマイズ",
  description: "ブランド名・ロゴ・配色を団体ごとに上書き。",
  minPlan: "plus",
  menu: [{ href: "/settings/theme", label: "ブランド設定" }],
};
