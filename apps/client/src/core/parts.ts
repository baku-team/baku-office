// Part 契約とレジストリ（移植性アーキ §4/§14-1）。
// パーツ＝業務モジュール。ここではエージェント道具の登録のみ（migrations/routes は後続Phase）。
// コアのエージェントは「登録された道具」を宣言・実行する＝コア/パーツ分離の実体。
import type { Ctx } from "./ports.ts";
import type { Role } from "@baku-office/shared";
import type { NavItem } from "./nav.ts";

export interface AgentTool {
  name: string;
  description: string;
  parameters: object;                 // JSON-Schema風（Gemini/Claude 双方の宣言に使う）
  requiredRole?: readonly Role[];      // 認可（§14-1）。未指定＝全 active 会員。
  run(ctx: Ctx, owner: string, baseUrl: string, args: Record<string, unknown>): Promise<string>;
}

export interface Part {
  id: string;
  name: string;
  agentTools?: AgentTool[];
  menu?: NavItem[]; // 第2層：このパーツが提供するナビ項目（UIパーツ用）。
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

// 全パーツのカタログ（管理UI/設定用）。
export function partCatalog(): { id: string; name: string }[] {
  return registeredParts().map((p) => ({ id: p.id, name: p.name }));
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
