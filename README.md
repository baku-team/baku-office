# baku-office

**クラウド会計・庶務補助システム**（LINEエージェント内蔵）。Cloudflare 上で動き、
**業務データは利用団体（クライアント）自身のCloudflare内に保管**、当社（ホスト＝株式会社貘）は
ソフトウェアのライセンス発行・配信・課金・サポートのみを行う（**データに到達経路を持たない**自己ホスト型）。

- 正本の仕様：[integrated_design_package_v1.0.md](integrated_design_package_v1.0.md)
- 操作手順：[OPERATIONS.md](OPERATIONS.md) ／ 更新・カスタム設計：[ARCHITECTURE.md](ARCHITECTURE.md)
- 旧称 `cf-line-agent-kit`（LINEエージェント単体）。2026-06 に会計・庶務SaaS **baku-office** へ再設計。

---

## アーキテクチャ

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
- **クライアント**：Deployボタンで自分のCFへ自己ホスト。初回起動で申込時Googleにより**自動アクティベート**（認証キー入力なし）。
- **配信境界**：当社→クライアントは「ライセンス／エンタイトルメント／通知」のみ。業務データ・PII・APIキーは境界を越えない。

## プランと機能

| プラン | 内容 | AI | エージェント |
| --- | --- | --- | --- |
| X | 完全無料 | なし | なし |
| Y | AI利用（低価格） | Gemini | なし |
| Z | エージェント利用 | Gemini | LINE（標準）／Claude（上位・分離） |

- **会計コア**：入出金・現金/預金出納帳・収支計算書・予実・科目別・振替・CSV出力（現金主義・単式）。
- **マルチユーザー**：組織／個人コンテキスト、招待コード＋承認、ロール権限、名簿（PII暗号化）、個人→組織の共有承認（領収書は会計ドラフト自動生成）。
- **ファイル/予定/議事録/ナレッジ**：標準モード（KV・既定25MB・カード不要）／高度モード（R2）。
- **LINEエージェント（Z）**：会話・会計記録・リマインダー・ナレッジ検索・メンバー検索、画像OCR・大PDF要約・音声議事録・web検索（Gemini）、資料生成・スキル実行（Claude）、画像/音声/動画生成（任意API）。
- **課金**：Stripe（カード即時／振込・コンビニは入金確認）、入金前は無料相当のプロビジョナル。
- **暗号化**：`MASTER_KEY`（AES-256-GCM）でAPIキー・PIIを保護。集計に要る会計値は平文。
- **運用**：自動DBマイグレーション・ホスト通知（critical確認モーダル）・診断（CF制限検知→Workers Paid案内）。

## リポジトリ構成（npm workspaces モノレポ）

```
baku-office/
  apps/host/        ホストポータル（当社アカウントへデプロイ）
  apps/client/      クライアントアプリ（顧客が自己ホスト・単一Worker＝Astro静的＋API同居）
    src/lib         会計/認証/ユーザー/ストレージ/エージェント/能力/マイグレーション 等
    migrations/     D1スキーマ（自動適用）
    deploy/         配布テンプレ（wrangler.release.jsonc・DeployボタンREADME）
  packages/shared/  暗号(AES-GCM/Ed25519)・ライセンストークン・型
  worker/           旧LINEエージェント（温存・参考。Zエージェントは apps/client に統合）
  .github/workflows/publish-client.yml   公開配布バンドルのCI
```

## 技術スタック

- **Astro 5 + `@astrojs/cloudflare`**（単一Workerで静的アセット＋APIエンドポイント同居）。
- **D1**（会計/ユーザー/ファイル等）・**KV**（ライセンス/セッション/暗号化キー/通知）・**R2**（高度モード）。
- **WebCrypto**：Ed25519（ライセンス署名＝当社秘密鍵／クライアント公開鍵検証）、AES-256-GCM（`MASTER_KEY`）。
- **AI（BYOK）**：Gemini（無料スタック・要約/音声/web検索）、Claude（上位・資料生成/スキル）、任意API（画像/音声/動画）。
- 認証：組織=Google OAuth、個人=LINE/Discord/ローカル（未設定時は dev ログインに自動フォールバック）。

## 開発・デプロイ（クイックスタート）

```bash
npm install                      # ルートで（workspaces）

# クライアントアプリ（自己ホスト想定。検証は当社アカウントへも可）
npm -w apps/client run deploy    # astro build && wrangler deploy
# ホストポータル（当社アカウント）
npm -w apps/host run deploy

# 公開配布バンドル（難読化）の生成
npm -w apps/client run release   # apps/client/release/ に _worker.js+migrations+wrangler.jsonc

# 本番リリースは CI（apps/client 変更を main へ push → baku-office-app へ自動公開・要 PUBLISH_TOKEN）
```

- D1/KV の作成・シークレット投入を含む詳細手順は **[apps/client/SETUP.md](apps/client/SETUP.md)** と **[OPERATIONS.md](OPERATIONS.md)**。
- DBスキーマは初回リクエストで自動適用（`src/lib/migrate.ts`）。

## ドキュメント

| ファイル | 内容 |
| --- | --- |
| [integrated_design_package_v1.0.md](integrated_design_package_v1.0.md) | **正本の統合設計 v1.0**（概要・プラン・配備・ライセンス・認証・ダッシュボード・データモデル・暗号化・ストレージ・通知）。 |
| [OPERATIONS.md](OPERATIONS.md) | ホスト側／クライアント側の**操作フロー手順**（申込→発行→配備→アクティベート→日常運用→更新）。 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 更新フロー（CI配布・自動マイグレーション）と**基本＋カスタムの両立**設計。 |
| [03_multitenant-saas-architecture.md](03_multitenant-saas-architecture.md) | 多数団体への提供・運用の事業設計（中核仕様の前身）。 |
| [04_threat-model.md](04_threat-model.md) | レッドチーム脅威モデル（鍵・管理者奪取を最優先で防御）。 |
| [05_implementation-stack.md](05_implementation-stack.md) | 技術スタックとフェーズ計画。 |
| [PROGRESS.md](PROGRESS.md) | 進捗トラッカー（フェーズ・本番ゲート・決定ログ）。 |
| [事業説明資料.html](事業説明資料.html) | 事業説明（提案用）。 |

## セキュリティ・データ

- 業務データ・会員PII・APIキーは**クライアントのCloudflare内のみ**。当社は到達経路を持たない（構造的不可触）。
- 署名鍵は当社（**本番ゲート：KMS化／FIDO2／admin JIT は課題として保留中**）。クライアントは公開鍵で検証のみ。
- バックアップは各団体の責任（当社はデータを預からない）。退避補助ツールは将来提供。
- ライセンス無効・未入金時は**機能のみ停止**（データはロック・削除しない）。

## 状態（2026-06）

実装済み：申込/ライセンス/自動アクティベート、会計コア、マルチユーザー、ファイル/予定/議事録、共有承認、Stripe（デモ可）、認証OAuth（dev併用）、LINEエージェント＋各AI機能、任意API、Agent Skills、診断/Workers Paid案内、UI統一・レスポンシブ、自動マイグレーション、配布CI。
本番化に必要：各APIクレデンシャル（Google/LINE/Discord/Stripe/Gemini/Claude）、`PUBLISH_TOKEN`、セキュリティ3ゲート。
