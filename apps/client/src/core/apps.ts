// アプリ基盤（レジストリ／マーケット・導入・アプリ間連動・権限）。
// パーツ＝アプリ。ここで「公開カタログ／団体ごとの導入／アプリ間API／権限宣言」を扱う。
// セキュリティ方針：アプリはコア能力 ctx（スコープ済みPort）にのみ触れ、生env・署名鍵・認証内部・破壊操作・
// 他テナントには到達不可。アプリ間呼び出しは宣言した permission の範囲だけ許可（破壊・認証回避は構造的に拒絶）。
import type { Ctx } from "./ports.ts";
import { registeredParts, enabledPartIds, setEnabledPartIds } from "./parts.ts";

// アプリが要求できる能力（マニフェストで宣言→許可分のみ付与）。
// 破壊的・特権操作（削除/課金/ライセンス/admin）は列挙しない＝アプリには渡さない。
export type Permission =
  | "db:read" | "db:write"
  | "storage:read" | "storage:write"
  | "ai" | "agent"
  | "members:read"
  | "net"; // 外部送信（将来 allowlist 必須）

// アプリが公開する操作（アプリ間連動の単位）。requiredPermission は呼び出し元に要求する権限。
export interface AppAction {
  name: string;
  description?: string;
  requiredPermission?: Permission;
  run(ctx: Ctx, args: Record<string, unknown>, caller?: string): Promise<unknown>;
}

// 公開カタログ（マーケット／設定UI用のマニフェスト要約）。
export function appCatalog(): { id: string; name: string; version: string; description?: string; category?: string; permissions: readonly Permission[]; actions: string[] }[] {
  return registeredParts().map((p) => ({
    id: p.id, name: p.name, version: p.version, description: p.description, category: p.category,
    permissions: p.permissions ?? [], actions: (p.actions ?? []).map((a) => a.name),
  }));
}

// Plus 以上で必須のアプリ（AIチャット＝設定・開発のハブ）。導入から外せない。
export const MANDATORY_APPS = ["chat"];

// 団体に導入済みのアプリ id（最小構成＝設定のみ＋必須アプリ。enabled_parts を導入集合として使う）。
export async function installedAppIds(ctx: Ctx): Promise<string[]> {
  const known = new Set(registeredParts().map((p) => p.id));
  const stored = await enabledPartIds(ctx); // null=全導入（既存挙動の既定）
  const ids = stored ?? [...known];
  for (const m of MANDATORY_APPS) if (known.has(m) && !ids.includes(m)) ids.push(m);
  return ids.filter((id) => known.has(id));
}
export async function installApp(ctx: Ctx, id: string): Promise<string[]> {
  const base = (await enabledPartIds(ctx)) ?? registeredParts().map((p) => p.id);
  return setEnabledPartIds(ctx, base.includes(id) ? base : [...base, id]);
}
export async function uninstallApp(ctx: Ctx, id: string): Promise<string[]> {
  if (MANDATORY_APPS.includes(id)) throw new Error("このアプリは必須のため削除できません。");
  const base = (await enabledPartIds(ctx)) ?? registeredParts().map((p) => p.id);
  return setEnabledPartIds(ctx, base.filter((x) => x !== id));
}

// アプリ間連動API（ctx.apps）。アプリは他アプリの公開 action を権限内で呼べる。
export interface AppsApi {
  list(): { id: string; name: string; actions: string[] }[];
  call(appId: string, action: string, args?: Record<string, unknown>, caller?: string): Promise<unknown>;
}
export function makeAppsApi(ctx: Ctx): AppsApi {
  return {
    list: () => registeredParts().map((p) => ({ id: p.id, name: p.name, actions: (p.actions ?? []).map((a) => a.name) })),
    call: async (appId, action, args = {}, caller) => {
      const app = registeredParts().find((p) => p.id === appId);
      if (!app) throw new Error(`アプリが見つかりません: ${appId}`);
      const act = (app.actions ?? []).find((a) => a.name === action);
      if (!act) throw new Error(`操作が見つかりません: ${appId}.${action}`);
      // 権限：呼び出し元アプリが target action の requiredPermission を保有していなければ拒否。
      if (act.requiredPermission && caller) {
        const callerApp = registeredParts().find((p) => p.id === caller);
        const granted = callerApp?.permissions ?? [];
        if (!granted.includes(act.requiredPermission)) throw new Error(`権限がありません: ${caller} は ${act.requiredPermission} を保有していません`);
      }
      return act.run(ctx, args, caller);
    },
  };
}
