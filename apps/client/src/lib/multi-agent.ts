// マルチエージェント：役割（ロール）定義とロール別の道具絞り込み（Pro 以上）。
// スーパーバイザー（親）が run_subagent / run_team で子エージェントへ委譲する際に使う。
import type { Part, AgentTool } from "../core/parts.ts";
import { toolsOf } from "../core/parts.ts";

export type RoleKey = "planner" | "accounting" | "clerical" | "research" | "writer" | "general";

export const ROLES: Record<RoleKey, { label: string; system: string; categories?: string[] }> = {
  planner: { label: "計画", system: "あなたは計画担当のサブエージェントです。与えられたタスクを分解・整理し、必要なら道具を使って要点を簡潔にまとめて返します。" },
  accounting: { label: "会計", system: "あなたは会計担当のサブエージェントです。会計・取引・領収書の集計や記録を正確に行い、結果を簡潔に返します。", categories: ["会計"] },
  clerical: { label: "庶務", system: "あなたは庶務担当のサブエージェントです。名簿・予定・メモ・議事録・ナレッジに関する作業を行い、結果を簡潔に返します。", categories: ["庶務"] },
  research: { label: "調査", system: "あなたは調査担当のサブエージェントです。web検索やナレッジ検索で根拠を集め、出典を添えて要約して返します。" },
  writer: { label: "文書", system: "あなたは文書担当のサブエージェントです。依頼に沿って資料・文章を作成し、必要なら make_document で出力します。" },
  general: { label: "汎用", system: "あなたは汎用担当のサブエージェントです。割り当てられたタスクを最適な道具で遂行し、結果を簡潔に返します。" },
};

export function normalizeRole(r: string): RoleKey {
  return (["planner", "accounting", "clerical", "research", "writer", "general"] as RoleKey[]).includes(r as RoleKey) ? (r as RoleKey) : "general";
}

// ロールに見せる「業務道具」を絞る。categories 指定があればそのカテゴリの Part の道具のみ、無ければ全有効 Part の道具。
export function toolsForRole(role: RoleKey, parts: Part[]): AgentTool[] {
  const r = ROLES[role];
  const sel = r?.categories ? parts.filter((p) => !p.category || r.categories!.includes(p.category)) : parts;
  return toolsOf(sel);
}

export const ROLE_LIST = (Object.keys(ROLES) as RoleKey[]).map((k) => `${k}=${ROLES[k].label}`).join(" / ");
