# baku-office

**「自社専用AIの相棒」を、あなたの会社が丸ごと所有するための基盤。**

baku-office は、AIと対話しながら自社の業務に必要な機能を自分で組み立て、
それを **自社のクラウドに丸ごと所有** できるシステムです。
会計でも、名簿でも、予約でも、問い合わせ対応でも──必要な道具をAIと一緒に作り、載せ替え、育てていく。
出来合いのSaaSを借りるのではなく、**自分たちのための相棒を所有する**。それが本質です。

---

## 3つの約束

### 1. 所有する（Own it）
アプリは **あなた自身のCloudflareアカウント** に配備されます。業務データも、コードも、暗号鍵も、すべて自社内。
当社（株式会社貘＝ホスト）が持つのはライセンス発行・配信・課金・サポートだけで、
**あなたの業務データに到達する経路を構造的に持ちません**（暗号化に頼る前に、そもそも通り道がない）。
契約を解約しても、アプリとデータはあなたの手元に残ります。ベンダーロックインからの自由です。

### 2. 作る（Build it）
**AIと話すだけで、自社のための機能（アプリ＝パーツ）を作れます。**
「会員ごとの寄付履歴を集計する画面がほしい」と頼めば、AIが企画・仕様を起こし、
**①環境 ②権限 ③安全 ④コスト** の4点を確認したうえで実装し、レビューを経て公開します。
コードを書ける人がいなくても、自社の業務に合わせて相棒を拡張できます。
会計・庶務といった標準同梱の機能も、数あるパーツの一例にすぎません。

### 3. 育てる（Grow with it）
AIエージェントが、あなたの会社の道具（パーツが提供する機能）を実際に操作します。
集計し、記録し、検索し、書類を作る。**使うほど自社業務に最適化された相棒へ育ちます。**
しかも同じコードのまま、フルクラウドから **ローカルLLMによる完全オフライン** まで動かせます。
ネットの届かない現場でも、機微情報を外に出したくないときでも、相棒はそばにいます。

> 技術的な核は **ポータブルコア（Ports & Parts）**。
> コアは「環境（どこで動くか）」も「業務（何をするか）」も知らない設計なので、
> **どこでも動き、何でも載る**。この一点が、上の3つの約束すべてを支えています。

---

## 使う人の画面は4つだけ

クライアントアプリの操作はシンプルに4つの場所に集約されています。

| 画面 | できること |
| --- | --- |
| **ホーム** | お知らせ、API／DB／ストレージの使用量、そして **導入したアプリが出すウィジェット**（例：総会員数・当月取引数）を一覧。会社の今が一目で分かる。 |
| **AI** | 相棒との **チャット**。会話はセッションとして保存・切替でき、**モデル（Gemini／Claude／ローカル）を選択**可能。集計・検索・書類作成を頼める。ここで「〜するアプリを作って」と言えば、新しいアプリ作りも始まる。 |
| **アプリ** | 自社に入れる機能の出し入れ。**マーケットから導入／削除**、**外部レジストリから署名検証付きで取り込み**、**AIと作った草案の公開申請**まで。 |
| **設定** | 必要な設定・オプションをカテゴリ別に集約（メンバー・連携・課金・カスタマイズ・運用）。 |

---

## AIでアプリを作る（開発フロー）

baku-office のアプリ（パーツ）は、自社リポジトリ上で **AI（Gemini／Claude）と対話して開発** できます。
no-code ツールの枠を越え、Cloudflare／ローカルの実行範囲内で本物のバックエンドを使った独自機能を作れます。

```
チャットで依頼  →  AIが企画・仕様を作成  →  事前4確認  →  実装  →  レビュー  →  公開申請  →  ホスト承認  →  署名つき配信
   「〜したい」      何を作るか合意           ①環境            ドラフト    要求権限と       （マーケットへ）   （改ざん検知）
                                            ②権限            生成        4確認を点検
                                            ③安全
                                            ④コスト
```

- **必ず企画・仕様 → 4確認の順**：いきなり実装させず、環境・権限・安全・コストを確認してから着手します。
- **安全側に拒絶**：データ破壊や認証バイパスなど、悪意ある仕組みは拒否。許すのは「自社の業務を助ける範囲」に限定。
- **最小構成は「設定画面」だけ**でもよく、**Plus プラン以上は AIチャットを必須**として相棒を中心に据えます。
- 公開されたアプリは **複数の団体で再利用** でき、`version` を上げれば **導入先すべてに更新が波及**、既存アプリを複製・改変すれば **派生として新アプリ** になります。

