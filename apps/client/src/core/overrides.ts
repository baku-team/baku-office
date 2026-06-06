// 画面・部品の上書き（第3層：配布時・デプロイごと）。
// src/overrides/<name>.astro があればそれを描画、無ければ base（フォールバック）を描画。
// 配布バンドル（団体ごと throwaway リポ）に overrides/ を同梱して差し替える。
// 全面置換が要る画面は、配布バンドルで src/pages/<page>.astro を直接同梱（ファイル上書き）すればよい。
const mods = import.meta.glob("/src/overrides/*.astro", { eager: true }) as Record<string, { default: unknown }>;

const keyOf = (name: string) => `/src/overrides/${name}.astro`;

export function hasOverride(name: string): boolean {
  return !!mods[keyOf(name)];
}
export function overrideComponent(name: string): unknown | null {
  return mods[keyOf(name)]?.default ?? null;
}
