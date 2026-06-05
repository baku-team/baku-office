// HP/LP 公開機構（Pro以上）。サブパス公開（/site=home、/lp/<slug>）。会員管理と連動。
import { nowSec } from "./accounting.ts";

export type Site = { slug: string; title: string; body: string | null; published: number; show_join: number; created_at: number; updated_at: number };

export async function listSites(env: Env): Promise<Site[]> {
  return (await env.DB.prepare("SELECT * FROM sites ORDER BY (slug='home') DESC, updated_at DESC").all<Site>()).results;
}
export async function getSite(env: Env, slug: string): Promise<Site | null> {
  return (await env.DB.prepare("SELECT * FROM sites WHERE slug=?").bind(slug).first<Site>()) ?? null;
}
export async function getPublishedSite(env: Env, slug: string): Promise<Site | null> {
  return (await env.DB.prepare("SELECT * FROM sites WHERE slug=? AND published=1").bind(slug).first<Site>()) ?? null;
}
export async function upsertSite(env: Env, a: { slug: string; title: string; body?: string; published?: boolean; show_join?: boolean }): Promise<void> {
  const now = nowSec();
  await env.DB.prepare(
    "INSERT INTO sites (slug,title,body,published,show_join,created_at,updated_at) VALUES (?,?,?,?,?,?,?) " +
    "ON CONFLICT(slug) DO UPDATE SET title=excluded.title,body=excluded.body,published=excluded.published,show_join=excluded.show_join,updated_at=excluded.updated_at",
  ).bind(a.slug, a.title, a.body ?? null, a.published ? 1 : 0, a.show_join ? 1 : 0, now, now).run();
}
export async function deleteSite(env: Env, slug: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sites WHERE slug=?").bind(slug).run();
}