詳細は [baku-office_portable-core_architecture.md](baku-office_portable-core_architecture.md) の §14。

---

## 所有モデル（ホスト⇄クライアントの信頼境界）

baku-office は **クライアント自己ホスト型**。アプリは利用団体（クライアント）自身のCloudflareで動き、
当社（ホスト）は申込・ライセンス・配信・課金・サポートだけを担います。

```
当社（ホスト）アカウント                         利用団体（クライアント）アカウント
┌───────────────────────────┐               ┌───────────────────────────────┐
│ baku-office-portal (Astro/Worker) │  署名ライセンス・更新・お知らせ │ baku-office-app (Astro/単一Worker) │
│  申込・ライセンス発行・課金       │ ───────────────▶ │  4画面のWebアプリ＋AI相棒＋自作アプリ群 │
│  クライアント管理・お知らせ配信   │ ◀─────────────── │  業務データ・暗号鍵は D1/KV/R2（顧客保有）│
│  （業務データ・PIIは保持しない）  │   テレメトリ(PIIなし)・通知       │  当社からは到達経路がない（構造的不可触）  │
└───────────────────────────┘               └───────────────────────────────┘
        ▲ private 正本(モノレポ)                         ▲ Deploy to Cloudflare（公開配布リポ）
        └── CI で難読化バンドルを公開リポへ ──────────────┘
```

- **ホスト**：申込 → 署名ライセンス発行 → 個別Deployリンク。クライアントは公開鍵で検証するだけ。
- **クライアント**：Deployボタンで自分のCFへ配備。初回起動で申込時Googleにより **自動アクティベート**（キー入力なし／ホスト署名relayを検証）。
- **境界を越えるのは**「ライセンス／エンタイトルメント／通知」だけ。業務データ・会員PII・APIキーは越えません。

> **専用ツール（団体X）＝ 環境Profile × 有効パーツ集合 × 連動する外部API。** 3軸は直交し、
> 環境を変えてもパーツは無改変、パーツを変えても環境は無改変で動く。これが「相棒を自由に作り替えられる」根拠です。

---

## ポータブルコア（Ports & Parts）

クライアントアプリは「環境に依存しないコア能力」を **Port（インターフェース）** で受け取り、業務機能は **Part（パーツ）** として登録します。
コアは環境（CF／ローカル）も業務（会計ルール）も知らない＝**移植可能**。

```
パーツ（団体ごとに可変）     会計 / 名簿 / メモ / リマインダー / 組織ナレッジ / AIチャット / 自作アプリ …
   ↓ ctx.db / ctx.storage / ctx.ai / ctx.agent / ctx.identity / ctx.apps にのみ依存
ポータブルコア            DB ・ ストレージ ・ AI(ChatModel) ・ エージェント(道具ループ) ・ 認証 ・ アプリ管理
   ↓ Port（環境アダプタ）にのみ依存
環境アダプタ              D1↔SQLite ・ KV/R2↔FS ・ クラウドLLM↔ローカルLLM ・ Portal↔ローカル認証
```

- **能力Port**（[`src/core/ports.ts`](apps/client/src/core/ports.ts)）：`SqlStore` / `StoragePort`(kv) / `AiPort` / `AgentPort` / `IdentityPort` / `AppsApi`。
- **CFアダプタ**（[`cf-adapter.ts`](apps/client/src/core/cf-adapter.ts)）：既存実装(D1/KV/R2/Gemini/Claude)を薄く包む。`middleware` が `ctx` を注入。
- **AI＝ChatModel**（[`core/ai.ts`](apps/client/src/core/ai.ts)）：モデル非依存のツールループ `runToolLoop`（会話履歴を引き継ぐ）。アダプタは [`gemini`](apps/client/src/core/models/gemini.ts) / [`claude`](apps/client/src/core/models/claude.ts) / [`local`(OpenAI互換)](apps/client/src/core/models/local.ts) の3種。
- **パーツ**（[`src/parts/`](apps/client/src/parts/)）：業務道具＋ナビ(`menu`)＋ホーム表示(`widgets`)を `requiredRole` 付きで登録。団体ごとに**有効パーツを選択**。
- **Profile**（[`profiles.ts`](apps/client/src/core/profiles.ts)）：稼働構成（AI=cloud/local・storage=r2/kv・鍵=secret/kv）を検出。`A:フルクラウド`〜`C:オフライン寄り`。
- **適合性テスト**（[`apps/client/test/`](apps/client/test/)）：**Node + `node:sqlite`** 上で同じパーツ/コアを実行し、アダプタ差し替え（CF非依存）を実証（`npm -w apps/client run test`）。

