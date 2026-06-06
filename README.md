# baku-office

**「ポータブルコア＋パーツ」アプリケーション基盤。**
コア（DB・ストレージ・AI・エージェント・認証）を **Port（インターフェース）** で抽象化し、
業務機能は **Part（パーツ）** として後から載せ替える。コアは*環境も業務も知らない*ため、

- **同一コードでフルクラウド 〜 完全オフライン（ローカルLLM）まで**動かせる、
- **コアの上に任意のパーツ（業務モジュール）を追加・置換**できる、
- **UI も共通ベース＋団体ごと上書き**で配布できる

——という「汎用基盤」であることが本質。

> 現在の**標準同梱パーツ**は「会計・庶務（非営利団体向け／LINEエージェント連携）」だが、これは**一例**。
> 同じコアの上に別の業務パーツ（例：在庫・予約・問合せ対応…）を載せ替えれば、別の専用ツールになる。

運用は自己ホスト型：**業務データは利用団体（クライアント）自身のCloudflare内に保管**し、
当社（ホスト＝株式会社貘）はライセンス発行・配信・課金・サポートのみ（**データに到達経路を持たない**）。

> 「専用ツール（団体X）＝ 環境Profile × 有効パーツ集合 × 連動する外部API」。3軸が直交し、
> 環境を変えてもパーツは無改変、パーツを変えても環境は無改変で動く。

- 正本の仕様：[integrated_design_package_v1.0.md](integrated_design_package_v1.0.md)
- 移植性アーキ：[baku-office_portable-core_architecture.md](baku-office_portable-core_architecture.md)
- 操作手順：[OPERATIONS.md](OPERATIONS.md) ／ 更新・カスタム設計：[ARCHITECTURE.md](ARCHITECTURE.md)
- 旧称 `cf-line-agent-kit`（LINEエージェント単体）。2026-06 に会計・庶務SaaS **baku-office** へ再設計。

---

## 配信・運用モデル（標準提供時：ホスト⇄クライアント）

