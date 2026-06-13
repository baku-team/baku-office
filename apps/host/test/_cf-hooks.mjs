// ESM 解決フック：cloudflare:workers をテスト用スタブへ差し替える（node には cloudflare: スキームが無い）。
const STUB = new URL("./_cf-workers-stub.mjs", import.meta.url).href;
export function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: STUB, shortCircuit: true };
  return nextResolve(specifier, context);
}
