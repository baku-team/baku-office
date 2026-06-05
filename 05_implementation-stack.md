> ℹ️ **背景資料（PoC記録）**：本書は PoC期の記録です。**現行スタックは [README.md](README.md)（Astro+@astrojs/cloudflare、D1/KV/R2、Gemini/Claude/任意API・BYOK）**、正本は [integrated_design_package_v1.0.md](integrated_design_package_v1.0.md)。PoCコード（`poc/`・`poc-workers/`）は削除済み。

# 05. 実装 — PoC記録と技術スタック

[03](03_multitenant-saas-architecture.md) の設計を実装に移すための、**PoC実測の記録**と**確定した技術スタック**。実装は原則 Claude Code で自動化し、顧客/開発者の手作業を最小化する。

---

## 1. PoC記録

### フェーズ0：配信機構の核心を実測（#2）— ✅ 合格 9/9

**目的**：事業全体の前提（17-2/17-3）が成立するかを、外部アカウント不要・ローカルのみで実測する。

| 項目 | 内容 |
|---|---|
| 場所 | [poc/](poc/)（依存ゼロ・Node 18+／実測は Node v22 で確認） |
| 実行 | `cd poc && node test.mjs` |
| 結果 | **9 passed / 0 failed** |

**実装ファイル**
| ファイル | 役割 |
|---|---|
| `poc/lib/crypto.mjs` | Ed25519 署名/検証（署名付きエンベロープ `{payload, sig}`） |
| `poc/lib/approval.mjs` | 承認サーバ相当：署名済みリース（`paid_through`/`suspended`）＋署名済みconfigを発行 |
| `poc/lib/agent.mjs` | 固定インタープリタ：署名検証→ライセンス判定→**configだけで挙動**。データは別ストア |
| `poc/configs/v1.json`,`v2.json` | 配信する設定（人格・能力・応答）＝データ（コードでない） |
| `poc/test.mjs` | 機能テスト（下記3点を検証） |

**実証できたこと（=設計前提が成立）**
1. **config（データ）だけで挙動が変わる**：同一の固定コードのまま v1→v2 差し替えで人格・利用可能能力が変化（**コード配信ゼロ**）。
2. **ライセンス無効 → 機能のみ停止／データ無停止**：`suspended`/`paid_through`経過で `run()` 停止、保存済みデータは保持、支払い確認（`paid_through`延長）で即再開。
3. **署名検証**：改ざんconfig・別鍵の偽造リースを拒否（Ed25519）。

**PoC → 本番の対応**
| PoC（ローカル） | 本番（03） |
|---|---|
| `lib/approval.mjs`（関数） | 承認サーバ Worker（多リージョン・17-4）＋ **KMS署名**（16-10） |
| `lib/crypto.mjs`（node:crypto） | **WebCrypto `subtle`**（Workers・同アルゴリズム） |
| `lib/agent.mjs`（固定） | 顧客アカウントの固定 Worker（17-2）。config は `/lease` で配信 |
| `configs/*.json` | **R2 の署名済み config**（版・ring・17-9） |
| ローカル開発鍵 | 署名鍵は **KMS/HSM「署名のみ」**（セキュリティ3ゲート・16-10・顧客提供段階で実装） |

---

## 2. 技術スタック（確定）

基本＝**Cloudflare Workers ＋ TypeScript ＋ Web標準API**。データ層は**S3互換＋素のSQL＋アダプタ**でロックイン回避（12章）。

### コア（全レイヤー共通）
| 区分 | 採用 |
|---|---|
| ランタイム | **Cloudflare Workers**（V8 isolate・WinterCG） |
| 言語 | **TypeScript**（ESM）※PoC-0のみJS |
| 暗号 | **Ed25519 / WebCrypto `crypto.subtle`** |
| 署名形式 | **自前の署名付きエンベロープ**（軽量） |
| ビルド/デプロイ | **Wrangler**（`dev`=ローカルworkerd／`deploy`） |
| テスト | **Vitest ＋ `@cloudflare/vitest-pool-workers`** |
| パッケージ | **pnpm** |
| CI/CD | **GitHub Actions** |
| CLI | **`tenantctl`（軽量自作・Node/TS）** |

### コントロールプレーン（当社アカウント）
| 機能 | スタック |
|---|---|
| 承認/ライセンス＋config配信API | Worker（多リージョン・17-4） |
| サブスク状態・rollout state | KV（グローバル複製・各地ローカル読取） |
| 署名済みconfigアーティファクト | R2（版・ring・ハッシュ/署名） |
| レジストリ・監査 | D1（SQLite） |
| 署名鍵 | 外部KMS（Google/AWS）"署名のみ"／暫定 Secrets Store（16-10・後フェーズ） |
| テレメトリ | Analytics Engine／使用量は GraphQL Analytics |

### 顧客アカウント側（顧客所有）
| 機能 | スタック |
|---|---|
| 固定エージェント（インタープリタ） | Worker（config駆動・コード固定・17-2） |
| メインブレイン（必須・BYOK） | `@anthropic-ai/sdk`／`openai`／`@google/generative-ai`（能力`chat`に1つ） |
| 能力プロバイダ（任意・BYOK） | 画像/動画/STT/TTS/検索…を fetch/各SDKで直接（非中継・5-2b） |
| 無料フォールバック | Workers AI（`env.AI`）：embed・whisper・基本画像・ocr |
| データ | D1／R2／KV（顧客内）＋ Queues（長時間）＋ Cron（heartbeat/定期） |
| 上限カウンタ | D1（無料）→ Durable Objects（Paid・後） |
| 組織記憶/RAG | Vectorize（or pgvector・差し替え可） |
| チャネル | LINE Messaging API／Discord（fetch＋WebCrypto署名検証）。`MessagingChannel`抽象 |

### 確定した設計判断
- 言語＝**TypeScript**／署名＝**自前エンベロープ**／テスト＝**Vitest(Workers pool)**／パッケージ＝**pnpm**／CLI＝**軽量自作**。

---

## 3. フェーズ計画（実装の進め方）

| フェーズ | 内容 | 主担当 | 顧客/開発者の手作業 |
|---|---|---|---|
| **0（完了・✅）** | ローカル機構PoC（依存ゼロ・Node） | Claude Code | なし（`node test.mjs`） |
| **1** | Workers移植：承認Worker（`/lease`・`/config`）＋固定エージェントWorker＋WebCrypto署名、`wrangler dev`でローカル再テスト | Claude Code | `npm i -g wrangler`（任意） |
| **2** | 実デプロイ＋実ブレイン（Claude）＋チャネル（LINE/Discord）でE2E。**AI原価・オンボード工数を実測** | Claude Code（コード/スクリプト）＋開発者（鍵） | CF作成→`wrangler login`→Anthropicキー貼付→`wrangler deploy`（最小） |
| **後** | 機能拡充：D1/DO/Queues/Vectorize/KMS/多プロバイダBYOK/音声議事録/A2A 等 | Claude Code | 能力ごとにBYOK（必要分のみ） |

> セキュリティ3ゲート（KMS外出し・FIDO2・専用プロファイル＋時間差ゲート・16-10）は**顧客提供段階で実装**。PoC〜内部検証はローカル開発鍵で進める。
