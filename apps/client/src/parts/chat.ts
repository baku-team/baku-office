// AIチャットアプリ（Plus以上で必須・設定/開発のハブ）。
// 画面は /chat（既存）。ここではアプリ（マーケット）としてのマニフェストを登録する。
import type { Part } from "../core/parts.ts";

export const chatApp: Part = {
  id: "chat",
  name: "AIチャット",
  version: "1.0.0",
  category: "core",
  description: "AIと対話して操作・他アプリ呼び出し・各種設定/開発を行うハブ（Plus以上で必須）。",
  permissions: ["ai", "agent", "db:read"],
  menu: [{ href: "/chat", label: "AIチャット" }],
};
