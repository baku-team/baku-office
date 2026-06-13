// 公開ディレクトリ中枢（ホスト側）：本人(license)が掲載、不特定多数が検索。
// 検索は client が生成したクエリ埋め込みのコサイン類似＋キーワード/タグでスコア合成（ホストはAI非依存）。
// 信頼スコアは plan/運用歴/a2a_audit 拒否率/通報数から算出し、招待なし公開A2Aの受付判定に使う。
import { nowSec } from "./host.ts";
import { randomId } from "@baku-office/shared";

export type DirProfile = { summary?: string; tags?: string[]; contact?: string; website?: string; public_actions?: { name: string; label?: string; argHint?: string }[] };
export type DirEntry = {
  license_id: string; org_name: string; profile: DirProfile; embedding: number[] | null;
  verification: Record<string, unknown>; trust_score: number; listed: number; blocked: number; updated_at: number;
  certified: number; certified_at: number | null; certified_note: string | null;
};

const REPORT_BLOCK_THRESHOLD = 3; // 未対応通報がこの数に達したら自動 block。

function parse<T>(s: string | null, fb: T): T { try { return s ? JSON.parse(s) as T : fb; } catch { return fb; } }

// 本人 license のみ掲載（upsert）。掲載時に信頼スコアを再計算。
export async function publishEntry(env: Env, licenseId: string, e: { orgName: string; profile: DirProfile; embedding: number[] | null; verification: Record<string, unknown>; listed: boolean }): Promise<{ ok: boolean; trust: number }> {
  const trust = await recomputeTrust(env, licenseId);
  await env.DB.prepare(
    `INSERT INTO public_directory (license_id,org_name,profile,embedding,verification,trust_score,listed,blocked,updated_at)
     VALUES (?,?,?,?,?,?,?,0,?)
     ON CONFLICT(license_id) DO UPDATE SET org_name=excluded.org_name, profile=excluded.profile, embedding=excluded.embedding,
       verification=excluded.verification, trust_score=excluded.trust_score, listed=excluded.listed, updated_at=excluded.updated_at`,
  ).bind(licenseId, e.orgName, JSON.stringify(e.profile ?? {}), e.embedding ? JSON.stringify(e.embedding) : null, JSON.stringify(e.verification ?? {}), trust, e.listed ? 1 : 0, nowSec()).run();
  return { ok: true, trust };
}

export async function unpublishEntry(env: Env, licenseId: string): Promise<void> {
  await env.DB.prepare("UPDATE public_directory SET listed=0, updated_at=? WHERE license_id=?").bind(nowSec(), licenseId).run();
}

export async function getEntry(env: Env, licenseId: string): Promise<DirEntry | null> {
  const r = await env.DB.prepare("SELECT * FROM public_directory WHERE license_id=?").bind(licenseId).first<{ license_id: string; org_name: string; profile: string; embedding: string | null; verification: string; trust_score: number; listed: number; blocked: number; updated_at: number; certified: number; certified_at: number | null; certified_note: string | null }>();
  if (!r) return null;
  return { license_id: r.license_id, org_name: r.org_name, profile: parse<DirProfile>(r.profile, {}), embedding: parse<number[] | null>(r.embedding, null), verification: parse<Record<string, unknown>>(r.verification, {}), trust_score: r.trust_score, listed: r.listed, blocked: r.blocked, updated_at: r.updated_at, certified: r.certified ?? 0, certified_at: r.certified_at ?? null, certified_note: r.certified_note ?? null };
}

// 公式認証の付与/取消（ホスト管理者・人と会って事業確認後に手動）。trust を即再計算。
export async function setCertified(env: Env, licenseId: string, on: boolean, note?: string): Promise<{ ok: boolean }> {
  await env.DB.prepare("UPDATE public_directory SET certified=?, certified_at=?, certified_note=? WHERE license_id=?")
    .bind(on ? 1 : 0, on ? nowSec() : null, note ?? null, licenseId).run();
  const t = await recomputeTrust(env, licenseId);
  await env.DB.prepare("UPDATE public_directory SET trust_score=? WHERE license_id=?").bind(t, licenseId).run();
  return { ok: true };
}

// 公開アクション名が掲載団体の公開リストに含まれるか（relayPublic のゲート）。
export function hasPublicAction(entry: DirEntry, action: string): boolean {
  return (entry.profile.public_actions ?? []).some((a) => a.name === action);
}

const cosine = (a: number[], b: number[]): number => {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
};

