# baku-office 操作フロー（ホスト側／クライアント側）

本書は実装済みシステムの**操作手順**をまとめたもの。設計の根拠は `integrated_design_package_v1.0.md`、技術構成は `ARCHITECTURE.md` を参照。

- **ホスト（当社・合同会社貘）**：申込受付・ライセンス発行・配信・通知・課金。`baku-office-portal`。
- **クライアント（利用団体）**：自分のCloudflareでアプリを自己ホストし、会計・庶務に利用。`baku-office-app`。
- 表記：🟢=通常運用 ／ 🧪=dev（API未設定時の代替動作）。

> **現在の環境（2026-06-09 時点）**：開発・運用は **baku-llc の Cloudflare アカウント（`*.baku-027.workers.dev`）のみ**。稼働 Worker は host=`baku-office-portal`／client=`baku-office-app`（env.production）／apply=`baku-office-apply`／scheduler=`baku-office-scheduler`。client wrangler の top-level（コメント上「amber-links 動作確認」）は現在不使用＝実ターゲットは **env.production**。本書で「当社アカウントへ deploy」とあるのは baku-llc env.production（`wrangler deploy --env production`）を指す。**外部顧客向けの本番提供はまだ開始しておらず（開発段階）**、本書のオンボーディング/解約フローは設計・検証段階の手順。

---

## 全体の流れ（俯瞰）

```
[ホスト] 申込受付 → ライセンス発行 → 個別Deployリンク送付
                                   │
[クライアント] Deployボタンで自分のCFへ展開 → 初回起動で自動アクティベート
                                   │
        無料(Free)で利用開始 → 連携設定(Gemini/LINE/Claude) → 必要ならPlus/Proへ課金
                                   │
        4画面で運用：ホーム / AI(相棒＋アプリ開発) / アプリ(導入・開発) / 設定
[ホスト] クライアント管理で稼働監視 / お知らせ配信 / 入金確認(課金) / アプリ承認
```

---

## クライアントの3つの流れ（明確化）

### 流れ① 申込 → 開始（オンボーディング）

| # | 主体 | 操作 |
| --- | --- | --- |
| 1 | クライアント | `/apply`（申込専用Worker）で団体名・連絡先を入力→送信（**プラン選択はなし＝全員 Free で開始**・IPレート制限＋入力検証＝団体名≤200／担当者名≤100／メール形式・≤254）。 |
| 2 | ホスト（自動） | customers/licenses を作成（**`plan=free`・`status=active`**・`deploy_code`=nonce）。GitHub連携時は**団体ごとの throwaway 公開リポ**を生成し `report.json`（licenseId/deployCode/host URL）を焼き込み。失敗時は共有リポにフォールバック。 |
| 3 | ホスト（自動） | **Deploy to Cloudflare リンク**（`deploy.workers.cloudflare.com/?url=<repo>`）を返す。 |
| 4 | クライアント | Deployボタンで**自分のCFアカウント**へ展開（D1/KV/Worker は顧客保有）。以後 push で自動再ビルド。 |
| 5 | クライアント | 初回起動でライセンス未保持を検知→当社アクティベート画面へ。**申込時と同じGoogleアカウント**でログイン。 |
| 6 | ホスト⇄クライアント（自動） | ホストが Ed25519 **署名relay**（`{sub,email,name,exp}`）を返却→クライアントが公開鍵で検証→`activate-by-email` が署名を**再検証**しライセンストークン発行→KV保存＋`deploy_url`記録。**認証キーの手入力は不要**。 |
| 7 | クライアント | 初回ログイン者＝**組織最上位管理者**として束縛。会計/名簿/ファイル等を **Free で利用開始**。連携設定で Gemini/LINE/Claude キーを登録。 |
| 8 | クライアント | **アップグレードは導入後に管理画面で**：`/billing` から Plus/Pro を選び Stripe Checkout。カード=即時昇格、振込/コンビニ=入金確認(Webhook署名検証)で昇格。入金前は free 相当（プロビジョナル）。 |

