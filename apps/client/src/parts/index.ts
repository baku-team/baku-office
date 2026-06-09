// 組み込みパーツの登録（移植性アーキ §4/§5）。
// import 副作用で登録される。将来は Profile/有効パーツ設定で取捨選択する（§5）。
import { registerPart } from "../core/parts.ts";
import { chatApp } from "./chat.ts";
import { accountingPart } from "./accounting.ts";
import { memoPart } from "./memo.ts";
import { remindersPart } from "./reminders.ts";
import { knowledgePart } from "./knowledge.ts";
import { membersPart } from "./members.ts";
import { sitePart } from "./site.ts";
import { importPart } from "./import.ts";
import { brandingPart } from "./branding.ts";
import { calendarPart } from "./calendar.ts";
import { gmailPart } from "./gmail.ts";
import { meetPart } from "./meet.ts";
import { invoicesPart } from "./invoices.ts";

export function registerBuiltinParts(): void {
  registerPart(chatApp);
  registerPart(accountingPart);
  registerPart(memoPart);
  registerPart(remindersPart);
  registerPart(knowledgePart);
  registerPart(membersPart);
  registerPart(sitePart);
  registerPart(importPart);
  registerPart(brandingPart);
  registerPart(calendarPart);
  registerPart(gmailPart);
  registerPart(meetPart);
  registerPart(invoicesPart);
}

registerBuiltinParts();
