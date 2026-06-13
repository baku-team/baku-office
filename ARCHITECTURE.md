# baku-office アーキテクチャ：更新フローと「基本＋カスタム」設計

> 本システムは **「自社専用AIの相棒」をクライアントが丸ごと所有するための「ポータブルコア＋パーツ」基盤**。
> コア（DB・ストレージ・AI・エージェント・認証・アプリ管理）を Port で抽象化し、業務機能は Part（＝アプリ）として
> 載せ替える。**コアは共通（全顧客同一）／パーツと UI は団体ごとに差し替え・AIで自作**、が基本＋カスタムの土台。
> 詳細：[docs/spec/baku-office_portable-core_architecture.md](docs/spec/baku-office_portable-core_architecture.md)。

## リポジトリと配布（CI）

```
baku-team/baku-office (private・正本/モノレポ)
  apps/host      … ホストポータル（当社アカウントでデプロイ）
  apps/client    … クライアントアプリ（顧客の単一Worker・自己ホスト）
  apps/scheduler … 定期巡回Worker（Cron Triggers・自己修復sweep/drain起動）
  packages/shared
        │  push main（apps/client 変更時）
        ▼  GitHub Actions: npm run release（難読化バンドル化・ホスト/TSは除外）
baku-team/baku-office-app (public・配布物のみ)
        │  Deploy to Cloudflare ボタン / フォーク同期
        ▼
顧客のCloudflare（各社アカウント）… D1/KV/Worker をクライアント自身が保有
```

- **CI**：`.github/workflows/publish-client.yml` が `apps/client` の変更を public 配布リポへ自動公開（要 `PUBLISH_TOKEN` シークレット）。
- ホストポータルは当社アカウントへ `wrangler deploy`（顧客はフォークしない）。

## 共通アップデート（全顧客が通常通り受け取る）

1. 当社が `apps/client` を更新 → CI が配布バンドルを公開。
2. 顧客は **フォークを upstream 同期**（または Deploy 再実行）→ Cloudflare Workers Builds が自動再デプロイ。
3. **DBスキーマは初回リクエストで自動適用**（`src/lib/migrate.ts`：`schema_migrations` で未適用分のみ実行・冪等）。
   - **大規模なDB/ストレージ変更**もマイグレーションを追記するだけで全顧客に安全反映（既存列重複等は無視。破壊的変更はしない方針）。
4. UI・機能の更新/追加/変更は、共通レイアウト（`layouts/App.astro`＋`styles/app.css`）と能力レジストリにより、最小差分で全体へ波及。

## ポータブルコア＋パーツ（コアは共通・機能は載せ替え）

