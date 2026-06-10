// 公開HTML（管理者入力）の allowlist サニタイザ（P0-3）。
// WHY: 旧実装は正規表現で script/on*/javascript: を除去していたが、SVG/MathML・属性エンコード・
// 未知タグ・URLスキーム・ブラウザ差分で取りこぼす。ここではタグ単位に走査し、
// 「許可タグ・許可属性・許可スキームだけを通す」allowlist 方式に置き換える（依存なし＝Workers安全）。
// 完全な DOM パーサではないが、引用符を解釈しつつ属性値を実体デコードしてからスキーム判定するため、
// 正規表現方式の主要バイパスを塞ぐ。CSP（SitePublic 側）と併用する defense-in-depth。

// タグ＋内容ごと丸ごと捨てる（スクリプト実行・別名前空間・埋め込みの起点）。
const DROP_SUBTREE = new Set([
  "script", "style", "svg", "math", "iframe", "object", "embed", "template",
  "noscript", "link", "meta", "base", "form", "input", "button", "textarea", "select", "option",
]);

// 通過を許可する整形・構造タグ。
const ALLOWED = new Set([
  "a", "p", "br", "hr", "span", "div", "section", "article", "header", "footer", "main", "aside", "nav",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd",
  "strong", "b", "em", "i", "u", "s", "small", "mark", "sub", "sup", "code", "pre", "blockquote", "q",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "img", "figure", "figcaption", "picture", "source", "time", "abbr", "address",
]);

// 内容を持たない（自己終了）タグ。
const VOID = new Set(["br", "hr", "img", "col", "source"]);

// グローバル許可属性＋タグ別許可属性。on*・style・形式不明の属性は落とす。
const GLOBAL_ATTRS = new Set(["class", "id", "title", "lang", "dir"]);
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "name", "target", "rel"]),
  img: new Set(["src", "alt", "width", "height", "loading"]),
  source: new Set(["src", "srcset", "type", "media"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  col: new Set(["span"]),
  time: new Set(["datetime"]),
  abbr: new Set(["title"]),
};
// URL を取る属性（スキーム検査の対象）。
const URL_ATTRS = new Set(["href", "src", "srcset"]);
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

// スキーム偽装に使われ得る名前付き実体を判定用に展開。空白系（Tab/NewLine/CR）も含める
// （ブラウザは URL スキーム中の Tab/改行を除去するため `java&Tab;script:` を見抜く必要がある）。
const NAMED = new Map<string, string>([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"],
  ["colon", ":"], ["#x3a", ":"], ["#58", ":"],
  ["tab", "\t"], ["newline", "\n"],
]);

// 実体参照を素朴に展開（スキーム偽装 `javascript&#58;` 等を見抜くため）。表示用ではなく判定用。
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);?/gi, (m, body: string) => {
    const b = body.toLowerCase();
    if (b[0] === "#") {
      const code = b[1] === "x" ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return NAMED.get(b) ?? m;
  });
}

// 単一URLが安全か（許可スキーム or 相対参照）。制御文字・空白を除去してから判定。
function safeUrl(raw: string): boolean {
  const v = decodeEntities(raw).replace(/[\x00-\x20]/g, "").toLowerCase();
  if (v === "") return true;
  if (v.startsWith("#") || v.startsWith("/") || v.startsWith("./") || v.startsWith("../") || v.startsWith("?")) return true;
  const m = /^([a-z][a-z0-9+.-]*):/.exec(v);
  if (!m) return true; // スキームなし＝相対パス
  return ALLOWED_SCHEMES.has(m[1]); // data:/javascript:/vbscript: 等は全拒否（data:image svg は XSS 源）
}

// URL属性値の検査。srcset は `url 1x, url 2x` のカンマ区切り候補リストなので各候補のURL部を個別に検査。
function safeUrlAttr(key: string, raw: string): boolean {
  if (key !== "srcset") return safeUrl(raw);
  return raw.split(",").every((cand) => {
    const url = cand.trim().split(/\s+/)[0] ?? "";
    return safeUrl(url);
  });
}