**新しいパーツを足す**（コアは変更しない）：

```ts
// src/parts/inventory.ts
import type { Part } from "../core/parts.ts";
export const inventoryPart: Part = {
  id: "inventory", name: "在庫", version: "1.0.0", category: "庶務",
  menu: [{ href: "/inventory", label: "在庫" }],             // 「アプリ」ランチャーに出る
  widgets: [{ id: "stock_count", title: "在庫点数",         // ホームに出るウィジェット
    run: async (ctx) => ({ value: String((await ctx.db.prepare("SELECT COUNT(*) c FROM stock").first<{c:number}>())?.c ?? 0) }) }],
  agentTools: [{                                            // 相棒（エージェント）の道具
    name: "record_stock", description: "在庫を記録",
    parameters: { type: "object", properties: { item: { type: "string" }, qty: { type: "number" } }, required: ["item", "qty"] },
    requiredRole: ["admin", "clerical"],                    // 認可（§14-1）
    run: (ctx, owner, _b, a) => ctx.db.prepare("INSERT INTO stock(...) VALUES(...)").bind(/* ... */).run().then(() => "記録しました"),
  }],
};
// src/parts/index.ts に registerPart(inventoryPart) を1行足すだけ
```

道具は `ctx.db/storage/ai` 経由なので **CF でも Node+SQLite でも無改変で動く**。画面は `src/pages/inventory.astro`（または `src/overrides/` で上書き）。

**パーツ＝再利用可能アプリ**（`id`/`name`/`version`）：①**複数団体で共有**（各団体が ON/OFF）、②アプリ更新（`version` 上げ）は配布で**導入先すべてに波及**（自動マイグレーション）、③既存アプリを複製し `id` を変えて改変＝**派生で新アプリ**（`derivedFrom` に派生元）。

---

## UIカスタマイズ（共通ベース＋上書き・3層）

基本の画面は共通のまま、団体・環境ごとに上書きできます。

| 層 | 上書きできるもの | いつ | 仕組み |
| --- | --- | --- | --- |
| 第1層 テーマ | ブランド名・ロゴ・配色 | 実行時（設定） | [`core/theme.ts`](apps/client/src/core/theme.ts)（`:root` 上書きCSSを注入・色値サニタイズ） |
| 第2層 構成 | ナビ表示/ラベル/並び・有効パーツ | 実行時（設定／アプリ） | [`core/nav.ts`](apps/client/src/core/nav.ts) `buildNav()` ＋ `Part.menu` ＋ 有効パーツ選択 |
| 第3層 画面・部品 | 画面の差し替え・部分注入 | 配布時（バンドル） | [`core/overrides.ts`](apps/client/src/core/overrides.ts) ＋ [`Slot.astro`](apps/client/src/components/Slot.astro)：`src/overrides/<name>.astro`、全面置換は pages 同梱 |

- テーマ・ナビ・有効パーツは「設定」「アプリ」画面から（`api/settings` の `ui_theme`/`nav_overrides`/`enabled_parts`）。
- ベース（共通画面）は未編集のまま上流更新を取り込めます（[`src/overrides/README.md`](apps/client/src/overrides/README.md)）。

---

## プランと標準同梱パーツ（一例）

**申込時はプランを選ばず、全員 Free で開始。** AI（Plus）・エージェント（Pro）へのアップグレードは
導入後に「設定 → プラン・課金」(`/billing`) から行います。

| プラン | 内容 | AI | エージェント |
| --- | --- | --- | --- |
| Free | 完全無料 | なし | なし |
| Plus | AIチャット・AIアプリ開発・高度なオプション | Gemini（無料枠）／Claude（任意・要キー） | なし |
| Pro | エージェント利用 | 同上 | LINE（標準）＋ローカルLLM（任意・オフライン） |
| test | **全機能解放**（評価・社内検証用） | すべて | すべて |

> `test` はホスト管理画面から対象アカウントに付与する評価用エンタイトルメント。内部キーは `free / plus / pro / test`。

**標準同梱パーツ（現在コアに載せている一例。別用途なら差し替え可）**：

