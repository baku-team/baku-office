# baku-office

LINE 上で動く **Baku の業務AIエージェント（baku-office）**。GitHub → Cloudflare → LINE を連動させ、
Claude API / Gemini で動くエージェントを、**ホスト（署名・配信）／クライアント（顧客Worker）** の2構成で運用する。

> 旧称 cf-line-agent-kit（汎用テンプレートとして設計）。2026-06 に **baku-office** として本番開発へ移行。
> 最新の統合設計は [integrated_design_package_v1.0.md](integrated_design_package_v1.0.md) を参照。

## このキットで作れるもの

LINE 公式アカウントに話しかけると、Cloudflare Workers 上のエージェントが応答する。
コードを GitHub に push するだけで Cloudflare に自動デプロイされる。

```
ユーザー
  │  LINE トーク
  ▼
LINE Messaging API ──Webhook──▶ Cloudflare Workers（エージェント本体）
                                   │
                          ┌────────┴─────────┐
                          ▼                  ▼
                   Workers AI          Claude API
                 (軽量・無料枠中心)   (高品質な対話・推論)
                          │                  │
                          └────────┬─────────┘
                                   ▼
                          ツール実行 / D1・KV
                                   │
                                   ▼
                       LINE へ返信（reply / push）
```

デプロイ経路：

```
git push (main)
   │
   ▼
GitHub Actions ──wrangler deploy──▶ Cloudflare Workers / Pages / D1
```

## 構成ファイル

| ファイル | 内容 |
|---|---|
| [01_deploy-pipeline.md](01_deploy-pipeline.md) | GitHub ⇔ Cloudflare ⇔ LINE の連動とデプロイ基盤。Webhook 登録、Secrets、CI/CD、（任意の）マルチテナント配布。 |
| [02_cloud-agent.md](02_cloud-agent.md) | Workers AI + Claude API のエージェント本体。意図解釈・ツール実行・最終応答生成・会話履歴。 |
| [03_multitenant-saas-architecture.md](03_multitenant-saas-architecture.md) | **多数の企業・団体へ提供し運用を当社が担う事業設計**。**ベース運用形態＝顧客所有アカウント＋当社は承認・ロジック配信のみ＋ライセンス制御（本文非中継・17章）**：当社は原則データを保有せず、Anthropic/LINEは顧客が直接やり取り、未払い・規約違反は**エージェント機能のみ停止**（データは人質にしない）。アカウント作成は顧客自己申込＋有償支援、共同管理はCFのみ。当社ホスト型(シャーディング100社/アカウント)は予算オプション。GitOps/CLI運用・プラン設計・使用量上限/コスト可視化・アンチアビュース・暗号化/PIIマスキング/リージョン(任意)・常時監視・**ベンダーロックイン回避**・バックアップ/DR・**ユーザー定義ツール/スケジュール/マルチチャネル(LINE/Discord)**・採算設計(顧客アカウント型=粗利ほぼ純利／ホスト型=95%)・**エージェント間連携(A2A)**・**組織記憶＋団体別人格**・**技術ハードニング**。1000社スケール前提。 |

| [04_threat-model.md](04_threat-model.md) | **レッドチーム脅威モデル**：攻撃者別の攻撃ベクトル・成功可否・損害・防御。構造的残存（client改造/IP抽出）と致命的攻撃（鍵・管理者奪取）の切り分け。正式対策は 03 の 16-10。 |
| [05_implementation-stack.md](05_implementation-stack.md) | **技術スタック**。確定スタック（Workers/TS/WebCrypto/Wrangler/Vitest、KV/D1/Workers AI、BYOK能力レジストリ）、フェーズ計画。（PoCコード `poc/`・`poc-workers/` は本番化に伴い削除済み＝履歴は PROGRESS 参照） |
| [PROGRESS.md](PROGRESS.md) | **進捗トラッカー（生きた管理ファイル）**。ビルドフェーズ・本番ゲート(🔒)・実行順序・決定ログをチェックリストで管理。着手/完了で更新。 |
| [worker/](worker/) ／ [worker/SETUP.md](worker/SETUP.md) | **本番アプリ（実装コード）＋立ち上げ手順**。1つのコードを **クライアント（`wrangler.client.toml`＝LINE/会話/データ・検証のみ）** と **ホスト（`wrangler.host.toml`＝署名・配信専用）** の2Workerにデプロイ。`setup-client.sh`／`setup-host.sh`／`setup-tenant.sh`。 |
| [integrated_design_package_v1.0.md](integrated_design_package_v1.0.md) | **統合設計パッケージ v1.0（baku-office の最新の正）**。01〜05 と PROGRESS を統合した到達点。新規参照はまずこれ。 |

> 01/02 は「1つのエージェントを動かす」最小キット。03 は「それを事業として運用する」上位設計。04 はそのセキュリティ基準。
> 新運用形態では、02 のオーケストレーションは固定 Worker として顧客アカウントへ事前配備（難読化）し、当社CPがライセンスゲートで配信するのは config（プロンプト/ツール/人格/パラメータ＝データ）のみ（Workers は eval 不可＝コードは事前配備が前提）。Anthropic/LINEは顧客が直接・本文は当社を通らない＝非中継。03 の 17-2。

## 設計方針（シンプル化のためのルール）

- **2 層のAIだけ**: 軽量処理は Workers AI、高品質な対話・推論は Claude API。中継ゲートウェイや BYOK は入れない。APIキーは Worker の Secrets に直接置く。
- **PIIマスキング層は標準では持たない**。必要な案件だけ後から足す。
- **ストレージは最小**: 会話履歴とエージェントの状態は KV、永続データが要るときだけ D1。
- **デプロイは push 一発**。テナントが 1 つなら matrix も不要、`wrangler deploy` だけで動く。
- **エージェントは「読む・足す」中心**。破壊的操作はツールの権限制御で絞る（[02](02_cloud-agent.md) 参照）。

## 5 分クイックスタート

> 🚀 **本番アプリの立ち上げは [worker/SETUP.md](worker/SETUP.md)** を参照（クライアント/ホストの2Worker構成・`setup-client.sh`→`setup-host.sh`）。下記は素のWorkerをゼロから作る最小例。

```bash
npm create cloudflare@latest my-agent -- --type hello-world
cd my-agent
npx wrangler login

# Secrets を投入
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put ANTHROPIC_API_KEY

# Workers AI バインドを wrangler.toml に追加（[ai] binding = "AI"）してデプロイ
npx wrangler deploy
```

詳細は各ファイル参照。
