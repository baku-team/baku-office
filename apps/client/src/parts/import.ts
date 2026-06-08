// 資料インポートパーツ（アプリ）。実体は /import の管理画面（Plus）。
import type { Part } from "../core/parts.ts";

export const importPart: Part = {
  id: "import",
  name: "資料インポート",
  version: "1.0.0",
  category: "庶務",
  description: "Notion / Google ドライブから資料を取り込み。",
  minPlan: "plus",
  menu: [{ href: "/import", label: "資料インポート" }],
};
