// 適合性テスト（P0-3）：公開HTML allowlist サニタイザが主要XSSバイパスを塞ぐ。
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeHtml } from "../src/lib/sanitize.ts";

const has = (h: string, s: string) => h.toLowerCase().includes(s.toLowerCase());

test("許可タグ・テキストは保持される", () => {
  const out = sanitizeHtml('<h1>見出し</h1><p>本文 <strong>太字</strong> と <a href="/about">リンク</a></p>');
  assert.ok(has(out, "<h1>見出し</h1>"));
  assert.ok(has(out, "<strong>太字</strong>"));
  assert.ok(has(out, 'href="/about"'));
});

test("script はタグも内容も除去", () => {
  const out = sanitizeHtml('<p>x</p><script>alert(1)</script><p>y</p>');
  assert.ok(!has(out, "script"));
  assert.ok(!has(out, "alert"));
  assert.ok(has(out, "<p>x</p>") && has(out, "<p>y</p>"));
});

test("イベントハンドラ属性は除去（タグは残す）", () => {
  const out = sanitizeHtml('<img src="/a.png" onerror="alert(1)" onload=alert(2)>');
  assert.ok(!has(out, "onerror") && !has(out, "onload") && !has(out, "alert"));
  assert.ok(has(out, "<img") && has(out, 'src="/a.png"'));
});

test("javascript: スキーム（属性エンコード含む）は無効化", () => {
  assert.ok(!has(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), "javascript:"));
  // 実体参照で : を隠した場合もデコードして検出。
  assert.ok(!has(sanitizeHtml('<a href="javascript&#58;alert(1)">x</a>'), "alert"));
  // 制御文字を挟むバイパス。
  assert.ok(!has(sanitizeHtml('<a href="java\tscript:alert(1)">x</a>'), "alert"));
});

test("SVG/MathML/iframe/object は内容ごと除去", () => {
  const out = sanitizeHtml('<svg><script>alert(1)</script></svg><math><mtext>x</mtext></math><iframe src="//evil"></iframe>');
  assert.ok(!has(out, "svg") && !has(out, "math") && !has(out, "iframe") && !has(out, "alert"));
});

test("未知タグはマークアップのみ破棄し内容は残す", () => {
  const out = sanitizeHtml("<unknown>残る</unknown>");
  assert.ok(!has(out, "<unknown") && has(out, "残る"));
});

test("属性内の偽の > で壊れない（引用符解釈）", () => {
  const out = sanitizeHtml('<a href="/x" title="a > b">link</a>');
  assert.ok(has(out, 'href="/x"') && has(out, "link"));
  assert.ok(!has(out, "onerror"));
});

test("data: スキームは画像でも拒否（svgはXSS源）", () => {
  assert.ok(!has(sanitizeHtml('<img src="data:image/svg+xml,<svg onload=alert(1)>">'), "data:"));
});

test("style 属性は除去", () => {
  assert.ok(!has(sanitizeHtml('<p style="background:url(javascript:alert(1))">x</p>'), "style"));
});

test("target=_blank には rel が補完される", () => {
  assert.ok(has(sanitizeHtml('<a href="https://example.com" target="_blank">x</a>'), "noopener"));
});

test("生の < > を含むテキストはエスケープされる", () => {
  const out = sanitizeHtml("5 < 10 かつ 20 > 15");
  assert.ok(has(out, "&lt;") && has(out, "&gt;"));
});

test("名前付き空白実体（&Tab;/&NewLine;）で javascript: をバイパスできない", () => {
  assert.ok(!has(sanitizeHtml('<a href="java&Tab;script:alert(1)">x</a>'), "alert"));
  assert.ok(!has(sanitizeHtml('<a href="java&NewLine;script:alert(1)">x</a>'), "alert"));
});

test("属性値内の実体エンコード引用符でブレイクアウトできない（& をエスケープ）", () => {
  const out = sanitizeHtml('<span title="&#34; onmouseover=alert(1) //">x</span>');
  // onmouseover は title 値内のテキストとして残る（無害）が、独立属性には昇格しない。
  // 要点：& がエスケープされ、ブラウザ復号で " にならない＝属性ブレイクアウト不能。
  assert.ok(has(out, "&amp;#34;"));
  assert.ok(!has(out, '" onmouseover')); // 閉じ引用符直後に新属性が生えていない
});

test("srcset は各候補のスキームを検査（後続候補の不正スキームを弾く）", () => {
  const out = sanitizeHtml('<source srcset="/ok.png 1x, javascript:alert(1) 2x">');
  assert.ok(!has(out, "srcset")); // 不正候補を含む srcset 属性ごと落ちる
  const ok = sanitizeHtml('<source srcset="/a.png 1x, /b.png 2x">');
  assert.ok(has(ok, "srcset")); // 全候補が安全なら通る
});

test("未閉じの除去対象タグでも後続コンテンツを消さない", () => {
  const out = sanitizeHtml("<p>前</p><style>body{}<p>後</p>"); // style 閉じ忘れ
  assert.ok(has(out, "前") && has(out, "後"));
  assert.ok(!has(out, "<style"));
});