export type Candidate = { license_id: string; org_name: string; summary: string; tags: string[]; verified: boolean; certified: boolean; trust_score: number; public_actions: { name: string; label?: string }[]; score: number };

// 掲載中(listed=1 & blocked=0)を取得し、埋め込みコサイン＋キーワード/タグでスコア合成。小規模Nを想定。
// 精度向上：語の重なり数で部分加点、タイトル一致を強め、信頼/公認を弱い加点に。certifiedOnly で公認限定。
export async function searchEntries(env: Env, opts: { query?: string; queryEmbedding?: number[] | null; tags?: string[]; limit?: number; certifiedOnly?: boolean }): Promise<Candidate[]> {
  const { results } = await env.DB.prepare("SELECT license_id,org_name,profile,embedding,verification,trust_score,certified FROM public_directory WHERE listed=1 AND blocked=0").all<{ license_id: string; org_name: string; profile: string; embedding: string | null; verification: string; trust_score: number; certified: number }>();
  const q = (opts.query ?? "").toLowerCase().trim();
  const qWords = q.split(/[\s、,　]+/).filter((w) => w.length >= 2);
  const wantTags = (opts.tags ?? []).map((t) => t.toLowerCase());
  const noCriteria = !opts.queryEmbedding && !q && !wantTags.length;
  const cands: Candidate[] = [];
  for (const r of results) {
    if (opts.certifiedOnly && r.certified !== 1) continue;
    const profile = parse<DirProfile>(r.profile, {});
    const ver = parse<Record<string, unknown>>(r.verification, {});
    const emb = parse<number[] | null>(r.embedding, null);
    const tags = (profile.tags ?? []).map((t) => String(t));
    const hay = (r.org_name + " " + (profile.summary ?? "") + " " + tags.join(" ")).toLowerCase();
    let score = 0;
    // 意味検索（埋め込みコサイン）を主軸に（0..1）。
    if (opts.queryEmbedding && emb) score += cosine(opts.queryEmbedding, emb) * 1.0;
    // キーワード：完全部分一致に加え、語ごとの重なりで部分加点（表記ゆれに強く）。
    if (q && hay.includes(q)) score += 0.5;
    if (qWords.length) { const hit = qWords.filter((w) => hay.includes(w)).length; score += 0.25 * (hit / qWords.length); }
    if (r.org_name.toLowerCase().includes(q) && q) score += 0.2; // 団体名一致は強め
    if (wantTags.length) { const hit = tags.filter((t) => wantTags.includes(t.toLowerCase())).length; if (hit) score += 0.3 * Math.min(2, hit); }
    if (noCriteria) score = 0.1; // 無条件は全件低スコアで列挙
    // 信頼/公認の弱い加点（同点時の並びに効く・主たる関連度は意味/語）。
    score += r.trust_score * 0.1 + (r.certified === 1 ? 0.1 : 0);
    if (score <= 0) continue;
    cands.push({
      license_id: r.license_id, org_name: r.org_name, summary: profile.summary ?? "", tags,
      verified: ver.exists === true || (typeof ver.score === "number" && ver.score >= 0.5),
      certified: r.certified === 1,
      trust_score: r.trust_score, public_actions: (profile.public_actions ?? []).map((a) => ({ name: a.name, label: a.label })), score,
    });
  }
  cands.sort((a, b) => b.score - a.score || b.trust_score - a.trust_score);
  return cands.slice(0, opts.limit ?? 20);
}

