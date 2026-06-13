// 資料インポートパーツ（アプリ）。実体は /import の管理画面（Plus）。
import type { Part } from "../core/parts.ts";

export const importPart: Part = {
  id: "import",
  name: "書類の取り込み",
  version: "1.0.0",
  category: "庶務",
  description: "Notion / Google ドライブから資料を取り込み。",
  minPlan: "plus",
  orgOnly: true,
  menu: [{ href: "/import", label: "書類の取り込み" }],
};
