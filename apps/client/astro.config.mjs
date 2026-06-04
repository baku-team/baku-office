// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// クライアントアプリ（顧客の単一Worker）：Astro静的＋API同居（設計書§3.4）。
export default defineConfig({
  adapter: cloudflare({
    // ローカルdevで wrangler.jsonc のバインディングをエミュレート。
    platformProxy: { enabled: true, configPath: "wrangler.jsonc" },
  }),
  // 共有パッケージ(raw TS)をViteでトランスパイルさせる。
  vite: {
    ssr: { noExternal: ["@baku-office/shared"] },
  },
});
