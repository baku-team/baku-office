// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// クライアントアプリ（顧客の単一Worker）：Astro静的＋API同居（設計書§3.4）。
export default defineConfig({
  adapter: cloudflare({
    // ローカルdevで wrangler.jsonc のバインディングをエミュレート。
    platformProxy: { enabled: true, configPath: "wrangler.jsonc" },
  }),
  // 体感速度：リンクにホバー/タップした時点で次ページを先読み。
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  // 次ページを丸ごと事前レンダリング（Speculation Rules）。対応ブラウザではクリック時ほぼ瞬時に表示＝SPA級。
  // フルページ遷移のままなので既存のページ内スクリプトと完全互換（再実行問題が起きない）。
  experimental: { clientPrerender: true },
  // 共有パッケージ(raw TS)をViteでトランスパイルさせる。
  vite: {
    ssr: { noExternal: ["@baku-office/shared"] },
  },
});