- **会計**：入出金・現金/預金出納帳・収支計算書・予実・科目別・振替・CSV出力（現金主義・単式）。
- **名簿（マルチユーザー）**：組織／個人コンテキスト、招待コード＋承認、ロール権限、会員PII暗号化、個人→組織の共有承認（領収書は会計ドラフト自動生成）。
- **メモ／リマインダー／組織ナレッジ／ファイル・予定・議事録**：標準モード（KV・既定25MB・カード不要）／高度モード（R2）。
- **AIチャット**：相棒の中心。セッション保存・モデル選択、集計・検索・書類作成、ここからアプリ開発。
- **エージェント（Pro）**：道具操作（記録・リマインド・検索）、画像OCR・大PDF要約・音声議事録・web検索（Gemini）、資料生成・スキル実行（Claude）、画像/音声/動画生成（任意API）。

---

## リポジトリ構成（npm workspaces モノレポ）

```
baku-office/
  apps/host/        ホストポータル（当社アカウントへデプロイ：申込/署名ライセンス/課金/通知/アプリ承認）
  apps/apply/       申込専用Worker（無認証導線・IPレート制限・プラン非選択）
  apps/client/      クライアントアプリ（顧客が自己ホスト・単一Worker＝Astro静的＋API同居）
    src/core/         能力Port・ctx・CFアダプタ／ChatModel(gemini/claude/local)／apps・theme・nav・overrides・profiles・identity
    src/parts/        業務パーツ（会計/名簿/メモ/リマインダー/ナレッジ/AIチャット）＝道具＋menu＋widgets を登録
    src/pages/        4画面（index=ホーム / chat=AI / apps=アプリ / settings=設定）＋業務画面
    src/components/   Slot 等の共通UI部品
    src/overrides/    UI上書き（配布時・第3層）
    src/lib/          会計/認証/チャットセッション/ストレージ/メディアAI/外部アプリ/マイグレーション 等
    test/             適合性テスト（Node + node:sqlite・node:test）
    migrations/       D1スキーマ（初回リクエストで自動適用）
    deploy/           配布テンプレ（wrangler.release.jsonc・DeployボタンREADME）
  packages/shared/  暗号(AES-GCM/Ed25519)・ライセンストークン・型（Entitlement: free/plus/pro/test）
  worker/           旧LINEエージェント（温存・参考。エージェントは apps/client に統合）
  .github/workflows/   公開配布バンドル／署名リリースのCI
```

## 技術スタック

- **Astro 5 + `@astrojs/cloudflare`**（単一Workerで静的アセット＋APIエンドポイント同居）。
- **D1**（業務データ／チャット履歴等）・**KV**（ライセンス/セッション/暗号化キー/通知/UI設定）・**R2**（高度モード）。
- **WebCrypto**：Ed25519（ライセンス署名／リリース署名）、AES-256-GCM（`MASTER_KEY`・鍵保管は KvPort 経由）、PBKDF2（ローカルパスワード）、HMAC（セッション/一時Cookie/署名検証）。
- **AI（BYOK）**：Gemini（無料スタック）、Claude（上位・資料生成/スキル）、ローカルLLM（OpenAI互換・オフライン）、任意API（画像/音声/動画）。すべて `ChatModel` で統一。
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
| [integrated_design_package_v1.0.md](integrated_design_package_v1.0.md) | **正本の統合設計**（コンセプト・所有モデル・4画面・AIアプリ開発・プラン・配備・ライセンス・認証・データモデル・暗号化・ストレージ・通知）。 |
| [baku-office_portable-core_architecture.md](baku-office_portable-core_architecture.md) | **移植性アーキ（Ports & Parts）**。コア/パーツ/環境Profile・UI3層・契約テスト・補強点(§14・AIアプリ開発)。 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 更新フロー（CI配布・自動マイグレーション）と**基本＋カスタムの両立**設計。 |
| [OPERATIONS.md](OPERATIONS.md) | ホスト側／クライアント側の**操作フロー手順**（申込→発行→配備→アクティベート→日常運用→更新）。 |
| [03_multitenant-saas-architecture.md](03_multitenant-saas-architecture.md) | 1000社スケールのマルチテナント設計（ティア・課金・レジストリ・運用）。 |
| [04_threat-model.md](04_threat-model.md) | レッドチーム脅威モデル（鍵・管理者奪取を最優先で防御）。 |
| [baku-office_review_確認事項と改善点.md](baku-office_review_確認事項と改善点.md) | 第三者レビュー記録（セキュリティ・法務・倫理・コスト）。 |
| [PROGRESS.md](PROGRESS.md) | 進捗トラッカー（フェーズ・本番ゲート・決定ログ）。 |

