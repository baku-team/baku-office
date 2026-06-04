// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

// ホストポータル（当社アカウントの単一Worker）：申込・ライセンス・アクティベーション・通知。
export default defineConfig({
  adapter: cloudflare({
    platformProxy: { enabled: true, configPath: "wrangler.jsonc" },
  }),
  vite: {
    ssr: { noExternal: ["@baku-office/shared"] },
  },
});
