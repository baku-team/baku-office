// Google カレンダー連携パーツ（Pro以上）。統合 Google 連携（lib/google.ts）の access token で
// Calendar API v3 をオンデマンド呼び出し。予定の閲覧／作成（Meet付き会議の発行）／編集／削除。
import type { Part } from "../core/parts.ts";
import type { Ctx } from "../core/ports.ts";
import { randomId } from "@baku-office/shared";

const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TZ = "Asia/Tokyo";
const NEED_CONNECT = "Google 連携が未設定です。連携設定（カレンダー画面）から連携してください。";

type GEvent = {
  id?: string; summary?: string; description?: string;
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  hangoutLink?: string; htmlLink?: string;
  conferenceData?: { entryPoints?: { uri?: string }[] };
};

function fmtWhen(e: GEvent): string {
  return (e.start?.dateTime ?? e.start?.date ?? "?").slice(0, 16).replace("T", " ");
}

async function listEvents(ctx: Ctx, a: { time_min?: string; time_max?: string; query?: string; max?: number }): Promise<string> {
  const u = new URL(CAL);
  u.searchParams.set("singleEvents", "true");
  u.searchParams.set("orderBy", "startTime");
  u.searchParams.set("maxResults", String(Math.min(a.max ?? 20, 50)));
  u.searchParams.set("timeMin", a.time_min || new Date().toISOString());
  if (a.time_max) u.searchParams.set("timeMax", a.time_max);
  if (a.query) u.searchParams.set("q", a.query);
  const r = await ctx.google.fetch(u.toString());
  if (!r) return NEED_CONNECT;
  if (!r.ok) return `カレンダー取得に失敗しました（${r.status}）。`;
  const d = (await r.json()) as { items?: GEvent[] };
  const items = d.items ?? [];
  if (!items.length) return "該当する予定はありません。";
  return items.map((e) => {
    const meet = e.hangoutLink || e.conferenceData?.entryPoints?.find((p) => p.uri)?.uri;
    return `・${fmtWhen(e)} ${e.summary ?? "(無題)"}${meet ? `\n  Meet: ${meet}` : ""}（id:${e.id}）`;
  }).join("\n");
}

async function createEvent(ctx: Ctx, a: { title: string; start: string; end: string; description?: string; with_meet?: boolean }): Promise<string> {
  const body: Record<string, unknown> = {
    summary: a.title,
    description: a.description ?? undefined,
    start: { dateTime: a.start, timeZone: TZ },
    end: { dateTime: a.end, timeZone: TZ },
  };
  if (a.with_meet) {
    body.conferenceData = { createRequest: { requestId: randomId(), conferenceSolutionKey: { type: "hangoutsMeet" } } };
  }
  const u = new URL(CAL);
  if (a.with_meet) u.searchParams.set("conferenceDataVersion", "1");
  const r = await ctx.google.fetch(u.toString(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r) return NEED_CONNECT;
  if (!r.ok) return `予定作成に失敗しました（${r.status}）。`;
  const e = (await r.json()) as GEvent;
  const meet = e.hangoutLink || e.conferenceData?.entryPoints?.find((p) => p.uri)?.uri;
  return `予定を作成しました：${fmtWhen(e)} ${e.summary ?? a.title}${meet ? `\nMeet: ${meet}` : ""}`;
}

async function updateEvent(ctx: Ctx, a: { event_id: string; title?: string; start?: string; end?: string; description?: string }): Promise<string> {
  const body: Record<string, unknown> = {};
  if (a.title !== undefined) body.summary = a.title;
  if (a.description !== undefined) body.description = a.description;
  if (a.start) body.start = { dateTime: a.start, timeZone: TZ };
  if (a.end) body.end = { dateTime: a.end, timeZone: TZ };
  const r = await ctx.google.fetch(`${CAL}/${encodeURIComponent(a.event_id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r) return NEED_CONNECT;
  if (!r.ok) return `予定の更新に失敗しました（${r.status}）。`;
  return "予定を更新しました。";
}

async function deleteEvent(ctx: Ctx, a: { event_id: string }): Promise<string> {
  const r = await ctx.google.fetch(`${CAL}/${encodeURIComponent(a.event_id)}`, { method: "DELETE" });
  if (!r) return NEED_CONNECT;
  if (!r.ok && r.status !== 410) return `予定の削除に失敗しました（${r.status}）。`;
  return "予定を削除しました。";
}

const ISO = { type: "string", description: "ISO8601日時（例 2026-06-20T10:00:00）" };

export const calendarPart: Part = {
  id: "calendar",
  name: "カレンダー",
  version: "1.0.0",
  category: "庶務",
  description: "Google カレンダーの予定を閲覧・作成（Meet付き会議の発行）・編集・削除。",
  permissions: ["net"],
  minPlan: "pro",
  menu: [{ href: "/calendar", label: "カレンダー" }],
  agentTools: [
    {
      name: "list_events",
      description: "Googleカレンダーの予定を一覧（既定は今後の予定）",
      parameters: { type: "object", properties: { time_min: ISO, time_max: ISO, query: { type: "string" }, max: { type: "number" } } },
      run: (ctx, _owner, _b, a) => listEvents(ctx, { time_min: a.time_min as string, time_max: a.time_max as string, query: a.query as string, max: a.max as number }),
    },
    {
      name: "create_event",
      description: "Googleカレンダーに予定を作成。with_meet=true で Google Meet 付き会議を発行",
      parameters: { type: "object", properties: { title: { type: "string" }, start: ISO, end: ISO, description: { type: "string" }, with_meet: { type: "boolean", description: "Meetリンクを発行する" } }, required: ["title", "start", "end"] },
      run: (ctx, _owner, _b, a) => createEvent(ctx, { title: String(a.title), start: String(a.start), end: String(a.end), description: a.description as string, with_meet: !!a.with_meet }),
    },
    {
      name: "update_event",
      description: "既存の予定を更新（event_id 指定）",
      unattended: false, // 無人ジョブで既存予定を改変させない
      parameters: { type: "object", properties: { event_id: { type: "string" }, title: { type: "string" }, start: ISO, end: ISO, description: { type: "string" } }, required: ["event_id"] },
      run: (ctx, _owner, _b, a) => updateEvent(ctx, { event_id: String(a.event_id), title: a.title as string, start: a.start as string, end: a.end as string, description: a.description as string }),
    },
    {
      name: "delete_event",
      description: "予定を削除（event_id 指定）",
      unattended: false, // 無人ジョブで予定削除させない（破壊系）
      parameters: { type: "object", properties: { event_id: { type: "string" } }, required: ["event_id"] },
      run: (ctx, _owner, _b, a) => deleteEvent(ctx, { event_id: String(a.event_id) }),
    },
  ],
};

export { listEvents, createEvent };