> `01_deploy-pipeline.md` / `02_cloud-agent.md` / `worker/SETUP.md` は旧 `cf-line-agent-kit`（LINEエージェント単体）期のレガシー資料（各先頭に明記）。現行のエージェントは apps/client に統合済み。

## セキュリティ・データ

- 業務データ・会員PII・APIキーは**クライアントのCloudflare内のみ**。当社は到達経路を持たない（構造的不可触）。
- **アクティベート**：ホスト署名 relay（Ed25519）を検証してライセンス発行（生メール直叩きを遮断）。
- **AIアプリ開発の安全**：破壊的操作・認証バイパス等を拒絶。要求権限は事前4確認（環境/権限/安全/コスト）で点検し、公開はホスト承認＋署名で配信。
- **エージェント認可**：発話者を登録済み active 会員に限定。組織横断の道具（名簿照会等）は role 検査（§14-1）。
- **認証**：パスワードは PBKDF2（塩・ストレッチ・定数時間比較）、一時Cookie/セッションは HMAC 署名。管理者セッション鍵 `ADMIN_KEY` は**本番（`ENV≠development`）で必須＝fail-closed**、dev 管理者ログインは `ENV=development` 限定。
- **SSRF 対策**：ホストがサーバーサイド fetch する `deploy_url`（A2A 中継・統合チェック保存）は `isSafeDeployUrl` で検査（https 必須・IP/内部ホスト名拒否）。
- **アプリ配布**：公開申請（`/api/registry/submit`）は署名ライセンストークン認証。停止（blocked）は統合チェックの `revokedApps` で**導入済みクライアントからも即時無効化（キルスイッチ）**。
- **監査**：ホスト管理操作（プラン変更・顧客削除・アプリ承認/停止・NonProfit 審査）は `host_audit` に記録（`/audit`）。
- **課金/Webhook**：Stripe 署名はタイムスタンプ鮮度＋定数時間比較。申込導線は IP レート制限＋入力検証（長さ・メール形式）。
- 署名鍵は当社（**本番ゲート：KMS化／FIDO2／admin JIT は課題として保留中**）。クライアントは公開鍵で検証のみ。
- バックアップは各団体の責任（当社はデータを預からない）。退避補助ツールは将来提供。
- ライセンス無効・未入金時は**機能のみ停止**（データはロック・削除しない）。解約後もアプリ・データは手元に残る。

## 状態（2026-06-09）

実装済み：申込（プラン非選択）/ライセンス/自動アクティベート、4画面UI（ホーム/AI/アプリ/設定）、AIチャット（セッション保存・モデル選択）、AIアプリ開発（企画→4確認→公開）、会計コア、マルチユーザー、ファイル/予定/議事録、共有承認、Stripe接続（鍵投入で稼働）、認証OAuth（dev併用）、エージェント＋各AI機能、任意API、Agent Skills、診断/Workers Paid案内、ポータブルコア（Ports & Parts／契約テスト）、ローカルLLM＋ローカル認証（Profile C）、UI3層カスタマイズ、自動マイグレーション、配布CI、署名リリース。
**2026-06-08〜09 追加**：マルチエージェント（社内・Pro）、A2A（他団体連携・1:1/グループ/公開アクション・Pro）、ホスト主体マーケット（DL/5段階評価/ランキング・ユニーク導入数）、NonProfit プラン（非営利・全機能無料・ホスト審査）、オートパイロット（AIサーバー自治・GitHub OAuth デバイスフロー・CI 成功時のみ squash マージ＋コア領域はマージ拒否）、ホスト監査ログ（`/audit`）、運用堅牢化（顧客削除の安全化＋カスケード、一覧の検索/フィルタ/ページング、申込入力検証）、セキュリティ追加（SSRF 検査／`ADMIN_KEY` fail-closed＋dev login 封鎖／アプリ キルスイッチ／submit 署名トークン認証）。本番3 Worker 反映済み。
本番化に必要：各APIクレデンシャル（Google/LINE/Discord/Stripe/Gemini/Claude）、`PUBLISH_TOKEN`、セキュリティ3ゲート（KMS署名／FIDO2／admin JIT）。