const esc = (s: string) => s.replace(/&(?![a-z#0-9]+;)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// `name attr="v" attr2='v2' bare` を {name, attrs:[[k,v]]} へ。引用符を解釈する簡易パーサ。
function parseTag(inner: string): { name: string; attrs: [string, string | null][]; selfClose: boolean } {
  let i = 0;
  const selfClose = inner.trimEnd().endsWith("/");
  const body = selfClose ? inner.trimEnd().slice(0, -1) : inner;
  const nm = /^[a-z][a-z0-9:-]*/i.exec(body);
  const name = (nm?.[0] ?? "").toLowerCase();
  i = nm ? nm[0].length : body.length;
  const attrs: [string, string | null][] = [];
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    const am = /^[^\s=/>]+/.exec(body.slice(i));
    if (!am) break;
    const key = am[0].toLowerCase();
    i += am[0].length;
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] === "=") {
      i++;
      while (i < body.length && /\s/.test(body[i])) i++;
      let val = "";
      if (body[i] === '"' || body[i] === "'") {
        const q = body[i]; i++;
        const end = body.indexOf(q, i);
        val = end === -1 ? body.slice(i) : body.slice(i, end);
        i = end === -1 ? body.length : end + 1;
      } else {
        const vm = /^[^\s>]+/.exec(body.slice(i));
        val = vm?.[0] ?? ""; i += val.length;
      }
      attrs.push([key, val]);
    } else {
      attrs.push([key, null]);
    }
  }
  return { name, attrs, selfClose };
}

function rebuildAttrs(name: string, attrs: [string, string | null][]): string {
  const allow = TAG_ATTRS[name];
  const out: string[] = [];
  for (const [k, v] of attrs) {
    if (k.startsWith("on")) continue;           // イベントハンドラ全拒否
    if (k === "style") continue;                // インラインCSS拒否
    if (!GLOBAL_ATTRS.has(k) && !(allow && allow.has(k))) continue;
    if (URL_ATTRS.has(k) && v != null && !safeUrlAttr(k, v)) continue;
    if (v == null) { out.push(k); continue; }
    // & を先頭でエスケープ。WHY: `&#34;` 等の実体を素通しすると属性値内でブラウザが復号し
    // 引用符ブレイクアウト（title="&#34; onmouseover=...）を許す。
    out.push(`${k}="${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`);
  }
  // a[target=_blank] には rel を補完（タブナビング対策）。
  if (name === "a" && out.some((a) => /^target=/.test(a)) && !out.some((a) => /^rel=/.test(a))) out.push('rel="noopener noreferrer"');
  return out.length ? " " + out.join(" ") : "";
}

export function sanitizeHtml(html: string): string {
  let out = "";
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) { out += esc(html.slice(i)); break; }
    out += esc(html.slice(i, lt));
    // コメント・宣言は内容ごと破棄。
    if (html.startsWith("<!--", lt)) { const e = html.indexOf("-->", lt + 4); i = e === -1 ? n : e + 3; continue; }
    if (html[lt + 1] === "!") { const e = html.indexOf(">", lt); i = e === -1 ? n : e + 1; continue; }
    const gt = html.indexOf(">", lt);
    if (gt === -1) { out += esc(html.slice(lt)); break; } // 閉じない `<` は文字として扱う
    const closing = html[lt + 1] === "/";
    const inner = html.slice(lt + 1 + (closing ? 1 : 0), gt);
    const { name, attrs } = parseTag(closing ? inner.replace(/^\/?/, "") : inner);
    // タグ名でない `<`（例 `5 < 10`）は文字として扱う（タグ誤認で内容を食わない）。
    if (!name) { out += "&lt;"; i = lt + 1; continue; }
    i = gt + 1;
    if (DROP_SUBTREE.has(name)) {
      if (closing) continue; // 閉じタグ単体は破棄
      // 対応する閉じタグまで内容ごと破棄（同名ネストは深さで対応）。原文に lastIndex で走査＝O(n)。
      // 閉じタグが無ければ「このタグだけ破棄」して後続は通常処理（EOFまで巻き込まない）。
      const open = new RegExp(`<${name}\\b`, "ig");
      const close = new RegExp(`</${name}\\s*>`, "ig");
      let depth = 1, pos = i;
      while (depth > 0) {
        close.lastIndex = pos;
        const cm = close.exec(html);
        if (!cm) { pos = -1; break; }
        open.lastIndex = pos;
        const om = open.exec(html);
        if (om && om.index < cm.index) { depth++; pos = om.index + name.length + 1; continue; }
        depth--; pos = cm.index + cm[0].length;
      }
      if (pos === -1) continue; // 閉じタグ無し＝当該タグのみ破棄（i は gt+1 のまま）
      i = pos;
      continue;
    }
    if (!ALLOWED.has(name)) continue; // 未知/非許可タグはマークアップのみ破棄（内容は残す）
    if (closing) { out += `</${name}>`; continue; }
    out += `<${name}${rebuildAttrs(name, attrs)}${VOID.has(name) ? " /" : ""}>`;
  }
  return out;
}