→ 詳細手順は [A. ホスト側](#a-ホスト側の操作)／[B. クライアント側](#b-クライアント側の操作)、配備の内部仕様は [docs/spec/baku-office_deploy-update_spec.md](docs/spec/baku-office_deploy-update_spec.md)。

### 流れ② UI変更（共通ベース＋上書き・3層）

| 層 | 変えるもの | 誰が・いつ | どこで |
| --- | --- | --- | --- |
| 第1層 テーマ | ブランド名・ロゴ・配色 | 管理者・実行時（コード不要） | 高度なオプション →「見た目（テーマ）」（`ui_theme`） |
| 第2層 構成 | ナビ表示/ラベル/並び・**有効パーツ** | 管理者・実行時（コード不要） | 高度なオプション →「ナビ表示」「有効パーツ」（`nav_overrides`/`enabled_parts`）。無効パーツは画面・道具ごと消える |
| 第3層 画面・部品 | 画面の差し替え・部分注入 | 開発/納品・配布時 | 配布バンドルに `src/overrides/<slot>.astro`（部分＝Slot注入）／`src/pages/<page>.astro`（全面置換）を同梱→デプロイ |

- 判断指針：まず**第1・2層（管理画面の設定）**で足りるか → 足りなければ**第3層（追加ファイル）**。ベース（共通画面）は未編集のままなので上流更新を取り込んでも上書きは保たれる。

### 流れ③ パーツ（＝再利用可能アプリ）の開発・納品

> **パーツ＝アプリ**。`Part` は `id`/`name`/`version` を持つ再利用可能な業務アプリで、次の3性質を満たす：
> - **再利用**：特定団体専用ではなく、**複数団体で共有**できる（各団体は「有効パーツ」で ON/OFF）。
> - **更新の波及**：アプリ更新（`version` 上げ）をコア正本に入れると、**CI配布→導入している全団体に波及**（upstream同期＋自動マイグレーション）。
> - **派生**：既存アプリをコピーし `id` を変えて改変＝**新アプリ**（`derivedFrom` に派生元を記録）。元アプリの更新とは独立。

**AIで作る（チャット主導・推奨の入口）** — クライアント管理者が「AI」画面で「〜するアプリを作って」と依頼する流れ。

1. AIが**企画・仕様**を作成し、続けて**事前4確認①環境②権限③安全④コスト**を実行（`propose_app` 道具）。問題なければ草案（`app_drafts`・要求権限つき）を生成。
2. 管理者が「アプリ」画面で要求権限と4確認結果（`gate_status`：planning/ready/blocked）をレビュー。
3. `ready` なら**公開申請**（`/api/registry/submit`）→ ホストが `/apps` で承認 → **Ed25519署名つきで配信** → 他団体は署名検証して取り込み（再デプロイ不要）。
4. 破壊的操作・認証バイパス等は拒絶。アプリは宣言した権限（`db:read`/`db:write`/… §15-2）の範囲のみで動く。

**コードで作る（開発者）**

1. **設計**：機能を Part 単位に分解（道具 `agentTools`／ナビ `menu`／データ操作）。コアは編集しない。
2. **実装**：`src/parts/<id>.ts` に `Part` を定義。データは必ず **`ctx.db`（SqlStore）経由**＝CF/Node 両対応。認可は `requiredRole`。画面が要れば `src/pages/<id>.astro`。
3. **登録**：`src/parts/index.ts` に `registerPart(<id>Part)` を**1行追加**（コア未編集）。
4. **スキーマ**：新テーブルは `apps/client/migrations/NNNN_*.sql` を追記（前進・追加のみ・冪等／初回リクエストで自動適用）。id は衝突回避で命名。
5. **テスト**：`apps/client/test/<id>.contract.test.ts` に **Node+SQLite 契約テスト**を追加（道具/データが CF非依存で動くこと）。`npm -w apps/client run test`。

**納品（配布）**

- **標準（全顧客共通）**：コア正本（`apps/client`）にマージ → CI が配布バンドルを公開 → 顧客は upstream 同期/再Deploy で受領 → **自動マイグレーション**。各顧客は「有効パーツ」で ON/OFF。
- **個別（特定団体のみ）**：当該団体の配布バンドル（throwaway リポ）にそのパーツ＋必要画面/override を**追加同梱**して納品。コア本体は触らないため共通更新と両立。
- **検収**：`npm -w apps/client run typecheck` / `test` / `build` を通す。プラン・ロールゲートと有効パーツ設定の反映を確認。

→ 開発の設計指針は [ARCHITECTURE.md](ARCHITECTURE.md)／[docs/spec/baku-office_portable-core_architecture.md](docs/spec/baku-office_portable-core_architecture.md)。

---

## A. ホスト側の操作

### A-0. 初期セットアップ（最初の一度）
1. ホストポータルをデプロイ：`apps/host` を当社CFアカウントへ。
   - `npm -w apps/host run deploy`（`astro build && wrangler deploy`）。
2. シークレット登録（`wrangler secret put -c apps/host/wrangler.jsonc`）：
   - `SIGNING_JWK`（ライセンス署名鍵・Ed25519。将来KMS）
   - `RELEASE_PUBLIC_JWK`（リリース署名鍵の**公開**部分）／CI側に `RELEASE_SIGNING_JWK`（**秘密**鍵）。**§3-2：クライアントの検証鍵は配布バンドル同梱の `apps/client/deploy/release-pubkey.json` にピン留め**しており、ホストの `/api/release/pubkey` には依存しない（ホストから鍵を取らない＝TOFU排除）。
   - `ADMIN_KEY`（管理者セッション署名鍵）。**本番（`ENV≠development`）は必須＝未設定なら fail-closed で管理者ログイン不可**。`ENV=development` のときのみ dev フォールバック鍵を許可。
   - `ENV`（任意）：`development` を設定した環境でのみ dev 管理者ログインと鍵フォールバックが有効。本番は未設定＝厳格側（設定漏れでも安全）。
   - 🟢 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`（スタッフGoogleログイン）
   - 🟢 `HOST_ADMIN_EMAILS`（管理者のGoogleメール・カンマ区切り）
   - 🟢 課金：`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_Y`（Plus用）/ `STRIPE_PRICE_Z`（Pro用）。Stripe接続部は実装済みで、**アカウント未準備なら鍵未投入のまま起動**し、鍵投入で課金が有効化される。
   - 🟢 自己修復：`INTERNAL_KEY`（`/api/cron/sweep` 保護・スケジューラと共有）、`GITHUB_TOKEN`（リポ作成＋**baku-office-logs への Issues:write**）。`GITHUB_OWNER`/`GITHUB_LOGS_REPO` は `wrangler.jsonc` の vars（既定 `baku-team`/`baku-office-logs`）。
3. D1 作成＋スキーマ適用：`apps/host/migrations/` を **0001 から最新（0012_governance.sql）まで順に適用**（`wrangler d1 execute baku-office-portal-db --remote --file apps/host/migrations/<f>.sql --config apps/host/wrangler.jsonc`）。スキーマ変更を伴う更新時は新規ファイルを忘れず remote へ適用（未適用だと該当機能が無言で失敗）。
4. クライアント配布鍵：ホストの署名鍵に対応する**公開検証鍵**を取得し、クライアント側に渡す（`GET /admin/pubkey`）。
5. 自己修復の定期巡回（任意・自社運用）：集積先リポ `baku-team/baku-office-logs` を作成 → スケジューラを配備 `npm -w apps/scheduler run deploy` → `CRON_TARGETS`（host `/api/cron/sweep`・client `/api/cron/drain` の `{binding,path,key}` JSON・key は各 `INTERNAL_KEY` と同値）を secret 投入。Cron `*/5` で自動巡回。Service Binding（`T_HOST`/`T_CLIENT`）経由＝同一 workers.dev 直fetch遮断(1042)を回避。

### A-0b. リリース署名鍵のローテーション（§3-2）
配布バンドル更新の検証鍵は**ピン留め**（`apps/client/deploy/release-pubkey.json`）。CI（`release.yml`）が「同梱鍵＝署名鍵の公開部分」かつ「署名が同梱鍵で検証できる」ことを公開前に必ず検査し、不一致なら**公開を中止**する（顧客側の全更新停止を防ぐ）。鍵を交換する手順：

1. 新しい Ed25519 鍵ペアを生成し、**秘密鍵**を CI secret `RELEASE_SIGNING_JWK` に更新。ホストの `RELEASE_PUBLIC_JWK`（公開部分）も合わせて更新。
2. `apps/client/deploy/release-pubkey.json` を**新しい公開鍵**に更新してコミット。
3. **重要：この新鍵を同梱したバンドルは、まだ各顧客が持つ「旧鍵」で署名して配る必要がある**（顧客は旧鍵で検証→OK後に同梱鍵を新鍵へ置換＝次回から新鍵）。移行期は**新旧両方の署名を許容（クロス署名）**するか、更新を2段階に分ける。一度の交換で旧鍵署名を省くと、旧鍵を持つ顧客が検証に失敗し更新が止まる。
4. 緊急時（鍵漏洩で旧鍵が使えない）は、顧客に Deploy ボタンからの再取得を案内し、配布リポの最新（新鍵同梱）を取り直してもらう。

### A-1. スタッフログイン
- `/login` → 🟢「Googleでログイン」（`HOST_ADMIN_EMAILS` の管理者のみ操作可）／🧪「管理者としてログイン（dev）」は **`ENV=development` かつ Google 未設定時のみ**有効（本番は無効）。
- 以降 `/clients`・`/notices`・`/apps`・`/nonprofit`・`/audit` は管理者のみ。

### A-2. 団体の申込受付 → ライセンス発行
1. `/apply` で団体情報（団体名・代表者・連絡先）を入力 →「申し込む」。**プラン選択はなし＝全員 Free で開始**（アップグレードは導入後にクライアント `/billing` から）。
2. その場でライセンスを **Free（`plan=free`・`status=active`）で即発行**（Stripe不要）。
3. 画面に出る**初期アクティベーションURL**（`…/activate?license_id=…`）は **dev 専用**（ホスト Worker が `ENV=development` のときのみ）。本番は Google ログイン経由で自動アクティベートされるため不要。
   - ※ クライアントの**個別Deployリンク**もあわせて案内（§C-1）。

### A-3. クライアント管理（監視）
- `/clients`：団体一覧（団体名・**現在の権限＝エンタイトルメント**・契約プラン・稼働バージョン・最終受信）。**状態は「現在の権限」を主表示**（権限を緑バッジで表示・契約プランは請求用に従属表示）。**検索（団体名/メール）・状態/権限フィルタ・50件ページング・件数表示**で多数団体を運用。
- 各クライアントは統合チェック（`/api/check`）で自動的に最終受信/バージョンを更新。クライアントへ配られるのは **entitlement のみ**（plan は内部）。
- **権限/プランは2層で別管理**：plan＝契約/請求、entitlement＝実効権限（Stripe入金・NonProfit審査で上書き）。統合できない（NonProfit 審査と Stripe 入金が並行して権限を上書きするため。§A-3c 参照）。`/clients` から両方を手動変更可、**評価・社内検証用に `test`（全機能解放）** を付与できる（ランク最上位＝全ゲート通過）。検証後は元の権限に戻す。
- **顧客削除（安全化）**：削除は**確認モーダルで団体名のタイプ確認**を必須化し、削除対象（ライセンス/配布リポ/利用状況/DL/レビュー/NonProfit申請/A2A接続）を明示（誤操作防止）。実行時はライセンス／アクティベーションコードに加え、それら**関連レコードを明示削除**（D1 に FK/CASCADE が無いため孤児化を防止）。GitHub 連携時は団体リポも best-effort 削除。
- 上記のプラン変更・削除は**監査ログ**（§A-7）へ記録される。

### A-3b. アプリ管理（中枢レジストリ）— `/apps`
- **存在の管理**：各リポで作られたアプリを登録（id/名称/版/リポURL/権限）→ 承認（approved）/公開停止（blocked）/削除（deleted）。
- **公開申請の認証**：クライアントからの公開申請（`/api/registry/submit`）は**署名ライセンストークン認証**（生 licenseId は受理しない＝なりすまし pending 登録を遮断）。
- **公開停止＝キルスイッチ**：`blocked` にしたアプリ id は統合チェック（`/api/check`）の `revokedApps` でクライアントへ配布され、**取り込み済みでも自動で無効化（削除）** される（緊急停止・復帰可）。
- **削除＝墓標＋利用0で完全削除**：削除すると `app_revocations` に撤去指示（墓標）を残し全クライアントから撤去。利用申告が0なら registry 行も物理削除、残っていれば `status=deleted` で履歴保持（後で利用0になれば完全削除可）。墓標があるため物理削除後も撤去指示はクライアントへ届き続ける。
- **未登録で稼働中**のアプリ（レジストリ未登録だが利用申告あり）も**登録／公開停止／復帰／削除**を `/apps` から実行可（registry 行が無くても `app_revocations` で全クライアントへ反映）。
- **標準同梱アプリの登録／除外**：全クライアントに同梱されるコアパーツ（chat/会計/メモ/リマインダー/ナレッジ/会員/サイト/インポート/ブランディング/Gmail/カレンダー/Meet議事録/請求書）を `/apps` の「標準同梱アプリ」表で**除外**（`builtin_policy` enabled=0）すると、`disabledBuiltins` を統合チェックで配布し全クライアントの導入集合・エージェント道具から外す。**登録**で再有効化。必須＝AIチャットは除外不可。
- **利用状況**：クライアントが申告した導入アプリ（id:version・PIIなし）を集計し、アプリ別の**ユニーク導入数**（同一ライセンスの再DLは二重計上しない）・版分布・アクティブ数を表示。
- 前提：ホスト D1 に `0004_app_registry.sql`／`0011_app_downloads_unique.sql`／`0012_governance.sql` を適用（`wrangler d1 execute baku-office-portal-db --remote --file apps/host/migrations/<f>.sql --config apps/host/wrangler.jsonc`）。

### A-3d. 報告・自己修復 — `/reports`
- **集積**：クライアントから自動収集したエラーと、利用者の不具合/要望リクエストを `client_reports` に集約表示（同種エラーは fingerprint で再発回数を集約）。種別（error/request）・状態（open/triaged/synced/resolved/wontfix）でフィルタ。
- **GitHubへ集積**：行ごとの「GitHubへ集積」または「未集積エラーを一括で」で `baku-team/baku-office-logs` に **Issue 化**（`syncReportToGithub`）。集積された Issue を **Claude（Web 等）が巡回・修復**＝クラウドで直せる問題は修正→PR→Issueにリンク、不能なら原因と対策をレポート化しPRへ、という分担（baku-office 側の責務は「集積・通知」まで）。
- **クライアントへ返信**：状態を `resolved`/`wontfix` にして対応メモ・PR URL を書くと、次回の統合チェックで `reportUpdates` としてクライアントへ届き、`/diagnostics` の「サポートからの対応」に表示される。
- **定期巡回**：`baku-office-scheduler`（Cron Triggers `*/5`）が Service Binding 経由で `/api/cron/sweep`（未集積エラーの自動 Issue 化）を叩く。手動でも `/reports` の一括集積で実行可。
- 前提：host D1 に `0012_governance.sql` 適用、host secret `INTERNAL_KEY`、host var `GITHUB_LOGS_REPO`、`GITHUB_TOKEN` に対象リポの **Issues:write**（リポアクセスに baku-office-logs を含める）。

### A-3c. NonProfit 審査 — `/nonprofit`
- 申込時に NonProfit（非営利・全機能無料）を選んだ団体は審査待ち（通過まで Free 相当）。一覧から**承認**（`entitlement=nonprofit`＝全機能解放）／**却下**（理由付き）。
- **却下＝降格**：承認後に資格を失った団体を却下すると、`entitlement` を**プランベースへ戻す**（nonprofit のまま貼り付かない）。承認済み一覧からの**剥奪**導線もここから。
- 承認/却下は**監査ログ**（§A-7）へ記録される。

### A-4. お知らせ配信
- `/notices` で info／important／critical を発行・停止。
- クライアントは統合チェックで受信し表示（critical は確認モーダル）。

### A-5. 課金・入金確認
- 🟢 Stripe 接続時：カード=即時、振込/コンビニ=入金確認(Webhook `/api/billing/webhook`)でエンタイトルメント昇格。
- 🧪 Stripe 未接続時：クライアントの課金画面の「デモで支払った」操作（`/api/billing/dev-confirm`）で昇格をシミュレート。
- 解約（`subscription.deleted`）／未入金（`subscription.updated` が past_due/unpaid 等）で無料(Free)へ降格（データはロック/削除しない）。復帰は `invoice.paid` で再昇格。NonProfit 付与中の団体は Stripe イベントで降格上書きしない。

### A-6. バージョン更新の配布
- `apps/client` を更新して main へ push → **CI（`publish-client.yml`）が公開配布リポ `baku-office-app` を自動更新**。
  - 事前に private リポへ `PUBLISH_TOKEN`（配布リポ書込PAT）を登録。
- 顧客はフォーク同期で受領（§C-7）。DBスキーマは顧客側で自動適用（§C補足）。

### A-7. 監査ログ — `/audit`
- 管理者による**プラン／エンタイトルメント変更・顧客削除・アプリ承認/公開停止/削除・標準同梱の登録/除外・NonProfit 審査・アプリ公開申請・報告対応**の操作履歴（日時・実行者・操作・対象・詳細）。**検索（実行者/対象/詳細）・操作種別フィルタ・50件ページング・件数表示**で追跡。
- 記録は `recordAudit`（`host_audit` テーブル）で各操作 API から自動付与。記録失敗は本処理を止めない（best-effort）。
- 前提：ホスト D1 に `0010_audit.sql` を適用。

### A-8. 障害復旧 Runbook（マイグレーション失敗・ロールバック）

> 前提：D1 に「下り（down）マイグレーション」は無い＝**前進のみ**。破壊的変更の巻き戻しは **D1 Time Travel**（過去最大30日の特定時点へ復元）が最終手段。本番DB操作は必ず `--remote` で、実行前に `--command "SELECT…"` で影響を下見する。

**① client（自己ホスト・アプリ内ランナー `migrate.ts` の自動適用）が失敗した場合**

症状：診断（`/diagnostics`・`logDiag`）に `migration <id> 失敗: …` または `ensureSchema 失敗: …`。該当機能が無言で動かない。

1. **原因特定**：診断に残る失敗 `migration <id>` と SQL 断片を確認。
2. **適用状況の確認**：
   ```bash
   npx wrangler d1 execute baku-office-app-db --remote --env production \
     --command "SELECT id FROM schema_migrations ORDER BY id"
   ```
   `MIGRATIONS` 配列との差分が未適用分。部分適用が疑わしいテーブル/列は `PRAGMA table_info(<table>)` で確認。
3. **ロック残留の解消**（稀）：適用中に異常終了し `schema_lock` が残ると次回がスキップされ続ける（60秒TTLで自然消滅するが、即時解消するなら削除）：
   ```bash
   npx wrangler kv key delete --binding=LICENSE schema_lock --env production
   ```
4. **再適用**：原因SQLを修正してコード反映（`migrations/00NN_*.sql` 修正＋`MIGRATIONS` 整合）。冪等エラー（`already exists`/`duplicate column`）は自動無視されるため、通常はデプロイ後の初回リクエストで未適用分が再適用される。`schema_version` ゲートで止まる場合はクリアして再走：
   ```bash
   npx wrangler kv key delete --binding=LICENSE schema_version --env production
   ```
5. **想定外失敗の隔離**（慎重）：特定 `<id>` を恒久的にスキップさせる必要があるときのみ、手動で該当SQLを是正実行し、`INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES ('<id>', unixepoch())` で適用済みに記録。**データ不整合を隠蔽しないこと**（必ず実テーブルの状態を確認してから）。
6. **巻き戻し（最終手段）**：破壊的変更でデータが壊れた場合は Time Travel：
   ```bash
   npx wrangler d1 time-travel info baku-office-app-db --env production       # 復元可能範囲の確認
   npx wrangler d1 time-travel restore baku-office-app-db --env production --timestamp <ISO8601>
   ```
   復元はDB全体が当該時点へ戻る（以後の書き込みは失われる）。実行前に関係者へ周知。

**② host（手動マイグレーション）が失敗した場合**

host は `wrangler d1 execute --file` の手動適用（`schema_migrations` 管理なし）。0001→最新まで**順に適用**する前提。

1. 失敗したファイルの SQL を確認・是正し、**そのファイルのみ**再実行：
   ```bash
   npx wrangler d1 execute baku-office-portal-db --remote --config apps/host/wrangler.jsonc \
     --file apps/host/migrations/<n>.sql
   ```
2. 適用済み判定はスキーマ実体で確認（`PRAGMA table_info(<table>)` / 該当オブジェクトの存在）。冪等になるよう SQL は `IF NOT EXISTS`／`ADD COLUMN`（既定値付き）を用いる。
3. 破壊的変更の巻き戻しは client と同様に Time Travel（`baku-office-portal-db`）。

**③ コードのロールバック（不具合バージョンを配布してしまった場合）**

署名リリースは**バージョン番号の単調増加（前進のみ）**で受領可否を判定する（§3-2・配布バンドル同梱 `VERSION` を顧客側ローダが比較）。このため古いバージョン番号での再配布は顧客側で「前進でない」と判断され**適用されない**。**正規のロールバックは「旧コード（正常だった時点）を“新しいバージョン番号”で再リリースする」ロールフォワード方式**。

1. 正常だった時点へコードを戻す（例：`git revert <不具合コミット>`、または該当コミットの内容を `main` 先端へ反映）。**`main` 直コミットはせず作業ブランチ → PR → マージ**（CLAUDE.md）。
2. **バージョンを上げる**：`apps/client/scripts/build-release.mjs` の `const VERSION` を次の番号へ（例 `0.2.1` → `0.2.2`）。`release/VERSION` はビルドで再生成される。
3. `main` へ反映 → CI（`publish-client.yml` ＋ `release.yml`）が**新バージョンで署名リリース**。顧客はフォーク同期で受領（§C補足）。
4. **自社の稼働 Worker** は別途手動デプロイ（client は `deploy:prod`）。
5. **マイグレーション整合に注意**：DB は前進のみ＝既に適用済みの新スキーマは戻らない。戻したコードが**新スキーマ上でも動く（後方互換）**ことを確認する。DB 実体を壊した場合のみ Time Travel（①-6）を併用。

**④ 予防（推奨）**
- マイグレーションは**DDL限定**（INSERT/UPDATE はアプリ層で冪等に）。WHY: 自動適用は初回同時リクエストで並行し得る（KV best-effort ロックはあるが結果整合）。
- 破壊的変更の前に Time Travel の現在時刻を控える（復元の起点）。
- 本番反映は必ず `npm run typecheck` ＋ 各 `test` 通過後に。client は `deploy:prod`、host は migration 適用 → deploy の順。

---

## B. ホスト側：テナント別配信（多数顧客・別アカウント運用）

別アカウントの顧客を多数捌く場合（`scripts/admin.mjs` をホストWorkerに対して実行）：
1. `node scripts/admin.mjs pubkey` … 顧客へ渡す公開検証鍵。
2. `node scripts/admin.mjs tenant <id> <顧客クライアントURL> <provisionKey>` … 台帳登録。
3. `node scripts/admin.mjs config v1 <id>` / `lease 30 <id>` … 署名→顧客の `/provision` へ配信。
   - もしくは `setup-tenant.sh <id> <url>` で一括（台帳登録＋初期配信＋顧客へ渡す3値出力）。
- 顧客は受け取った `VERIFY_PUBLIC_JWK`／`PROVISION_KEY`／`TENANT_ID` を自分のWorkerに登録。
- ※同一CFアカウント内は Service Binding、別アカウントはカスタムドメインURLで配信（workers.dev同士の直fetchはCFが遮断＝1042）。

---

## C. クライアント側の操作

### C-1. 配備（Deploy to Cloudflare）
1. 団体専用Googleアカウントを用意（引継ぎ容易）。
2. 当社の**個別Deployリンク**（公開配布リポ `baku-office-app` 対象）を開く → Cloudflareに Google でサインイン。
3. Cloudflareが**自分のGitHubへ複製**し、**D1/KVを自動作成**してデプロイ（単一Worker）。
   - 🧪 開発検証は当社アカウント（baku-llc env.production）へ直接 deploy も可：`cd apps/client && npx wrangler deploy --env production`（`npm run deploy` は `--env` 無し＝top-level 構成に出るため、env.production へは `--env production` を明示）。

### C-2. 初回アクティベーション（認証キー入力なし）
- デプロイ後に初めてアプリを開くと、ライセンス未保持を検知し**自動でアクティベーション**へ。
- 🟢 申込時と同じGoogleで認証 → 署名済みライセンストークンを取得・保存（§4）。deploy_url 確定でホスト側が公開 throwaway リポを自動削除（露出最小化）。
- 🧪 dev：案内された `…/activate?license_id=…` を開くと取得（**ホスト Worker が `ENV=development` のときのみ有効**。本番は 403＝Google 経由のみ）。
- 以後 `/` ホームでプラン状態・使用量・お知らせ・アプリのウィジェットを表示。

### C-2b. 画面構成（4ナビ）
操作は4つに集約。業務画面は「アプリ」のランチャーから開き、各種設定は「設定」に集約される。
- **ホーム** `/`：お知らせ、API/DB/ストレージ使用量、導入アプリのウィジェット（例：総会員数・当月取引数）。
- **AI** `/chat`：相棒とのチャット（セッション保存・切替、モデル選択 Gemini/Claude/local）。ここからAIアプリ開発も。
- **アプリ** `/apps`：導入済みランチャー／マーケット（導入・削除）／外部取り込み（署名検証）／開発草案（管理者）。
- **設定** `/settings`：メンバー・連携・課金・カスタマイズ・運用をカテゴリ別に集約。

### C-3. ログイン（組織／個人）
- `/login`：
  - **組織（管理者）**：🟢 Googleでログイン（最上位）／🧪 dev管理者。
  - **個人（メンバー）**：🟢 LINE/Discordログイン／🧪 ID・パスワード。招待が必要（§C-5）。

### C-4. 連携設定（APIキー）— `/settings/keys`
- Gemini（AI/無料スタック）、LINE（チャネルシークレット＋アクセストークン）、Claude（上位・任意）を入力。
- 保存時に**検証→暗号化保存**（CFダッシュボード不要）。結果はトーストで表示。
- LINEエージェント利用時：表示される **Webhook URL（`…/api/line/webhook`）** を LINE Messaging API に設定。

### C-5. 人・ロール管理（招待＋承認）— `/settings/members`（管理者）
1.「招待コードを発行」（ロール指定・1週間/1回）→ `/join?code=…` を本人へ。
2. 本人が `/join` で氏名・役職・ログイン情報を登録 → **承認待ち(pending)**。
3. 管理者が一覧から**承認**→active（却下/無効化も可）。ロールは行で変更。
- ロール：admin（全権）／accounting（経理）／clerical（庶務）／other（個別）／member（個人のみ）。

### C-6. 日常業務
- **会計** `/accounting`：入出金登録（収入/支出/振替）、出納帳（累計残高）、収支計算書、予実、CSV出力。
- **名簿**：人・ロール管理（PIIは暗号化保存・表示時復号）。
- **ファイル** `/files`：アップロード/一覧/DL/削除（標準=KV・既定25MB／高度=R2）。
- **予定** `/schedule`・**議事録** `/minutes`：作成・一覧。
- **共有承認** `/review`（会計/庶務/管理者）：個人→組織の共有を承認（領収書は会計取引ドラフトを自動生成）／却下。
- **個人** `/personal`（個人ログイン時）：領収書・メモ・タスク・予定を記録→「組織へ共有」で申請。
- **Gmail** `/gmail`・**カレンダー** `/calendar`・**Meet議事録** `/meet`・**請求書** `/invoices`（Google Workspace連携）：`/settings` でGoogle OAuth接続後に利用。Gmail＝受信検索・本文/添付取得、カレンダー＝予定の作成/更新/削除・Meetリンク発行、Meet議事録＝録画トランスクリプト取得→AI要約→組織ナレッジ保存、請求書＝ファイルから登録・未払一覧・消込。

### C-7. LINEエージェント（Proプラン）
- Pro＋LINEキー設定時、LINE公式アカウントに話しかけると応答（要 entitlement=pro）。**発話者は登録済み active 会員に限定**（非会員は案内のみ・名簿照会は admin/会計/庶務のみ）。
- できること：会話、支出/領収書の記録、メモ、リマインダー、ナレッジ保存/検索、メンバー検索、（Geminiキー）web検索・音声文字起こし・大PDF要約、（Claudeキー）資料生成/スキル実行、（任意API）画像/音声/動画生成。道具は各パーツが提供（有効パーツのみ）。
- **オフライン運用（任意）**：外部キーを使わず `LOCAL_AI_BASE_URL`（OpenAI互換のローカルLLM）を設定すると、外部送信ゼロでエージェントが動く（Profile C）。
- 画像/ファイル/音声を送ると自動で OCR/要約/文字起こし。重い処理が無料枠制限に達した場合は **Workers Paid 案内**を返信。

### C-8. プラン・課金 — `/billing`（管理者）
- 現プラン表示。アップグレード（Free→Plus→Pro）。
- 🟢 Stripe決済へ遷移／🧪「【デモ】支払った」で昇格。入金確認でエンタイトルメントが上がり機能解放。

### C-9. 高度なオプション — `/settings/advanced`（管理者・従量課金系＋カスタマイズを集約）
- **見た目（テーマ）**：ブランド名・ロゴ・配色を団体ごとに上書き（共通画面はそのまま）。
- **ナビ表示**：メニューに出す機能を選択（表示/非表示）。
- **有効パーツ**：使う業務機能（会計/メモ/リマインダー/ナレッジ/名簿/Gmail/カレンダー/Meet議事録/請求書…）を選択。
- **ストレージ上限**：標準モードの1ファイル上限（1〜25MB）。
- **任意API**：画像生成/音声合成/動画生成/embed/カスタムをBYOKで追加→**管理者がレビューして有効化**→AI/エージェントが参照・実行。
- **Agent Skills**：SKILL.md を登録（instruction/code）→有効化→「〇〇スキルで…」で実行（要Claude）。
- **Workers Paid 案内**：無料枠の制限に当たる場合の有料プラン切替手順。

### C-10. 診断・サポート — `/diagnostics`
- エラーログ閲覧。CF無料枠の制限を検知すると**ホームにバナー＋Workers Paid 案内**。
- **自動報告**：エラーはサポート（ホスト）へ自動報告（送信アウトボックス→`cron/drain` の `flushReports` でバッチ送信・PIIなし）。クラウドで対応可能なものは自動修正される。
- **不具合・要望リクエスト**：フォームから件名＋内容を送信（`/api/report`）。サポートの対応状況（修正済み/見送り＋メモ・変更内容リンク）は同画面の「サポートからの対応」に表示。

### C補足. 更新の受け取り
- 当社が新バージョンを公開 → **自分の複製を upstream 同期**（Workers Builds が自動再デプロイ）。
- **DBスキーマは初回リクエストで自動適用**（手作業不要・既存データは保持）。
- カスタム（スキル/任意API/設定）は顧客データとして残り、共通更新で**上書きされない**。

---

## クイックリファレンス

| 役割 | URL（例） | 主な操作 |
| --- | --- | --- |
| ホスト | `/login` `/apply` `/clients` `/apps` `/nonprofit` `/notices` `/reports` `/audit` | スタッフログイン・申込・監視・アプリ承認/停止/削除/同梱登録除外・NonProfit審査・配信・報告/自己修復・監査ログ |
| ホストAPI | `/api/apply` `/api/activate` `/api/token` `/api/check` `/api/billing/*` `/api/notices` `/api/registry`（delete/revoke/builtin_set） `/api/registry/submit` `/api/report` `/api/reports` `/api/cron/sweep` | 発行・アクティベート・統合チェック（`revokedApps`/`disabledBuiltins`/`reportUpdates` 配布）・課金・通知・アプリ統制・報告受信/統制・自己修復巡回 |
| クライアント（4ナビ） | `/`（ホーム） `/chat`（AI） `/apps`（アプリ） `/settings`（設定） | 相棒・アプリ導入/開発・設定集約 |
| クライアント（業務画面） | `/accounting` `/membership` `/files` `/schedule` `/minutes` `/review` `/personal` `/billing` `/settings/keys` `/settings/advanced` `/diagnostics`（報告/サポート対応） | 「アプリ」「設定」から起動する各機能 |
| クライアントAPI | `/api/line/webhook` `/api/cron/drain` `/api/report` `/provision` | エージェント・リマインダー/ジョブ処理＋報告送信・不具合/要望受付・配信受信 |
| スケジューラ | `baku-office-scheduler`（Cron `*/5`） | Service Binding 経由で host `/api/cron/sweep`・client `/api/cron/drain` を定期起動（CF内完結） |

- **自動巡回**：`baku-office-scheduler`（Cloudflare Cron Triggers）が 5 分ごとに Service Binding 経由で `/api/cron/sweep`（報告→GitHub集積）・`/api/cron/drain`（reports flush・リマインダー・要約/動画ジョブ）を起動。鍵は `CRON_TARGETS` に集約（host/client の `INTERNAL_KEY` と同値）。
- 外部スケジューラ（cron-job.org等）で叩く場合も従来通り `POST /api/cron/drain`（`x-internal-key: INTERNAL_KEY`・`content-type: application/json`）。
- ※顧客（別アカウント）の client は各自のCFアカウントで cron が必要（配布テンプレへの同梱は今後）。同一アカウントの自社運用は scheduler が host＋client をまとめて巡回。
