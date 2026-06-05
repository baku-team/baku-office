# baku-office アーキテクチャ：更新フローと「基本＋カスタム」設計

## リポジトリと配布（CI）

```
baku-team/baku-office (private・正本/モノレポ)
  apps/host    … ホストポータル（当社アカウントでデプロイ）
  apps/client  … クライアントアプリ（顧客の単一Worker・自己ホスト）
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

## 個別アカウントのカスタマイズ（基本＋カスタムの両立）

カスタムは**コードではなくデータ**として各顧客の D1/KV に保持する。**upstream のコード同期で上書きされない**ため、共通更新とカスタムが両立する。

| カスタム種別 | 仕組み | 保存先（顧客側） | 上書きされない理由 |
| --- | --- | --- | --- |
| 業務スキル | Agent Skills（SKILL.md・§5-2b skill） | `skills` テーブル | コードでなくデータ |
| 外部AI連携 | 任意API（画像/音声/動画/embed/custom・api種別） | `capabilities` テーブル | 同上 |
| APIキー/設定 | 連携設定・上限・モード | KV（暗号化）/設定 | 同上 |
| 人格/機能 | 署名config（当社配信） | KV | ライセンス配信で個別化 |

- **基本システム**＝upstream のコード（全顧客共通・CIで配布）。
- **カスタム機能**＝上記データ（顧客ごと・管理画面の「高度なオプション」等で追加/有効化、管理者レビュー制）。
- **より深いコードレベルのカスタム**が必要な場合の指針：①まず能力レジストリ/スキルで実現できないか検討、②どうしても必要なら顧客専用ブランチ（`custom/<tenant>`）でオーバーレイし、共通更新は `main` を都度マージ（コンフリクトを局所化するため、カスタムは追加ファイル＝専用ディレクトリに限定）。

## 不変条件

- クライアントのコードは当社配布の固定ランタイム（Worker内で eval しない）。スキル等は Anthropic 等のサンドボックスで実行。
- 業務データ・PII・APIキーは顧客アカウント内のみ。当社は到達経路を持たない（§1.2）。
- 署名鍵は当社（将来KMS）。クライアントは公開鍵で検証のみ。
