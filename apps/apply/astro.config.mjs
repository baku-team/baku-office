// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// 申込専用Worker（当社アカウント）：団体申込のみを担当し、ホストポータルから分離して稼働。
// ホストと同じ D1（baku-office-portal-db）を共有して customers/licenses を作成する。
export default defineConfig({
  adapter: cloudflare({
    platformProxy: { enabled: true, configPath: "wrangler.jsonc" },
  }),
  vite: {
    ssr: { noExternal: ["@baku-office/shared"] },
  },
});
