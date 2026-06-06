// 適合性テスト：UIカスタマイズ（共通ベース＋団体ごと上書き）の純ロジック。
import { test } from "node:test";
import assert from "node:assert/strict";
import { themeCss, brandName, sanitizeTheme, getTheme, setTheme } from "../src/core/theme.ts";
import { buildNav, getNavOverrides, setNavOverrides, type NavItem } from "../src/core/nav.ts";
import { memKv } from "./node-sqlite-adapter.ts";

const ctxKv = () => ({ storage: { kv: memKv() } }) as never;

test("theme：brandName 既定と上書き", () => {
  assert.equal(brandName(null), "baku-office");
  assert.equal(brandName({ brand: "  あおぞら会  " }), "あおぞら会");
});

test("theme：themeCss は与えた色だけ・不正値/インジェクションは捨てる", () => {
  assert.equal(themeCss({ colors: { brand: "#2563eb" } }), ":root{--brand: #2563eb;}");
  // 不正値（CSS インジェクション狙い）は除去 → 出力なし。
  assert.equal(themeCss({ colors: { brand: "#111; } body{display:none" } }), "");
  assert.equal(themeCss({}), "");
});

test("theme：sanitizeTheme は不正色/長すぎ/非httpロゴを除去", () => {
  const t = sanitizeTheme({ brand: "X".repeat(100), logoUrl: "javascript:alert(1)", colors: { brand: "#fff", bg: "url(x)" } });
  assert.equal(t.brand!.length, 40);
  assert.equal(t.logoUrl, undefined);
  assert.deepEqual(t.colors, { brand: "#fff" }); // bg は不正→除去
});

test("theme：KV 往復", async () => {
  const ctx = ctxKv();
  await setTheme(ctx, { brand: "会A", colors: { brand: "#101010" } });
  const t = await getTheme(ctx);
  assert.equal(t.brand, "会A");
  assert.equal(t.colors?.brand, "#101010");
});

test("nav：合成＋非表示/ラベル/並び/重複排除", () => {
  const base: NavItem[] = [{ href: "/a", label: "A", show: true }, { href: "/b", label: "B", show: false }, { href: "/c", label: "C" }];
  const part: NavItem[] = [{ href: "/d", label: "D" }, { href: "/a", label: "dup" }];
  const out = buildNav(base, part, { hidden: ["/c"], labels: { "/a": "AA" }, order: ["/d", "/a"] });
  assert.deepEqual(out, [{ href: "/d", label: "D" }, { href: "/a", label: "AA" }]);
});

test("nav：override 未設定なら base の show=true のみ", () => {
  const base: NavItem[] = [{ href: "/a", label: "A", show: true }, { href: "/b", label: "B", show: false }];
  assert.deepEqual(buildNav(base, [], null), [{ href: "/a", label: "A" }]);
});

test("nav：KV 往復", async () => {
  const ctx = ctxKv();
  assert.equal(await getNavOverrides(ctx), null);
  await setNavOverrides(ctx, { hidden: ["/chat"], labels: {}, order: [] });
  assert.deepEqual((await getNavOverrides(ctx))?.hidden, ["/chat"]);
});