> これは「標準同梱パーツを SaaS 的に配る」ときの**運用形態の一例**。コア自体は環境非依存で、
> オフライン単体配布など他の形態でも動く（→ [ポータブルコア](#ポータブルコアports--parts)）。

```
当社（ホスト）アカウント                         利用団体（クライアント）アカウント
┌───────────────────────────┐               ┌───────────────────────────────┐
│ baku-office-portal (Astro/Worker) │  署名lease/config・統合チェック  │ baku-office-app (Astro/単一Worker) │
│  申込・ライセンス発行・課金       │ ───────────────▶ │  会計/名簿/ファイル/予定/議事録    │
│  クライアント管理・お知らせ配信   │ ◀─────────────── │  共有承認・連携設定・LINEエージェント │
│  （業務データ・PIIは保持しない）  │   テレメトリ(PIIなし)・通知       │  業務データは D1/KV/R2（顧客保有）  │
└───────────────────────────┘               └───────────────────────────────┘
        ▲ private 正本(モノレポ)                         ▲ Deploy to Cloudflare（公開配布リポ）
        └── CI で難読化バンドルを公開リポへ ──────────────┘
```

- **ホスト**：申込→署名ライセンス発行→個別Deployリンク。クライアントは公開鍵で検証するだけ。
- **クライアント**：Deployボタンで自分のCFへ自己ホスト。初回起動で申込時Googleにより**自動アクティベート**（認証キー入力なし／ホスト署名relayを検証）。
- **配信境界**：当社→クライアントは「ライセンス／エンタイトルメント／通知」のみ。業務データ・PII・APIキーは境界を越えない。

## ポータブルコア（Ports & Parts）

クライアントアプリは「環境に依存しないコア能力」を **Port（インターフェース）** で受け取り、業務機能は **Part（パーツ）** として登録する。
コアは環境（CF/ローカル）も業務（会計ルール）も知らない＝**移植可能**。

```
パーツ（団体ごとに可変）     会計 / メモ / リマインダー / 組織ナレッジ / 名簿 …
   ↓ ctx.db / ctx.storage / ctx.ai / ctx.agent / ctx.identity にのみ依存
ポータブルコア            DB ・ ストレージ ・ AI(ChatModel) ・ エージェント(道具ループ) ・ 認証
   ↓ Port（環境アダプタ）にのみ依存
環境アダプタ              D1↔SQLite ・ KV/R2↔FS ・ クラウドLLM↔ローカルLLM ・ Portal↔ローカル認証
```

- **能力Port**（[`src/core/ports.ts`](apps/client/src/core/ports.ts)）：`SqlStore` / `StoragePort`(kv) / `AiPort` / `AgentPort` / `IdentityPort`。
- **CFアダプタ**（[`cf-adapter.ts`](apps/client/src/core/cf-adapter.ts)）：既存実装(D1/KV/R2/Gemini/Claude)を薄く包む。`middleware` が `ctx` を注入。
- **AI＝ChatModel**（[`core/ai.ts`](apps/client/src/core/ai.ts)）：モデル非依存のツールループ `runToolLoop`。アダプタは [`gemini`](apps/client/src/core/models/gemini.ts) / [`claude`](apps/client/src/core/models/claude.ts) / [`local`(OpenAI互換)](apps/client/src/core/models/local.ts) の3種。
- **パーツ**（[`src/parts/`](apps/client/src/parts/)）：業務道具を `requiredRole` 付きで登録（名簿照会は admin/会計/庶務のみ）。団体ごとに**有効パーツを選択**できる。
- **Profile**（[`profiles.ts`](apps/client/src/core/profiles.ts)）：稼働構成（AI=cloud/local・storage=r2/kv・鍵=secret/kv）を検出。`A:フルクラウド`〜`C:オフライン寄り`。
- **適合性テスト**（[`apps/client/test/`](apps/client/test/)）：**Node + `node:sqlite`** 上で同じパーツ/コアを実行し、アダプタ差し替え（CF非依存）を実証（`npm -w apps/client run test`）。

> Profile A/B/C のランタイム/ストレージ実体（D1↔SQLite・Workers↔Node）の切替は **deploy 時の構成**。
> 単一 Workers バイナリ内では AI(クラウド/ローカル) のみ実行時に切替（`LOCAL_AI_BASE_URL` 設定時）。

**新しいパーツを足す**（コアは変更しない）：

```ts
// src/parts/inventory.ts
import type { Part } from "../core/parts.ts";
export const inventoryPart: Part = {
  id: "inventory", name: "在庫",
  menu: [{ href: "/inventory", label: "在庫" }],            // 第2層：ナビに出る
  agentTools: [{                                            // エージェントの道具
    name: "record_stock", description: "在庫を記録",
    parameters: { type: "object", properties: { item: { type: "string" }, qty: { type: "number" } }, required: ["item", "qty"] },
    requiredRole: ["admin", "clerical"],                    // §14-1 認可
    run: (ctx, owner, _b, a) => ctx.db.prepare("INSERT INTO stock(...) VALUES(...)").bind(/* ... */).run().then(() => "記録しました"),
  }],
};
// src/parts/index.ts に registerPart(inventoryPart) を1行足すだけ
```

道具は `ctx.db/storage/ai` 経由なので **CF でも Node+SQLite でも無改変で動く**。
画面は `src/pages/inventory.astro`（または `src/overrides/` で上書き）。

## UIカスタマイズ（共通ベース＋上書き・3層）

基本の画面は共通のまま、団体・環境ごとに上書きできる。

| 層 | 上書きできるもの | いつ | 仕組み |
| --- | --- | --- | --- |
| 第1層 テーマ | ブランド名・ロゴ・配色 | 実行時（管理画面） | [`core/theme.ts`](apps/client/src/core/theme.ts)（`:root` 上書きCSSを注入・色値サニタイズ） |
| 第2層 構成 | ナビ表示/ラベル/並び・有効パーツ | 実行時（管理画面） | [`core/nav.ts`](apps/client/src/core/nav.ts) `buildNav()` ＋ `Part.menu` ＋ 有効パーツ選択 |
| 第3層 画面・部品 | 画面の差し替え・部分注入 | 配布時（バンドル） | [`core/overrides.ts`](apps/client/src/core/overrides.ts) ＋ [`Slot.astro`](apps/client/src/components/Slot.astro)：`src/overrides/<name>.astro`、全面置換は pages 同梱 |

- 管理は **高度なオプション**（[`settings/advanced.astro`](apps/client/src/pages/settings/advanced.astro)）＋ `api/settings`（`ui_theme`/`nav_overrides`/`enabled_parts`）。
- ベース（共通画面）は未編集のまま上流更新を取り込める（[`src/overrides/README.md`](apps/client/src/overrides/README.md)）。

## 標準同梱パーツ（一例）と機能

> 以下は**現在コアに載せている標準パーツ群**（会計・庶務・名簿・予定・議事録・リマインダー…）。
> いずれも `src/parts/` の Part として登録され、団体ごとに**有効/無効を選択**できる。別用途なら別パーツに差し替える。

プラン別ゲート（標準パーツの提供範囲）：

| プラン | 内容 | AI | エージェント |
| --- | --- | --- | --- |
| Free | 完全無料 | なし | なし |
| Plus | AIチャット・高度なオプション | Gemini（無料枠）／Claude（任意・要キー） | なし |
| Pro | エージェント利用 | 同上 | LINE（標準）＋ローカルLLM（任意・オフライン） |

- **会計コア**：入出金・現金/預金出納帳・収支計算書・予実・科目別・振替・CSV出力（現金主義・単式）。
- **マルチユーザー**：組織／個人コンテキスト、招待コード＋承認、ロール権限、名簿（PII暗号化）、個人→組織の共有承認（領収書は会計ドラフト自動生成）。
- **ファイル/予定/議事録/ナレッジ**：標準モード（KV・既定25MB・カード不要）／高度モード（R2）。
- **エージェント（Pro）**：会計記録・リマインダー・ナレッジ/メンバー検索（道具はパーツが提供）、画像OCR・大PDF要約・音声議事録・web検索（Gemini）、資料生成・スキル実行（Claude）、画像/音声/動画生成（任意API）。
- **課金**：Stripe（カード即時／振込・コンビニは入金確認・Webhook署名検証）、入金前は無料相当のプロビジョナル。
- **暗号化**：`MASTER_KEY`（AES-256-GCM）でAPIキー・PIIを保護（鍵保管は KvPort 経由）。集計に要る会計値は平文。
- **運用**：自動DBマイグレーション（失敗は診断記録）・ホスト通知（critical確認モーダル）・診断（CF制限検知→Workers Paid案内・稼働Profile表示）。

## リポジトリ構成（npm workspaces モノレポ）

```
baku-office/
  apps/host/        ホストポータル（当社アカウントへデプロイ：申込/署名ライセンス/課金/通知）
  apps/apply/       申込専用Worker（無認証導線・IPレート制限）
  apps/client/      クライアントアプリ（顧客が自己ホスト・単一Worker＝Astro静的＋API同居）
    src/core/         能力Port・ctx・CFアダプタ／ChatModel(gemini/claude/local)／theme・nav・overrides・profiles・identity
    src/parts/        業務パーツ（会計/メモ/リマインダー/ナレッジ/名簿）＝道具＋menu を登録
    src/components/   Slot 等の共通UI部品
    src/overrides/    UI上書き（配布時・第3層）
    src/lib/          会計/認証/ユーザー/ストレージ/メディアAI/能力/マイグレーション 等（ドメイン実装）
    test/             適合性テスト（Node + node:sqlite・node:test）
    migrations/       D1スキーマ（初回リクエストで自動適用）
    deploy/           配布テンプレ（wrangler.release.jsonc・DeployボタンREADME）
  packages/shared/  暗号(AES-GCM/Ed25519)・ライセンストークン・型
  worker/           旧LINEエージェント（温存・参考。エージェントは apps/client に統合）
  .github/workflows/   公開配布バンドルのCI
```

## 技術スタック

- **Astro 5 + `@astrojs/cloudflare`**（単一Workerで静的アセット＋APIエンドポイント同居）。
- **D1**（会計/ユーザー/ファイル等）・**KV**（ライセンス/セッション/暗号化キー/通知/UI設定）・**R2**（高度モード）。
- **WebCrypto**：Ed25519（ライセンス署名＝当社秘密鍵／クライアント公開鍵検証）、AES-256-GCM（`MASTER_KEY`）、PBKDF2（ローカルパスワード）、HMAC（セッション/一時Cookie/署名検証）。
- **AI（BYOK）**：Gemini（無料スタック・要約/音声/web検索）、Claude（上位・資料生成/スキル）、ローカルLLM（OpenAI互換・オフライン）、任意API（画像/音声/動画）。すべて `ChatModel` で統一。
- 認証：組織=Google OAuth、個人=LINE/Discord/ローカル（PBKDF2・未設定時は dev ログインに自動フォールバック）。
- テスト：`node --experimental-strip-types --test`（外部依存なし・Node 22 の `node:sqlite`/`node:test`）。

## 開発・デプロイ（クイックスタート）

```bash
npm install                      # ルートで（workspaces）

npm -w apps/client run test      # 適合性テスト（Node+SQLite）
npm -w apps/client run typecheck # astro check
npm -w apps/client run build     # ビルド

# デプロイ
npm -w apps/client run deploy    # astro build && wrangler deploy（自己ホスト）
npm -w apps/host run deploy      # ホストポータル（当社アカウント）

# 公開配布バンドル（難読化）の生成
npm -w apps/client run release   # apps/client/release/ に _worker.js+migrations+wrangler.jsonc
# 本番リリースは CI（apps/client 変更を main へ push → baku-office-app へ自動公開・要 PUBLISH_TOKEN）
```

- D1/KV の作成・シークレット投入を含む詳細手順は **[OPERATIONS.md](OPERATIONS.md)**。
- DBスキーマは初回リクエストで自動適用（`src/lib/migrate.ts`）。
- オフライン運用（Profile C）：`LOCAL_AI_BASE_URL`（例 `http://localhost:11434`）と `MASTER_KEY` を投入。

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| [integrated_design_package_v1.0.md](integrated_design_package_v1.0.md) | **正本の統合設計 v1.0**（概要・プラン・配備・ライセンス・認証・ダッシュボード・データモデル・暗号化・ストレージ・通知）。 |
| [baku-office_portable-core_architecture.md](baku-office_portable-core_architecture.md) | **移植性アーキ（Ports & Parts）**。コア/パーツ/環境Profile・UI3層・契約テスト・補強点(§14)。 |
| [baku-office_review_確認事項と改善点.md](baku-office_review_確認事項と改善点.md) | 第三者レビュー記録（セキュリティ・法務・倫理・コスト）。 |
| [OPERATIONS.md](OPERATIONS.md) | ホスト側／クライアント側の**操作フロー手順**（申込→発行→配備→アクティベート→日常運用→更新）。 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 更新フロー（CI配布・自動マイグレーション）と**基本＋カスタムの両立**設計。 |
| [04_threat-model.md](04_threat-model.md) | レッドチーム脅威モデル（鍵・管理者奪取を最優先で防御）。 |
| [PROGRESS.md](PROGRESS.md) | 進捗トラッカー（フェーズ・本番ゲート・決定ログ）。 |

## セキュリティ・データ

- 業務データ・会員PII・APIキーは**クライアントのCloudflare内のみ**。当社は到達経路を持たない（構造的不可触）。
- **アクティベート**：ホスト署名 relay（Ed25519）を検証してライセンス発行（生メール直叩きを遮断）。
- **エージェント認可**：発話者を登録済み active 会員に限定。組織横断の道具（名簿照会等）は role 検査（§14-1）。
- **認証**：パスワードは PBKDF2（塩・ストレッチ・定数時間比較）、一時Cookie/セッションは HMAC 署名。
- **課金/Webhook**：Stripe 署名はタイムスタンプ鮮度＋定数時間比較。申込導線は IP レート制限。
- 署名鍵は当社（**本番ゲート：KMS化／FIDO2／admin JIT は課題として保留中**）。クライアントは公開鍵で検証のみ。
- バックアップは各団体の責任（当社はデータを預からない）。退避補助ツールは将来提供。
- ライセンス無効・未入金時は**機能のみ停止**（データはロック・削除しない）。

## 状態（2026-06）

実装済み：申込/ライセンス/自動アクティベート、会計コア、マルチユーザー、ファイル/予定/議事録、共有承認、Stripe（デモ可）、認証OAuth（dev併用）、エージェント＋各AI機能、任意API、Agent Skills、診断/Workers Paid案内、UI統一・レスポンシブ、自動マイグレーション、配布CI。
さらに本リビジョンで：**ポータブルコア（Ports & Parts／契約テスト24本）**、**ローカルLLM＋ローカル認証（Profile C）**、**UI 3層カスタマイズ**、レビュー指摘のセキュリティ改修を追加。
本番化に必要：各APIクレデンシャル（Google/LINE/Discord/Stripe/Gemini/Claude）、`PUBLISH_TOKEN`、セキュリティ3ゲート。
