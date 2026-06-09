# CLAUDE.md — baku-office プロジェクト運用ルール

このファイルはセッション開始時に自動ロードされる。**作業前に必ず本書の「環境・アカウント」「CFデプロイ」「D1マイグレーション」を確認**し、迷子・誤デプロイを防ぐこと。応答は日本語。

---

## 環境・アカウント（最重要・迷子防止）

- 開発・運用は **baku-llc の Cloudflare アカウントのみ**。account_id `027ff037909969dea1fc303b4f4fe7fe`、workers.dev サブドメイン `baku-027`。
- **amber-links アカウント（`0e6cad…`）は現在不使用**。`apps/client/wrangler.jsonc` の top-level コメントに「amber-links 動作確認」と残るが**触らない**（別アカウントのため現 auth では deploy 不可）。
- **開発段階。外部顧客向けの本番運用はまだ無い。** ドキュメント中の「本番」は baku-llc の env.production への deploy を指す内部語彙。
- 認証確認：`npx wrangler whoami`（`baku@baku-llc.co.jp` / account `027ff…` であること）。
- 稼働 Worker（すべて account 027）：
  - **host** = `baku-office-portal`（単一env）／D1 `baku-office-portal-db`
  - **client** = `baku-office-app`（**env.production**・D1 `baku-office-app-db` = `08b5cc15…`・Service Binding `HOST`）
  - **apply** = `baku-office-apply`
  - **scheduler** = `baku-office-scheduler`（Cron `*/5`・Service Binding 経由で host `/api/cron/sweep`・client `/api/cron/drain` を起動）

## CFデプロイ（手動・CIには無い）

- **client（最大の落とし穴）**：
  ```bash
  npm -w apps/client run build
  cd apps/client && npx wrangler deploy --env production
  ```
  `npm -w apps/client run deploy` は `--env` を付けない＝top-level（amber-links想定・実体は別アカウントDB）に向くため**必ず `--env production` を明示**する。
- **host**：`npm -w apps/host run deploy`（単一env）。
- **secret 投入**も本番は `--env production`：`npx wrangler secret put <NAME> --env production`（client）。`GOOGLE_CLIENT_ID/SECRET` は組織ログイン＋Google Workspace連携で使用。
- 反映前に必ず：`npm run typecheck`（全パッケージ）／`npm -w apps/client test`／`npm -w apps/host test`。

## D1マイグレーション（独自方式・wrangler migrations は使わない）

- client は**アプリ内ランナー** `apps/client/src/lib/migrate.ts`：`schema_migrations` テーブル＋KV `schema_version` ゲートで管理。新規 SQL を `migrations/00NN_*.sql` に置き `migrate.ts` の `MIGRATIONS` 配列に追記すれば、**初回リクエストで `ensureSchema` が未適用分のみ自動適用**（冪等）。現 `SCHEMA_VERSION = 20`。
- **`wrangler d1 migrations apply` は使わない**（別系統の `d1_migrations` テーブルを作り不整合の原因になる）。
- 状態確認：`npx wrangler d1 execute baku-office-app-db --remote --env production --command "SELECT id FROM schema_migrations ORDER BY id"`。
- host の D1 マイグレーションは手動：`npx wrangler d1 execute baku-office-portal-db --remote --file apps/host/migrations/<n>.sql`。

## CI/CD

- `.github/workflows/`：`publish-client.yml`（main push で配布バンドルを公開リポ `baku-team/baku-office-app` へ push）＋`release.yml`（署名リリース＋host 通知）。トリガ paths = `apps/client/**`・`packages/shared/**`。
- **CF Workers への `wrangler deploy` は CI に無い＝必ず手動**。`apps/client/**` を変更すると上記2本が走る点に留意。

## Git 運用

- 既定ブランチ `main`。**main へ直接コミットしない**：作業ブランチ（`feat/*`・`fix/*`・`docs/*`）→ PR → マージ。
- push・PR/Issue 作成・マージ・外部反映は**依頼があった時のみ**。破壊的 git 操作（`reset --hard`／`push --force`／`branch -D`）・`--no-verify` は事前承認。
- iCloud 同期由来の重複ファイル（`* 2.ts` 等）が出たら `index.ts` 等と diff して同一なら削除。コミットに含めない。

## 機能開発・デバッグのワークフロー（Phase制・再開可能）

1. **計画**：着手前に作業を Phase に分割した計画を立て、`.dev-plan.md`（gitignore・一時記録）に書く。各 Phase に「目的／対象ファイル／完了条件／状態（TODO/DOING/DONE）」を記す。
2. **再開可能に保つ**：作業中は `.dev-plan.md` を随時更新。**途中で中断しても、次セッションは本ファイルを読めば再開できる**状態を常に維持する。
3. **Phase 単位で実装**：1 Phase = 意味のある最小単位（混ぜない）。
4. **Phase 完了ごとに**：`typecheck`／該当テストを通す → 作業ブランチへ**コミット** → `.dev-plan.md` の該当 Phase を DONE に更新。
5. **進捗の永続記録**：機能完了・本番反映などの節目で `PROGRESS.md` に追記。`.dev-plan.md` は完了後に破棄してよい（永続記録は PROGRESS.md と git 履歴）。

---

最終更新：2026-06-09
