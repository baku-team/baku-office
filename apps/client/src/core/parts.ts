// Part 契約とレジストリ（移植性アーキ §4/§14-1）。
// パーツ＝業務モジュール。ここではエージェント道具の登録のみ（migrations/routes は後続Phase）。
// コアのエージェントは「登録された道具」を宣言・実行する＝コア/パーツ分離の実体。
import type { Ctx } from "./ports.ts";
import type { Role, Entitlement } from "@baku-office/shared";
import type { NavItem } from "./nav.ts";
import type { Permission, AppAction } from "./apps.ts";

export interface AgentTool {
  name: string;
  description: string;
  parameters: object;                 // JSON-Schema風（Gemini/Claude 双方の宣言に使う）
  requiredRole?: readonly Role[];      // 認可（§14-1）。未指定＝全 active 会員。
  unattended?: boolean;                // 無人ジョブ（cron自動巡回等）での提示可否。明示 false＝対外/破壊系として遮断。未指定＝可。
  run(ctx: Ctx, owner: string, baseUrl: string, args: Record<string, unknown>): Promise<string>;
}

// Part ＝再利用可能な「アプリ（業務モジュール）」。複数団体で共有・再利用でき、
// コア更新（CI配布）で全導入先に波及する。派生は id を変えてコピー＝新アプリ（§移植性アーキ）。
// ホーム（ダッシュボード）に出すアプリ提供ウィジェット。値カード（タイトル＋数値＋補足）。
export interface AppWidget {
  id: string;
  title: string;
  span?: number; // ホームでの表示幅（列数 1〜3・既定1）。アプリ側がウィジェットの大きさを制御。
  run(ctx: Ctx, owner: string): Promise<{ value: string; sub?: string }>;
}

export interface Part {
  id: string;            // アプリの一意キー（派生時は新IDにする）
  name: string;
  version: string;       // アプリ版（semver推奨）。更新の識別・互換管理に使う
  description?: string;
  category?: string;     // マーケット分類（core/会計/庶務/…）
  derivedFrom?: string;  // 派生元アプリの id（派生で新アプリを作った場合）
  permissions?: readonly Permission[]; // 要求能力（宣言した分のみ付与・§セキュリティ）
  agentTools?: AgentTool[];
  actions?: AppAction[]; // アプリ間連動で他アプリへ公開する操作
  menu?: NavItem[]; // 第2層：このパーツが提供するナビ項目（UIパーツ用）。
  widgets?: AppWidget[]; // ホームに出す連携ウィジェット（例 総会員数・当月収支）。
  minPlan?: Entitlement; // このアプリの利用に必要な最低プラン（launcher/マーケットの表示ゲート。未指定=Free）。
}

// 有効パーツが提供するホームウィジェットを集約。
export function widgetsOf(parts: Part[]): AppWidget[] {
  return parts.flatMap((p) => p.widgets ?? []);
}

// 有効パーツが提供するナビ項目を集約（第2層）。
export function partMenuItems(enabledIds: readonly string[] | null): NavItem[] {
  return enabledParts(enabledIds).flatMap((p) => p.menu ?? []);
}

const REGISTRY = new Map<string, Part>();
export function registerPart(p: Part): void {
  if (!REGISTRY.has(p.id)) REGISTRY.set(p.id, p); // id で冪等（多重 import でも二重登録しない）
}
export function registeredParts(): Part[] {
  return [...REGISTRY.values()];
}
export function allAgentTools(): AgentTool[] {
  return registeredParts().flatMap((p) => p.agentTools ?? []);
}
export function findAgentTool(name: string): AgentTool | undefined {
  return allAgentTools().find((t) => t.name === name);
}

// ---- Phase 5：団体ごとの「有効パーツ集合」（移植性アーキ §5/§13.5）----

// 全パーツ（アプリ）のカタログ（管理UI/設定用）。
export function partCatalog(): { id: string; name: string; version: string }[] {
  return registeredParts().map((p) => ({ id: p.id, name: p.name, version: p.version }));
}
// 有効 id 集合で絞り込む（null=全有効＝既定）。
export function enabledParts(enabledIds: readonly string[] | null): Part[] {
  const all = registeredParts();
  return enabledIds ? all.filter((p) => enabledIds.includes(p.id)) : all;
}
export function toolsOf(parts: Part[]): AgentTool[] {
  return parts.flatMap((p) => p.agentTools ?? []);
}

// 有効パーツ設定の読み書き（ctx.storage.kv に保存）。未設定=null=全有効。
const KV_ENABLED_PARTS = "enabled_parts";
export async function enabledPartIds(ctx: Ctx): Promise<string[] | null> {
  const raw = await ctx.storage.kv.get(KV_ENABLED_PARTS);
  if (!raw) return null;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(String) : null; } catch { return null; }
}
export async function setEnabledPartIds(ctx: Ctx, ids: string[]): Promise<string[]> {
  const known = new Set(registeredParts().map((p) => p.id));
  const clean = [...new Set(ids.map(String))].filter((id) => known.has(id));
  await ctx.storage.kv.put(KV_ENABLED_PARTS, JSON.stringify(clean));
  return clean;
}
