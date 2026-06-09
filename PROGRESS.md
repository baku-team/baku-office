# PROGRESS — 計画・フェーズ・進捗管理

baku-office の実装トラッカー（生きた管理ファイル）。設計詳細は [03](03_multitenant-saas-architecture.md)、スタックは [05](05_implementation-stack.md)。
**更新ルール**：着手で `[ ]`→`[~]`、完了で `[x]`。各フェーズ頭の「状態」と末尾の「最終更新」を更新する。

凡例：`[ ]` 未着手 ／ `[~]` 進行中 ／ `[x]` 完了 ／ 🔒 本番ゲート（顧客提供前に必須）

---

## 🧭 現在地

- **2026-06：baku-office として再設計（正本＝[integrated_design_package_v1.0.md](integrated_design_package_v1.0.md)）**。位置づけ＝**「自社専用AIの相棒」をクライアントが丸ごと所有する「ポータブルコア＋パーツ」基盤**（会計・庶務はパーツの一例）。実装は `apps/host`・`apps/client`（Astro on Workers・自己ホスト型）。旧LINEエージェントは `worker/` に温存。
- **実装済み（基盤）**：申込/ライセンス/自動アクティベート、会計コア、マルチユーザー（招待・承認・ロール・PII暗号・共有承認）、ファイル/予定/議事録、Stripe（デモ可）、認証OAuth（dev併用）、LINEエージェント＋各AI機能（要約/音声/web検索/資料生成/任意API/スキル）、診断・Workers Paid案内、UI統一・レスポンシブ、自動マイグレーション、配布CI。実CFで一気通貫検証済み。
- **実装済み（2026-06 追加分）**：プラン改称 Free/Plus/Pro、高度なオプションPlusゲート、AIチャット（Plus・PDF/TXT/md/HTML/CSV出力）、AIエンジン選択(Gemini/Claude)＋カスタム指示、API使用量画面（数値/グラフ/枠アラート/従量上限）、AIによるスキル自動生成、ホストのクライアント詳細＋ステータス手動変更、申込専用Worker分離（apps/apply）、Googleドライブ連携（OAuth/メタ同期/検索/定期バックアップ）、ストレージ使用量可視化（D1/KV/R2/Drive・全プラン）、会員管理（全プラン）。
- **実装済み（2026-06-06〜07 追加分）**：
  - **ポータブルコア（Ports & Parts）**：能力Port(DB/Storage/AI/Agent/Identity)＋`ctx`注入。業務道具を `src/parts/` へ登録制移設。全Partを `ctx.db` 化し **Node+SQLite 適合性テスト**で実証（`apps/client/test/`・計24本）。AI は `ChatModel`（Gemini/Claude/**ローカルLLM**）に一本化、鍵保管を KvPort 分離、`detectProfile` で稼働構成可視化。**Profile C（オフライン＝ローカルLLM＋ローカル認証）成立**。設計書＝[baku-office_portable-core_architecture.md](baku-office_portable-core_architecture.md)。
  - **UIカスタマイズ3層**：テーマ(`ui_theme`)／ナビ(`nav_overrides`)／有効パーツ(`enabled_parts`)を管理画面から上書き＋`src/overrides/`（Slot注入/ファイル上書き）で画面差し替え。
  - **セキュリティ改修（レビュー指摘）**：署名relayアクティベート必須化、エージェント会員/ロール認可、PBKDF2＋HMAC Cookie、Stripe鮮度＋定数時間、申込レート制限、migrate限定無視＋診断。
  - **4画面UI再編＋AIアプリ開発＋Stripe接続（2026-06-07）**：クライアントナビを**ホーム/AI/アプリ/設定**の4項目に集約（業務画面は「アプリ」ランチャー起動、設定は集約ハブ）。**AIはセッション保存＋切替＋モデル選択**（Gemini/Claude/local・履歴継続）。ホームに**アプリ連携ウィジェット**（`Part.widgets`）。**AIアプリ開発**（`propose_app`→事前4確認①環境②権限③安全④コスト→公開申請→ホスト承認→**Ed25519署名配信**→クライアント署名検証取り込み）、外部レジストリ署名fetch、**ホスト中枢アプリ管理 `/apps`**（存在＋利用状況・未登録検知）。**test 権限**（全機能解放・rank99・ホスト管理画面から付与）。**Stripe接続部実装**（鍵投入で稼働・アカウント未準備でも起動）。**マイグレーション分割のインラインコメント不具合を修正**（`;`後コメントで全中断していた問題・PR#13）。
- **実装済み（2026-06-08 追加分）**：
  - **クライアントUI再編＋enterprise**：ホーム再設計・機能のアプリ移管・カスタムドメイン・設定整理・`enterprise` プラン追加（#16）。R2（高度モード）の紹介/登録案内を高度なオプションへ集約（#17/#18）。
  - **マルチエージェント（社内・Pro以上）**：オーケストレーション／並列／長時間ジョブ＋無料枠/Paid境界（#19）。
  - **A2A（他団体エージェント連携・Pro以上）**：ホスト中継＋署名＋相互同意＋公開アクション許可（#20）。**グループ対応**（1:1＋グループ＝個別呼び出し＋全員同報・公開アクションはグループ別／#21）。**公開アクションのノーコード管理＋公開状況の可視化**（#22）。宛先 `deploy_url` はホスト側で SSRF 検査（下記 2026-06-09）。
  - **ホスト主体アプリストア（マーケット）**：「マーケット」改称＋DL数／5段階評価／ランキング／プラン別DL（#23）。
  - **NonProfit プラン**：非営利・全機能無料・申込時選択・ホスト審査（承認で `entitlement=nonprofit`／#24）。
  - **オートパイロット（AIサーバー自治・CF/GitHub・Pro＋opt-in＋管理者）**：枠組み＋ポリシー＋限定ツール（#25）。トークン発行の自動化（**GitHub OAuth デバイスフロー**／CFアカウント自動検出／#26）、GitHub client_id をホスト集中配布（クライアント設定不要／#27）、`gh_merge_pr`（**CI成功時のみ squash マージ**／#28）、配布リポにCIチェックを同梱しマージ条件を自動充足（#29）。
- **実装済み（2026-06-09 追加分・本番反映済み #30）**：
  - **運用機能 S6〜S12**：S6 監査ログ（`host_audit`＋`recordAudit`/`listAudit`・`/audit` 閲覧＋ナビ・clients/registry/nonprofit の操作を記録）／S7 顧客削除の安全化（団体名タイプ確認＋関連レコードの明示カスケード削除）／S8 申込検証（orgName≤200・contactName≤100・email RFC簡易＋≤254）／S9 クライアント一覧の運用性（検索・状態/プランフィルタ・50件ページング・件数表示）／S10 DL二重計上是正（`app_downloads` を PK(app_id,license_id)＋upsert＝ユニーク導入数）／S11 NonProfit 降格（reject で `entitlement` を plan ベースへ戻す＋剥奪導線）／S12 オートパイロットのマージ面保護（`mergeable===true` 必須＋PR差分にコア領域を含むと拒否）。
  - **セキュリティ改修（追加堅牢化）**：`deploy_url` の **SSRF 検査**（`isSafeDeployUrl`＝https必須＋IP/内部ホスト名拒否。check/token/activate-by-email 保存と A2A 中継宛先に適用）／本番（`ENV≠development`）は **`ADMIN_KEY` 必須で fail-closed**＋dev管理者ログインは `ENV=development` かつ Google未設定時のみ／アプリ**キルスイッチ**（blocked アプリ id を統合チェックで配布し導入済みクライアントから削除＝`revokedApps`）／`registry/submit` を生 licenseId 受理から**署名ライセンストークン認証**へ。
  - 検証：host typecheck 13 / client 14（baseline維持・増分0）・client test 35/35・host/client/apply build green。host D1 migration 0010/0011 適用済み。本番3 Worker（host/apply/client）反映・スモーク正常。
- **次の一手**：本番クレデンシャル投入（Google/LINE/Discord/Stripe/Gemini/Claude）、`PUBLISH_TOKEN`(配布CI)、**セキュリティ3ゲート（KMS署名・FIDO2・admin JIT＝引き続き保留）**、2社目の実テナントE2E、法務確定。残：gemini/claude の ChatModel ライブ検証、他Part画面の `ctx` 完全移行。
- **方針**：共通更新はupstream/CIで全顧客へ、カスタムはデータ駆動で個別（[ARCHITECTURE.md](ARCHITECTURE.md)）。バックアップは顧客自己責任。

### 📋 今後の追加予定（バックログ）

- [x] ~~**HP/LP 公開機構（Pro）**~~（実装済み）：サブパス公開（`/site`・`/lp/<slug>`）、`/settings/site` 管理、公開会員申込フォーム→会員管理連動。
  - 残：**Stripe 本番連携**（カード支払で会員の 追加/変更/退会削除）は webhook 骨組みのみ＝本番キー投入時に有効化。希望者のみ都度の作り込み。
- [x] ~~**Notion / Googleドライブ資料インポート**~~（実装済み）：既定メタのみ、インポート前に **容量シミュレーション＋費用試算＋対策提示**、**R2有効時のみ**実ファイルをR2取り込み（`/import`）。
  - 残：Notion 添付の実体取り込み、差分/再同期は将来。

- [x] ~~Googleドライブ連携~~（実装済み：OAuth/メタ同期/検索/定期バックアップ）
- [x] ~~プラン名称変更 Free/Plus/Pro~~（実装済み・内部キーも統一）
- [x] ~~AIチャット画面（Plus）~~ ／ ~~スキル自動反映~~ ／ ~~API使用量画面~~ ／ ~~高度なオプションPlusゲート~~（実装済み）
- [x] ~~ホスト：申込専用Worker分離~~ ／ ~~クライアント詳細＋ステータス手動変更~~（実装済み）
- [x] ~~会員管理（全プラン）~~ ／ ~~ストレージ使用量可視化~~（実装済み）

> 以下「実装フェーズ／フェーズ0〜2」等は**旧LINEエージェント（worker/）期の履歴**。baku-office 再設計の詳細は文末の 2026-06-04/05 セクション参照。

---

## 実装フェーズ（ビルド）

### フェーズ0：ローカル機構PoC — 状態：`[x]` 完了（2026-06-02）
- [x] Ed25519 署名/検証（`poc/lib/crypto.mjs`）
- [x] 承認サーバ相当：署名済みリース＋config（`poc/lib/approval.mjs`）
- [x] 固定インタープリタ：config駆動・ライセンス判定（`poc/lib/agent.mjs`）
- [x] 機能テスト 9/9（config-only挙動／無効→機能停止・データ無停止／署名検証）

### フェーズ1：Workers移植（ローカル） — 状態：`[x]` 完了（暗号移植✅／#2 gate クローズ✅・`poc-workers/`）
- [x] プロジェクト雛形（TS＋Wrangler＋tsconfig）
- [x] 暗号を WebCrypto `subtle`（Ed25519）へ移植（Node22＋Workers共通）
- [x] 承認Worker：`POST /lease`／`GET /config?ver=`／固定エージェント `/agent`
- [x] **Node機能テスト 9/9**（`node --experimental-strip-types test/run.ts`）※Nodeはeval可＝#2十分性は未証明
- [x] 静的検査：`src/` に eval/new Function/動的import **検出ゼロ**
- [x] 🔒 **#2最終確認＝workerd で実行**（`@cloudflare/vitest-pool-workers`・`test/workerd.spec.ts`）＝**3スイート/9アサーション PASS**＋runtimeでeval不在を担保
- [~] `wrangler dev`＋`test/http.sh` でHTTP経路確認（任意・ルーティングのみ）

#### 🎯 #2 クローズ合格条件（チェックリスト）— ✅ 全て充足・**#2クローズ（2026-06-03）**
- [x] workerd 実ランタイム上で**9アサーション全て PASS**（vitest-pool-workers）
- [x] インタープリタ経路に **eval/new Function/動的import が一切ない**（静的=✅／runtime=workerd成立=✅）
- [x] config(v1→v2)差し替えで**コード無変更のまま**挙動変化を workerd 上で確認
- [x] 無ライセンス→機能停止・データ無停止／更新で再開 を workerd 上で確認
- [x] 改ざんconfig・偽造リースを署名検証で拒否 を workerd 上で確認
- ⚠️ 環境：workerd はスペース/`~`含むパスで失敗 → iCloud配下は `/tmp` 等にコピーして実行（コード同一）
→ **#2を技術的にクローズ。フェーズ2へ。**

### フェーズ2：実デプロイ＋実ブレイン＋チャネル＋実測 — 状態：`[x]` 主要達成（**E2E＋履歴＋実測＋config/ライセンス**・2026-06-03・残=パイロット）・`worker/`
> 個人アカウントで：LINE Webhook→署名検証→ライセンス判定→署名config適用→Claude(Sonnet)→返信。事業の核（#2機構）が実環境で稼働。
- [x] 最小Worker実装（`worker/src/index.ts`）：型チェック✅
- [x] メインブレイン（Claude `messages` API・BYOK・`claude-sonnet-4-6`）を `chat` に接続（fetchベース）
- [x] チャネル：LINE Webhook（**署名検証 HMAC-SHA256 を実証**／5秒ACK＝`waitUntil`／Reply API）
- [x] 🧑 実デプロイ（`wrangler@4`・URL=`cf-line-agent-e2e.fragrant-sun-78f3.workers.dev`）＋`secret put`×3＋LINE Webhook設定
- [x] **E2E：LINEで会話→Claude応答を確認（本番workerdで署名検証401／health200も実証）**
- [x] 📊 実測：**1往復≈0.6円（Sonnet・履歴あり）／レイテンシ平均4秒（out律速）／COGS≒0（無料枠）**。AI実費はBYOKで顧客負担＝粗利前提維持。
- [x] 会話履歴（マルチターン・直近数往復＋古い分はローリング要約）→ 実機で文脈保持を確認。**2026-06-04：生履歴をKV→D1 `history`テーブルへ移行**（要約は引き続きKV `sum:{userId}`）。
- [x] **config駆動＋ライセンスを実環境接続（同一Worker内蔵）**：署名config（人格v1丁寧/v2関西弁を差替）＋paid_through切れ停止/更新再開を**実CF・実LINEで確認**。**workerd上でEd25519署名/JWK importも成立**（#2の本番E2E達成）。
- [x] **モデル自動切替**（Haiku軽量ルーター→simple=Haiku/normal=Sonnet/hard=Opus）を実機確認。応答末尾に`(model/検索)`付記。
- [x] **Web検索**（Anthropic公式 `web_search_20250305`・GA・server tool・BYOK課金）をtool接続・実機確認。
- [ ] 1〜2団体パイロット
- 📝 学び：wrangler3.114は`/memberships`認証エラー→**v4必須**。`secret delete`の引数は値でなく名前。露出トークンは再発行。ローカル`wrangler dev`はmacのworkerdソケットバグで不可→**実CFでテスト**。Opus`claude-opus-4-8`/Haiku`claude-haiku-4-5-20251001`実機動作。Web検索はserver toolで1往復完結。
- ⚠️ 本番前の宿題：開発署名鍵がWorker内（`SIGNING_JWK` secret）→ **KMS署名へ**。`/admin`は`ADMIN_KEY`のみ保護→**承認サーバ分離＋JIT**。

### フェーズ後：機能拡充 — 状態：`[ ]`（必要分のみBYOK）
- [x] **D1/R2 データ層＋tool use**（2026-06-03）：D1=メモ等の登録／R2=画像・書類の保存。会話の文脈から `save_note`/`list_notes`/`get_media` ツールでClaudeが自動操作（固定コマンド不要）。画像はLINE画像表示・書類はDLリンク・一覧は#番号付き。R2は**公開バケットURL方式**（カード障壁の簡易回避＝[[cf-kit-r2-card-barrier]]、本番は署名URL要）。
- [ ] client push（heartbeat/attest・既定1h・17-9b）＋顧客起点の巻き戻し
- [ ] 段階配信（リング・Ring0テスト先行）＋クライアント発pull自己更新（17-9）
- [~] 能力レジストリ（5-2b）：**builtin/skill(=Claude Agent Skills)/api/plugin の4種別**＋オーケストレーション案内を実装。各能力の実接続は web_search のみ済（Agent Skills/画像生成/プラグイン等は案内のみ＝次段で実接続）。
- [ ] 音声議事録（transcribe=Gemini/Deepgram＋chat要約・オプトイン）
- [x] **メモCRUD＋リマインダー**（2026-06-03）：削除/検索/完了（D1）＋時刻リマインダー（**Cron毎分巡回→LINE Push**）。会話文脈でツール自動実行。
- [x] **セットアップ自動化**：`setup.sh`（KV/D1/R2作成→ID埋め込み→スキーマ→secret→deploy→Webhook設定）／`SETUP.md`（全手順・運用・トラブル）／`wrangler.toml.example`。
- [x] **資料生成（Agent Skills）**（2026-06-03）：`make_document` で pptx/docx/pdf/xlsx を code execution＋skills で生成→Files API→R2→DLリンク（beta・コンテナ課金）。
- [x] **トークン節約3手法**（2026-06-03）：①プロンプトキャッシュ（system＋tools・cache_read計測）②会話履歴の自動要約（Haiku圧縮・16往復超で発動）③簡易RAG（knowledge外部保持＋検索でヒット箇所だけ参照）。
- [x] **画像OCR（Vision）＋記憶の自律管理**（2026-06-03）：画像送信時に文書/写真を自動判定→**文書(領収書等)は本文抽出してknowledgeへ**（検索可）／写真は保存のみ。記憶はプロンプトで自律管理（重要情報を明示指示なしで記録・参照）。
- [x] **文書メタ検索**（2026-06-03）：Visionで**分類・文書日付・金額**を抽出してnotesに構造化保存。`query_documents`で**分類×期間**の絞り込み（「6月の領収書まとめて」→該当一覧→Claudeが集計）。日付は文書日付優先・無ければ保存日。
- [x] **組織ナレッジ（共有スコープ）**（2026-06-03）：1公式アカウント＝1組織。データに **personal/shared** スコープ。「共有して」or エージェントが「共有しますか？」と確認→`scope='shared'`保存／既存は `share_item`。メモ・知識・文書・画像・OCRすべて**個人＋共有を参照**（共有は🔗表示）。画像OCRは source_note_id で共有連動。
- [x] **生成物の統一設計**（2026-06-03）：議事録・要約・レポート等のテキスト成果物を `save_record`（kind=record・category/日付/scope）で保存。生成資料(make_document)も doc_date付与。**メモ・画像・文書・記録すべて同一設計**（一覧・分類×期間検索query_documents・共有share_item・呼び出しget_media）に統一。
- [x] **音声入力＋議事録（Gemini）**（2026-06-03・実機確認）：LINE音声(m4a)→Gemini 2.5 Flashで文字起こし（話者分離）→発話として処理。会議録音は議事録化(save_record)を提案。`GEMINI_API_KEY`(BYOK・任意)。inline 18MB上限・長尺は次段(Files API)。
- [x] **ファイル取り込み（遅延参照・無料枠対応）**（2026-06-03）：**取り込み時はFiles APIにupload＋file_id保存だけ**（軽量・waitUntil制限回避）。質問時に `read_file` で document参照して回答（PDF/テキスト）。Office内容参照は要PDF化。
  - ⚠️ **教訓**：取り込み時の重い事前抽出（PDF抽出/code execution）は **Workers無料枠の `waitUntil` 時間制限で中断**（tail警告で確定）。AI重処理は遅延化 or Workers Paid が必要。[[cf-kit-push-policy]] と同じ「無料枠の制約」系課題。
- [x] **取り込みUX＋キャッシュ＋毎回検索**（2026-06-03）：軽量(〜40秒)=完了reply／重量=「アップロード中・確認を」reply（Promise.race＋ctx.waitUntil継続）。質問時は毎回関連資料を検索（プロンプト必須化）。read_fileは初回のみdocument参照で**要約をknowledgeにキャッシュ**→以降は要約で軽く回答（再読込の負荷軽減）。
- [x] **人材ディレクトリ**（2026-06-03）：`profiles`テーブルにメンバーの経歴・スキル・人脈を登録（`save_profile`・owner毎に追記）。`get_profile`（個人）／`search_people`（横断・LLMマッチング：「これができる人いる？」「△△の人脈を持つ人は？」「◯◯さんのスキルでこれ可能？」）。履歴書PDF→read_file→save_profileも可。組織共有前提（全友だち閲覧）。
- [x] **取り込み状態フラグ＋進捗確認＋エラー処理**（2026-06-03）：`notes.status`（uploading/done/error）。取り込み時に即uploading記録→成功/失敗で更新。`upload_status`ツールで『取り込めた？』に状況回答。一覧に⏳取込中/❌失敗表示。reply3分岐（✅完了/❌失敗/📥中）。タイムアウト15秒。read_fileは取込中/失敗を弾く。
- [x] **大PDF分割要約（Cronジョブ・無料枠で完遂）**（2026-06-03）：`summary_jobs`で Gemini File API upload（raw・base64なし）→ページ範囲を**Cron毎分1ステップ**で要約→部分結合→完了で knowledge キャッシュ。各回が軽く無料枠の `waitUntil` 制限内に収まり、大PDFも数分で完遂。read_fileはジョブ作成＋進捗（○/△ページ）表示。
- [x] **取り込み時に自動要約ジョブ起動**（2026-06-03）：PDF/テキストはアップロード時に `summary_jobs` を自動作成→Cronがバックグラウンドで抽出。聞かれる前に要約済みになる。取り込み処理はAnthropic upload廃止で軽量化（R2＋DBのみ→「✅取り込み」replyが確実）。
- [x] **無料スタック化（Gemini一本可）**（2026-06-03）：Step1=ルーターをGemini化。Step2=`runAgentGemini`でGemini function callingのtool useループ実装→**simple/Claude無し=Gemini（全ツール動作）／normal以上=Claude**。`GEMINI_FUNCTIONS`でツール変換。応答末尾にprovider/無料枠表示。**APIはクレカ不要のGemini無料枠で全機能可能**に（残：R2のクレカ回避=D1+KV）。[[cf-kit-free-stack]]
- [x] **機微モード（cheap/secure）＋確認フロー**（2026-06-04）：処理方針をユーザーが選択（`mode:{userId}`）。**cheap=安さ優先（Gemini無料・学習あり）／secure=機微・精度優先（Claude・学習なし・課金）**。既定はcheap。「精度優先」「安さ優先」で随時切替。cheap時に機微キーワードを検知すると送信前に確認（`looksSensitive`/`askSensitive`／「今後は確認しない」で抑制）。抽出エンジンも連動（`engineFor`：secure=claude/cheap=gemini/鍵無=none）。[[cf-kit-privacy-mode]]
- [x] **会話履歴のD1移行**（2026-06-04）：生履歴をKVからD1 `history`テーブル（`migrate_history.sql`）へ。`recentHistory`/`appendHistory`/`maybeFoldHistory`。要約はKV `sum:`に残置。
- [x] **Google Drive大容量連携**（2026-06-04）：25MB超など大容量は `GET /oauth/start`→`/oauth/callback` でDrive連携（refresh_tokenをKV保管）。メディア本体ストレージは**MEDIA=KV（カード不要・無料）を既定**、R2バインディング（`MEDIA_R2`）があればPaid向けに優先。
- [ ] ユーザー定義ツール／人格の拡張／本格RAG（Vectorize）
- [ ] 上限カウンタ（D1→DO）／監視メタデータ／バックアップ
- [ ] A2A（グループ＝承認アカウントのみ・14章）

#### 🛡 システムレビュー対応（2026-06-04）
- [x] **#1 Webhook冪等化**：`webhookEventId` を KV `seen:{id}`（24h TTL）で check-then-set し、LINE再送（タイムアウト/5xx）による**AI二重課金・二重返信・二重保存を防止**（[index.ts] fetchループ）。
- [x] **#2 署名のKMS分離耐性**：`crypto.ts` のエンベロープを **`{ body, sig }`（署名した実バイト列=canonical JSONを搬送し、そのbodyを検証）** に変更。再stringify非依存でキー順・数値・空白差・別言語実装でも一致、可鍛性も封鎖。旧 `{ payload, sig }` は移行期の後方互換で検証可（再発行で消える）。**検証鍵を署名鍵から分離**：`verifyJwkOf`（`VERIFY_PUBLIC_JWK` 優先・無ければ開発時のみ `SIGNING_JWK` の公開部分）。ホスト=署名/クライアント=公開鍵で検証のみ、の前提を崩さず split-ready 化。
- [x] **#3 Opus価格の是正**：[02_cloud-agent.md] を Opus 4.8 = **$5/$25（Sonnet比 約1.7倍）** に修正（旧「$15/$75・5倍」を撤去）。コードの `PRICE` は元から正。
- [x] **#4 大容量ファイルのストリーミング**：Drive経由の大ファイルを全バッファせず、`driveGetStream`→`geminiUploadResumable`（Gemini Files API resumable・`duplex:half`）で**ストリーム転送**。KV経路（25MB上限内）は従来のバッファ簡易upload。`geminiUploadFromRef` が ref で振り分け。
- 補足：いずれも本番ゲート #4（鍵分離）と整合。秘密鍵=CP/KMS・クライアントは公開鍵のみ、の最終形へ移る土台が入った。

#### 🔐 クライアント認証ゲート（fail-closed・2026-06-04）
- [x] **動作には当社承認の通過を必須化**：`authorize()` を handleEvent 冒頭に新設。**有効な署名付き lease（契約）＋ 署名付き config（人格/機能）の両方**が揃わなければ動かない。
  - 旧挙動（fail-open）を反転：lease/config が**未発行・改ざん・鍵不一致**なら null 扱いで停止（`currentLease`/`currentConfig` は throw せず null）。期限切れは明示メッセージ、改ざんも**無言落ちではなくクリーンに「未承認」応答**。
  - config も認証対象に（既定v1フォールバックを撤廃。`currentConfig` は `ConfigPayload | null`）。検証済み config を runConversation/processPending へスレッド渡し。
  - データは保持＝人質にしない（機能だけ停止・承認/更新で自動再開）。
- [x] **開発バイパス**：`DEV_USER_IDS`（カンマ区切りのLINE userId）に載るアカウントだけ認証をスキップ（configは当社発行があれば使用・無ければ既定v1）。**本番は空＝全員ゲート対象**。仕組みは厳格なまま、開発アカウントだけ動かせる。
  - setup-client.sh で任意登録。秘密鍵の有無に依存しない明示的な許可リスト方式（事故りにくい）。

#### 🏗 ホスト/クライアント 2Worker分離デプロイ（2026-06-04）
- [x] **実デプロイを2Workerに分離（稼働確認済み 2026-06-04）**：`cf-line-agent-host`（署名・配信専用）と `cf-line-agent-e2e`（クライアント＝LINE/会話/データ）。両者GET / =200、クライアントcron=ok、config/lease配信=ok:true、クライアントから `SIGNING_JWK`/`ADMIN_KEY` 削除済み（公開鍵のみ保持）。
- [x] **配信は push 方式**（共有KVを使わずデータ分離を維持）：ホスト `/admin` が lease/config に署名→クライアント `/provision` へ push。クライアントは**署名検証してから自分のKVへ保存**（偽造は保存されない・`PROVISION_KEY` で一次フィルタ）。
  - ⚠️ **配信路は Service Binding 必須**：同一 workers.dev サブドメイン上の Worker 間 直fetch は CF がループ防止で遮断（**error 1042 / 404**）。`deliver()` は ①テナント台帳URL ②`CLIENT`(Service Binding) ③`CLIENT_BASE_URL`(別アカウント・カスタムドメイン) ④ローカルKV(単一Worker/dev) の順。ホストtomlに `[[services]] binding=CLIENT service=cf-line-agent-e2e`。

#### 🏢 多テナント化＋他アカウント対応（2026-06-04・稼働確認）
- [x] **多テナント（多数顧客を1ホストで配信）**：ホストに `TENANTS` KV 台帳（`tenant:{id}`→`{url, provisionKey}`）。admin に `/admin/tenant`(登録)・`/admin/tenants`(一覧)・`/admin/pubkey`(公開検証鍵取得) を追加。`/admin/lease|config?tenant=` でテナント別に署名→台帳URLへ配信。`deliver(tenant)` がテナント宛URLを選択（self は従来の Service Binding/既定URL/ローカル）。
  - ライブ確認：`pubkey`=200（公開鍵返却）、`tenant`登録=ok、`tenants`一覧=ok、`self lease`=ok:true（非退行）。host に `TENANTS` KV をバインドしてデプロイ済み。
- [x] **テナント横流し防止**：クライアントに `TENANT_ID` を持たせると `authorize` が `lease.tenant === TENANT_ID` を必須化（他テナント宛leaseを拒否）。
- [x] **他アカウント運用**：`setup-client.sh` に `VERIFY_PUBLIC_JWK`/`PROVISION_KEY`/`TENANT_ID` 入力を追加（顧客が自分のアカウントで登録）。`setup-tenant.sh`（ホスト側オンボード：台帳登録＋初期配信＋顧客へ渡す3値を出力）追加。`admin.mjs` に tenant/tenants/pubkey コマンド追加。
  - ⚠️ 別アカウントの配信先は **カスタムドメイン推奨**（同一アカウントの workers.dev は 1042 で不可。別アカウントの workers.dev は別ゾーンで可だがドメイン推奨）。
- 残（**課題として保留・今回は着手しない**）：**KMS署名**（署名鍵を平文Workerから外しKMS/HSMの「署名のみ」へ。必要ならECDSA P-256移行）・**FIDO2**（署名/デプロイ経路の人間アクセスをハードウェアキー必須に）・**admin JIT**（/adminをCloudflare Access＋短命セッション＋高リスク操作の時間差ゲート）。着手順の目安は ①/admin の Access化 ②KMS移設 ③監査+時間差。`SIGNING_JWK`/`ADMIN_KEY` は現状ホストの素のWorker Secret。
- バックアップは**クライアント自己責任**へ方針変更済み（上記🔒ゲート参照・[[cf-kit-backup-policy]]）。多テナントの実E2Eは2社目の実クライアント（別ドメイン/別アカウント）で要検証。CF規約照会は規模拡大前に。
- [x] **鍵・データの所在**：ホスト=`SIGNING_JWK`(秘密)＋`ADMIN_KEY`＋`PROVISION_KEY`、顧客データ無し。クライアント=`VERIFY_PUBLIC_JWK`(公開)＋`PROVISION_KEY`＋LINE/BYOK＋自分のKV/D1。クライアントに秘密署名鍵は無い。
- [x] **設定/スクリプト**：`wrangler.host.toml.example` 追加、`setup-host.sh` はホストWorkerを別途deploy→鍵発行→クライアントへ検証鍵/配信鍵を配布→初期lease/config配信、`setup-client.sh` は鍵を扱わず顧客Workerのみ構築。
- ⚠️ 既存単一Workerからの切替：クライアント側 `VERIFY_PUBLIC_JWK` を新鍵に設定→旧lease/configは一旦失効→直後にホストが新鍵で署名・配信して回復（数秒の窓・dev垢は影響なし）。本番は admin/JIT・KMS化が引き続き宿題。

#### ⚙️ 運用ノート（D1マイグレーション）
- migration runner は無く、`migrate_*.sql` は **remote D1 へ手動適用**（`wrangler d1 execute cf-line-agent-db --remote --file <f>`）。スキーマ変更を含むdeploy時は忘れず適用する。
- ⚠️ **2026-06-04 障害と復旧**：`migrate_summary_engine.sql`（`summary_jobs.engine`）と `migrate_history.sql`（`history`テーブル）が本番D1に未適用で、**Cronが毎分例外／テキスト会話も `recentHistory` が try外でthrow→無言で全停止**。両migrationをremote適用して復旧。障害切り分けは `wrangler tail` の `D1_ERROR: no such table/column` が決め手。[[cf-kit-d1-migrations]]

---

## 🔒 本番ゲート（顧客提供前に必須・11-1）

- [x] **#2 配信機構PoC**：config-only挙動／無ライセンス→機能停止・データ無停止（ローカル✅＋**実CF・実LINE E2E✅ 2026-06-03**）
- [ ] **#4 セキュリティ3ゲート**（16-10）
  - [ ] 署名鍵を CF外KMS or Secrets Store（素のWorker Secrets不可）
  - [ ] 全アカウントに FIDO2 ハードウェアキー
  - [ ] 鍵操作の専用プロファイル＋時間差ゲート
- [—] **バックアップ＝クライアント自己責任に方針変更（2026-06-04）**：データはクライアント側保有のため当社一括バックアップはしない（「データを預からない」前提と整合）。顧客が自分のデータを退避する**バックアップ用ツールは将来提供予定（未実装）**。[[cf-kit-backup-policy]]
- [ ] **#3 CF規約**（規模トリガー・ハードゲートにしない）：拡大前にCFへ早期照会／Agency・Tenant Platform 申請（18-1）

---

## 実行順序（4フェーズ・11-2）と現在の選択

> 第三者レビューは「セキュリティ3ゲート→PoC→法務→有料転換」を提案。**当社判断＝まずPoC実測を優先**し、セキュリティ3ゲートは顧客提供段階で実装（PoC/内部検証はローカル開発鍵）。

- [~] **PoC＋最小ループ＋パイロット**（フェーズ0完了→1/2へ）
- [ ] **セキュリティ3ゲート**（顧客提供前・上記🔒）
- [ ] **法務の確定**（動くものができてから：契約条項・個人/越境・CF照会・開示文書はPoC結果ベース）
- [ ] **有料転換＋外部レビュー＋復旧訓練**

---

## 主要な確定事項（決定ログ）

- 運用形態：顧客所有アカウント＋当社は承認/config配信のみ＋本文非中継＋常設アクセスゼロ＋JIT（17章）
- enforcement＝リース側（exp＋`paid_through`＋署名）。自己修復は顧客起点が既定／自動はopt-in（17-9b）
- 提供スコープ：**BYOKのみ**（AI込み/当社ホスト型は将来・非提供）。メインブレイン必須＋能力BYOK（5-2b）
- アカウント作成は顧客自身（代理不可）。当社は案内・検証・自動配線（17-6b）
- 法務・各社規約・MSP該当は**顧問弁護士確認＋CF照会が前提**（18章・メモリ記録済）

---

最終更新：2026-06-09（#16〜#30 を反映。マルチエージェント／A2A（1:1・グループ・公開アクション）／マーケット（DL・評価・ランキング）／NonProfit プラン／オートパイロット（GitHub OAuth デバイスフロー・CI squash マージ）を実装。運用機能 S6〜S12＋セキュリティ追加堅牢化（SSRF 検査／ADMIN_KEY fail-closed＋dev login 封鎖／アプリ キルスイッチ／submit 署名トークン認証）を本番3 Worker へ反映。KMS署名/FIDO2/admin JIT は引き続き保留）