// 信頼スコア（0..1）：プラン/運用歴/audit 拒否率/通報数から算出。
export async function recomputeTrust(env: Env, licenseId: string): Promise<number> {
  const lic = await env.DB.prepare("SELECT entitlement,created_at,last_seen,status FROM licenses WHERE license_id=?").bind(licenseId).first<{ entitlement: string; created_at: number; last_seen: number | null; status: string }>();
  if (!lic || lic.status !== "active") return 0;
  let score = 0.2; // ライセンス実在の基礎点
  // プラン（有料ほど信頼）。
  const planPts: Record<string, number> = { free: 0, plus: 0.15, pro: 0.25, nonprofit: 0.2, enterprise: 0.3, test: 0.1 };
  score += planPts[lic.entitlement] ?? 0;
  // 運用歴（90日以上で加点）。
  const ageDays = (nowSec() - (lic.created_at ?? nowSec())) / 86400;
  score += Math.min(0.2, (ageDays / 90) * 0.2);
  // 最近の疎通（30日以内）。
  if (lic.last_seen && nowSec() - lic.last_seen < 30 * 86400) score += 0.1;
  // a2a_audit 拒否率（直近の denied/error が多いと減点）。
  const au = await env.DB.prepare("SELECT SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok, COUNT(*) AS n FROM a2a_audit WHERE from_license=?").bind(licenseId).first<{ ok: number | null; n: number }>();
  if (au && au.n >= 5) { const okRate = (au.ok ?? 0) / au.n; score += (okRate - 0.5) * 0.2; }
  // 未対応通報で減点。
  const rep = await env.DB.prepare("SELECT COUNT(*) AS n FROM directory_reports WHERE target_license=? AND status='open'").bind(licenseId).first<{ n: number }>();
  score -= Math.min(0.4, (rep?.n ?? 0) * 0.15);
  // 貘公式認証（人と会って事業確認）は強い信頼根拠＝大きく加点。
  const cert = await env.DB.prepare("SELECT certified FROM public_directory WHERE license_id=?").bind(licenseId).first<{ certified: number }>();
  if (cert?.certified === 1) score += 0.4;
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

// 全掲載団体の trust を再計算（scheduler 相乗り・1回あたり limit 件）。古い順に回す。
export async function recomputeAllTrust(env: Env, limit = 50): Promise<number> {
  const { results } = await env.DB.prepare("SELECT license_id FROM public_directory ORDER BY updated_at ASC LIMIT ?").bind(limit).all<{ license_id: string }>();
  let n = 0;
  for (const r of results) {
    const t = await recomputeTrust(env, r.license_id);
    await env.DB.prepare("UPDATE public_directory SET trust_score=? WHERE license_id=?").bind(t, r.license_id).run();
    n++;
  }
  return n;
}

// ===== ホスト管理用 =====
export async function listAll(env: Env): Promise<(DirEntry & { open_reports: number })[]> {
  const { results } = await env.DB.prepare("SELECT license_id FROM public_directory ORDER BY certified DESC, trust_score DESC, updated_at DESC LIMIT 500").all<{ license_id: string }>();
  const out: (DirEntry & { open_reports: number })[] = [];
  for (const r of results) {
    const e = await getEntry(env, r.license_id);
    if (!e) continue;
    const rc = await env.DB.prepare("SELECT COUNT(*) AS n FROM directory_reports WHERE target_license=? AND status='open'").bind(r.license_id).first<{ n: number }>();
    out.push({ ...e, open_reports: rc?.n ?? 0 });
  }
  return out;
}
export async function listReports(env: Env, status = "open"): Promise<{ id: string; target_license: string; reporter_license: string | null; reason: string | null; detail: string | null; status: string; created_at: number }[]> {
  return (await env.DB.prepare("SELECT id,target_license,reporter_license,reason,detail,status,created_at FROM directory_reports WHERE status=? ORDER BY created_at DESC LIMIT 200").bind(status).all<{ id: string; target_license: string; reporter_license: string | null; reason: string | null; detail: string | null; status: string; created_at: number }>()).results;
}
export async function setReportStatus(env: Env, id: string, status: "reviewed" | "dismissed"): Promise<void> {
  await env.DB.prepare("UPDATE directory_reports SET status=? WHERE id=?").bind(status, id).run();
}

export async function reportEntry(env: Env, targetLicense: string, reporterLicense: string | null, reason: string, detail?: string): Promise<{ ok: boolean; blocked: boolean }> {
  await env.DB.prepare("INSERT INTO directory_reports (id,target_license,reporter_license,reason,detail,status,created_at) VALUES (?,?,?,?,?,'open',?)")
    .bind(randomId(8), targetLicense, reporterLicense, reason, detail ?? null, nowSec()).run();
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM directory_reports WHERE target_license=? AND status='open'").bind(targetLicense).first<{ n: number }>();
  let blocked = false;
  if ((cnt?.n ?? 0) >= REPORT_BLOCK_THRESHOLD) { await blockEntry(env, targetLicense, true); blocked = true; }
  await recomputeTrust(env, targetLicense).then((t) => env.DB.prepare("UPDATE public_directory SET trust_score=? WHERE license_id=?").bind(t, targetLicense).run()).catch(() => {});
  return { ok: true, blocked };
}

export async function blockEntry(env: Env, targetLicense: string, on: boolean): Promise<void> {
  await env.DB.prepare("UPDATE public_directory SET blocked=?, updated_at=? WHERE license_id=?").bind(on ? 1 : 0, nowSec(), targetLicense).run();
}