- **コア能力 Port**（`src/core/ports.ts`）：`SqlStore`/`StoragePort`/`AiPort`/`AgentPort`/`IdentityPort`/`AppsApi`。`middleware` が環境別アダプタを束ねた `ctx` を注入。
- **環境アダプタ**：CF（D1/KV/R2/Gemini/Claude）が標準。AI は `ChatModel`（gemini/claude/**ローカルLLM(OpenAI互換)**）を実行時切替。`Profile`（`core/profiles.ts`）で稼働構成を検出（フルクラウド〜オフライン）。
- **パーツ**（`src/parts/`）：業務機能＝道具(`agentTools`)＋ナビ(`menu`)＋データ操作を `Part` として登録。`requiredRole` で認可。**団体ごとに有効/無効を選択**（`enabled_parts`）。
- **移植性の保証**：`apps/client/test/` の適合性テストが **Node+SQLite** で同じコア/パーツを実行（アダプタ差し替え＝CF非依存を実証）。

## 個別アカウントのカスタマイズ（基本＋カスタムの両立）

カスタムは大きく3系統。**upstream のコード同期で上書きされない**（データ）か、**追加ファイルとして同梱**（コア未編集）のため、共通更新と両立する。

| カスタム種別 | 仕組み | 保存先/形 | 上書きされない理由 |
| --- | --- | --- | --- |
| 有効パーツ選択 | どの業務パーツを使うか | KV（`enabled_parts`） | データ |
| UIテーマ（第1層） | ブランド名・ロゴ・配色 | KV（`ui_theme`） | データ（実行時上書き） |
| ナビ構成（第2層） | 表示/ラベル/並び | KV（`nav_overrides`） | データ（実行時上書き） |
| 業務スキル | Agent Skills（SKILL.md） | `skills` テーブル | データ |
| 外部AI連携 | 任意API（画像/音声/動画/embed/custom） | `capabilities` テーブル | データ |
| APIキー/設定 | 連携設定・上限・モード | KV（暗号化）/設定 | データ |
| 人格/機能 | 署名config（当社配信） | KV | ライセンス配信で個別化 |
| **新パーツ追加**（コードレベル） | `Part` を定義し登録（道具/ナビ/画面） | 追加ファイル `src/parts/<id>.ts` | コア未編集・追加のみ |
| **UI画面の上書き（第3層）** | `src/overrides/<name>.astro`（Slot注入）／pages 同梱（全面置換） | 追加ファイル `src/overrides/` 等 | ベース未編集・配布時同梱 |

- **基本システム**＝upstream のコア（全顧客共通・CIで配布）。コアは編集しない。
- **より深いコードレベルのカスタム**が必要なら：①まずパーツ／能力レジストリ／スキルで実現できないか検討、②画面は第3層 override（追加ファイル）で差し替え。コア本体に手を入れないため共通更新と衝突しない（最終手段の顧客専用ブランチは原則不要）。

## ホスト統制と自己修復（2026-06-09）

- **アプリ統制（中枢キルスイッチ）**：ストア/未登録アプリの**公開停止（blocked）・削除（deleted・墓標`app_revocations`）**と、標準同梱アプリの**登録/除外（`builtin_policy`）**を統合チェック（`/api/check`）で全クライアントへ配信。クライアントは `revokedApps`（撤去）・`disabledBuiltins`（導入集合から除外）を受けて即時反映。削除は「墓標＋利用0で完全削除」（物理削除後も撤去指示は墓標で継続）。
- **プラン vs エンタイトルメント**：データは2層維持（plan=契約/請求、entitlement=実効権限。nonprofit審査・Stripe入金が並行して entitlement を上書きするため統合不可）。クライアントへ配るのは entitlement のみ。
- **自己修復ループ（client→host→GitHub→Claude）**：
  1. クライアントのエラーは送信アウトボックスに積まれ、`cron/drain` がホスト `/api/report` へ集約送信（license token認証・fingerprint集約・PIIなし）。利用者の不具合/要望も `/diagnostics` から同経路で送信。
  2. ホストは `client_reports` に集積し、`/api/cron/sweep` が未集積エラーを `baku-team/baku-office-logs` に **Issue 化**。
  3. その Issue を **Claude（Web 等）が巡回・修復**＝クラウドで直せる問題は修正→PR→Issueリンク、不能なら原因と対策をレポート化しPRへ（**baku-office 側の責務は「集積・通知」まで／修復は人＋Claude**）。
  4. 対応結果（resolved/wontfix＋メモ/PR）は `reportUpdates` でクライアントへ返信表示。
- **定期巡回 `apps/scheduler`**：Cloudflare **Cron Triggers `*/5 * * * *`**。Astroビルド非依存の素のWorker。**Service Binding 経由**で host `sweep`／client `drain` を起動（同一 workers.dev 直fetchは error 1042 で遮断されるため）。外部スケジューラ非依存・CF内で完結。顧客（別アカウント）の client 自走drainは配布テンプレへの cron 同梱で対応（今後）。

## ポータブルコア境界と capability scoping（2026-06-13・第三者レビュー対応）

レビュー指摘（エコシステム成長前の弱点）①②への対応。サードパーティ／AI生成パーツが増える前に Port 境界を固める。

- **① 方言中立 DB Port（`QueryStore`）**：`ctx.db` は CF型(D1 `D1PreparedStatement`)を露出せず `all/first/run/batch(sql, params[])` の中立IFのみ（[core/ports.ts](apps/client/src/core/ports.ts)）。CF結合はアダプタ（[core/cf-adapter.ts](apps/client/src/core/cf-adapter.ts)）に封じる。Node+SQLite アダプタ（test）が同一IFで動き移植性を実証。
  - 第一者の内部コードに残る `env.DB` 直アクセス（約164箇所）は**アダプタ境界**として許容（Portではない）。完全移植時に ctx 経由へ寄せる（将来）。
- **①b パーツの env 封鎖**：パーツに渡す実行文脈は `PartCtx = Omit<Ctx,"env">`。Google API は `ctx.google`、ファイルは `ctx.storage`、AI抽出は `ctx.ai`、名簿復号は `ctx.identity.listMemberNames()` の各 Port 経由。パーツは生 env・秘密鍵・認証内部に到達不可。
- **② capability scoping**：`scopeCtx(ctx, permissions)`（[core/capability.ts](apps/client/src/core/capability.ts)）が**宣言した permission に対応する Port だけ**を注入。未宣言の能力（`db:write`/`storage:*`/`ai`/`agent`/`net`/`members:read`）へのアクセスは実行時に `AppError(E9007)` で拒否。適用点：エージェント道具実行・アプリ間連動（`ctx.apps.call`）・ホームウィジェット。
  - パーツのマニフェスト `permissions` は宣言＝実効。AI生成/外部取り込みアプリは preflight＋人間承認＋本scopingの多層で、宣言を超えた DB書込・外部送信・他能力を構造的に拒絶。

## 天井と逃げ道（③・設計のみ・小規模団体は単一D1/Workerで十分）

単一 Worker・単一 D1 の容量/CPU 天井は小規模団体には意図通りの割り切り。将来の拡張に備え**継ぎ目だけ先に用意**（実装は据え置き）：

- **パーツ別DB分離**：`QueryStore` は方言中立のため、将来 `ctx.dbFor(namespace)` を足してパーツ/テナント別の D1（または同一D1内スキーマ接頭辞）へ解決できる。現状は全て単一 `env.DB`。Port 利用側（パーツ）は無改修で差し替え可能。
- **R2 アーカイブ（コールド層）**：`StoragePort` に将来 `archive(id)`/`restore(id)` を足し、古い大容量データを R2 コールドへ退避。`getFile` は透過フォールバック。現状は KV/R2 ホット層のみ。
- **CPU時間**：重い多段処理は既に `agent_jobs`（enqueue→drain）で分割実行。さらなる分割は Queue/Durable Object への移行余地（Port を増やさず scheduler 側で吸収）。

## 不変条件

- クライアントのコードは当社配布の固定ランタイム（Worker内で eval しない）。スキル等は Anthropic 等のサンドボックスで実行。
- 業務データ・PII・APIキーは顧客アカウント内のみ。当社は到達経路を持たない（§1.2）。
- 署名鍵は当社（将来KMS）。クライアントは公開鍵で検証のみ。
- **パーツは PartCtx（env無し・capability scoped）でのみ動く**。生 env・秘密・未宣言能力には構造的に到達不可。
