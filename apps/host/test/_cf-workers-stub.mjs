// テスト用の cloudflare:workers スタブ。node:test は Workers ランタイムではないため、
// import { env } from "cloudflare:workers" を解決できるよう本モジュールへ差し替える（_cf-hooks.mjs）。
// env は可変オブジェクト＝テストが各ケースで中身を差し替える（ルートと同一インスタンスを共有）。
export const env = {};
