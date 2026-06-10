# baku-office 第三者視点レビュー報告書

- 作成日: 2026-06-10
- 対象: `baku-office` リポジトリ一式
- レビュー種別: 新規レビュー
- 出力先: `reports/third-party-review-2026-06-10/003_baku-office_third-party-review_2026-06-10.md`

## 0. 前提と免責

本報告書は、今回確認したリポジトリ内容と公式公開情報に基づく第三者視点の技術レビューであり、過去レビュー文書や過去コンテキストを根拠としていない。法的評価はリスク整理であり、弁護士等による法的助言ではない。

外部参照は、個人情報保護委員会の APPI 英訳資料、Google API/Workspace ポリシー、Cloudflare 料金/制限、OWASP Top 10 を確認した。

## 1. 総合評価

総合判定: **B- / 本番導入前に高優先リスクの是正が必要**

baku-office は、Cloudflare 上の自己ホスト型クライアントアプリ、ホストポータル、申込 Worker、Scheduler、共有パッケージで構成される。顧客データを顧客 Cloudflare アカウント側に置き、ホストはライセンス・配信・課金・通知を担う分離設計は、データ集中リスクを下げる明確な強みである。Ports & Parts による移植性、AI/Google/A2A/外部アプリを統合する拡張性も高い。

一方で、ファイル取得/削除の IDOR、公開HTMLの正規表現サニタイズ、Stripe 未設定時の dev 昇格経路、Google Restricted Scope 対応、コスト上限の「推定」依存、UI設定の複雑さは、本番利用時の主要リスクである。特に `files/[id].ts` と `api/files.ts` は、ログイン済みユーザーなら他ユーザー作成ファイルに到達・削除できる可能性があるため、最優先で修正すべきである。

## 2. 評価サマリ

| 観点 | 評価 | 主な理由 |
| --- | --- | --- |
| 技術 | B | モノレポ、Ports & Parts、D1/KV/R2、テスト群は良い。実行環境で `npm`/`node` が無く検証未実行。API認可が各ルート分散で抜けが起きやすい。 |
| 法的 | C+ | 自己ホスト型でホストの業務データ保持を避ける設計は良い。Google Workspace/Gmail/Meet、会員申込、A2A、公開フォームにより、個人情報・越境移転・第三者提供・委託先管理の説明責任が重い。 |
| 倫理 | B- | AI承認ゲート、スコープ分割、利用上限はある。AIの誤操作、プロンプトインジェクション、外部API/BYOKの責任分界、ユーザーへの説明が不足すると信頼を損なう。 |
| セキュリティ | C+ | 鍵用途分離、HMAC Cookie、Webhook署名、A2A nonce、保存時暗号化は良い。IDOR、HTMLサニタイズ、CSP `unsafe-inline`、dev経路、CSRF設計の明文化不足が残る。 |
| コスト計算 | B- | AI token/推定USD/monthly cap/1 job cap がある。Cloudflare・外部AI・Google・R2/D1実費との突合、失敗時課金、単価更新、管理者通知が弱い。 |
| UI/UX | B- | 4画面集約と設定画面は分かりやすい。高機能化により設定密度が高く、危険操作/費用発生/Restricted Scope の説明と導線の段階化が必要。 |

## 3. 高優先の指摘

### P0-1. ファイル取得・削除が所有者/ロールを検査していない

証跡:

- `apps/client/src/pages/files/[id].ts:10-16` はログイン有無のみ確認し、`getFile(env, id)` でファイルを返す。
- `apps/client/src/pages/api/files.ts:17-19` は任意 `id` に対して `softDeleteFile` を実行する。
- `apps/client/src/lib/storage.ts:86-98` の `getFile` / `softDeleteFile` は `created_by` を見ていない。
- `apps/client/migrations/0002_files_schedule.sql:3-10` には `created_by` 列が存在する。

影響:

ログイン済みユーザーがファイルIDを知る、または推測/漏洩した場合、別ユーザーや別コンテキストのファイルを取得・削除できる可能性がある。会員PII、領収書、議事録、請求書、Gmail添付などを扱う設計上、機微性は高い。OWASP Top 10 の Broken Access Control に該当し得る。

推奨:

- `getFileForUser(env, id, session)` / `softDeleteFileForUser` を追加し、`created_by = ses.uid`、または `admin/org` 等の明示ロールだけを許可する。
- 個人/組織/LINE由来ファイルのスコープ列を追加する。
- ダウンロード/削除の監査ログへ結果、拒否理由、actor、file owner を残す。
- 契約・法務上は、ファイルを個人データとして扱う前提でアクセス制御テストを必須化する。

### P0-2. Stripe 未設定時の `dev-confirm` が本番誤設定で課金回避になる

証跡:

- `apps/host/src/pages/api/billing/dev-confirm.ts:9-17` は Stripe が有効でなければ、認証なし GET で `license_id` と `plan` を受けてエンタイトルメントを昇格する。
- `apps/host/src/pages/api/billing/checkout.ts` も Stripe 未設定時に dev URL を返す。

影響:

本番で Stripe secret 未設定のまま公開されると、ライセンスIDを知る者が Plus/Pro へ昇格できる。請求・契約・収益に直結するため高優先。

推奨:

- `ENV=development` のときだけ `dev-confirm` を有効化する。
- 本番 `ENV !== development` かつ Stripe 未設定なら checkout/dev-confirm とも fail-closed。
- エンタイトルメント変更はホスト管理者セッションまたは Stripe Webhook 署名経由のみに限定する。

### P0-3. 公開サイトHTMLのサニタイズが正規表現ベース

証跡:

- `apps/client/src/layouts/SitePublic.astro:8-16` は `script`、イベント属性、`javascript:` を正規表現で除去する。
- `apps/client/src/layouts/SitePublic.astro:40` で `set:html={safeBody}` を使う。

影響:

HTMLパーサではなく正規表現に依存しているため、SVG/MathML、属性エンコード、未知タグ、URLスキーム、ブラウザ差分でXSSを取りこぼす可能性がある。公開ページは認証不要のため、被害は管理者だけでなく閲覧者にも及ぶ。

推奨:

- `sanitize-html` や DOMPurify 相当の allowlist 型 HTML sanitizer を導入する。
- 公開サイト側にも CSP を明示する。可能なら `script-src 'self'` へ寄せ、インラインスクリプトは nonce へ移行する。
- 管理者入力HTMLを「Markdown + 限定コンポーネント」に寄せる選択肢も検討する。

### P1-1. Google Workspace/Gmail Restricted Scope の運用負荷が高い

証跡:

- `apps/client/src/lib/google.ts:17-27` は `gmail.modify` と `gmail.send` を Restricted として扱う。
- `apps/client/src/lib/google.ts:67-79` は incremental auth を実装している。
- `apps/client/src/lib/google.ts:93-99` は refresh token と付与グループを保存する。

評価:

スコープ分割・失効・最終利用記録は良い。ただし Gmail/Drive/Meet データは法務・セキュリティ・Google審査上の負荷が大きい。Google API Services User Data Policy は、データ取得目的、保存、共有、削除、プライバシーポリシーの明確化を求める。Restricted scopes は検証やセキュリティ評価が必要になり得る。

推奨:

- Gmail 閲覧/送信はデフォルト無効、利用前に目的・保存期間・削除方法・AI利用有無を明示する。
- Google API Limited Use、プライバシーポリシー、DPA/委託契約、インシデント通知手順を整備する。
- `gmail.modify` ではなく readonly 等で足りる機能はさらに絞る。

### P1-2. コスト上限は「推定」であり、実請求の保証ではない

証跡:

- `apps/client/src/lib/usage.ts:16-20` は token から推定USDを算出する。
- `apps/client/src/lib/usage.ts:23-53` は記録失敗を握りつぶす。
- `apps/client/src/lib/usage.ts:114-127` は月次上限を推定USDまたは回数で判定する。
- `apps/client/src/lib/agent.ts:181-188` は1ジョブ単位の推定USD capを持つ。

影響:

API usageの記録失敗、モデル単価変更、外部能力API、Cloudflare D1/KV/R2/Workersの課金、失敗リクエストの課金、Google API側制限などは実費とずれる。利用者へ「上限を設定したから請求上限が保証される」と誤解されると、信頼・契約上の問題になる。

推奨:

- UI文言で「概算」「実請求は各プロバイダが正」と明示し、初期値として保守的な hard cap を入れる。
- `recordUsage` / `recordTokens` の失敗を診断に残す。
- Cloudflare リソース量は D1/R2/KV の実測・プラン上限に合わせて警告する。
- 月次コストレポートと異常検知通知を追加する。

## 4. 技術評価

強み:

- `apps/client`, `apps/host`, `apps/apply`, `apps/scheduler`, `packages/shared` の責務分離が明確。
- README/ARCHITECTURE 上、自己ホスト型・ホスト/クライアント分離・Ports & Parts が一貫している。
- D1/KV/R2、WebCrypto、Gemini/Claude/local LLM、Google/A2A/LINE/外部アプリを抽象化している。
- `apps/client/test/` と `apps/host/test/` に契約テストが存在する。
- 自動マイグレーション、署名ライセンス、A2A nonce、Webhook署名など、設計上の防御が複数ある。

懸念:

- `apps/client/src/middleware.ts:39-40` で `/api/` は全てミドルウェア認可対象外のため、各APIに認証・認可が分散する。実装漏れの検出を自動化すべき。
- `apps/client/src/pages/api/agent-actions 2.ts` のような重複/スペース入りファイルが存在し、ルーティングや保守性のリスクがある。
- `node` / `npm` が実行環境のPATHに無く、`npm test`、`npm run typecheck`、`npm audit` は未実行。

推奨:

- APIルートの認可ルール一覧を作成し、未認証許可ルートを明示 allowlist 化する。
- `rg`/静的テストで「POST APIに `getSession` が無い」「GETで状態変更」などを検出する。
- CIで `npm test`、`typecheck`、`npm audit --omit=dev`、依存ロック差分チェックを必須化する。

## 5. 法的評価

主な法的論点:

- 個人情報: 会員名簿、連絡先、領収書、請求書、Gmail本文/添付、Meet議事録、LINE ID等を扱う。
- 第三者提供/委託/越境移転: Google、Anthropic、Gemini、Claude、Cloudflare、外部AI能力、A2A連携先が関与し得る。
- 本人説明: 利用目的、保存期間、AI処理、外部API送信、削除/開示/訂正方法を明示する必要がある。
- Googleポリシー: Gmail等の Restricted Scope では、透明性、最小権限、限定利用、削除要求対応、場合により検証/セキュリティ評価が必要。
- 課金/契約: 自己ホスト型であるため、ホストの責任範囲、顧客のCloudflare/API費用負担、BYOKの責任分界を契約で明確化すべき。

推奨:

- プライバシーポリシー、利用規約、DPA、サブプロセッサ一覧、Google API Limited Use Disclosure を整備する。
- 顧客向けに「ホストが見ないデータ」と「顧客アプリ/外部APIが処理するデータ」を分けて説明する。
- A2Aは公開アクションごとに、提供先、提供項目、利用目的、ログ保持を記録する。
- 会員申込フォームには、利用目的・問い合わせ先・保存期間・第三者提供の有無への導線を追加する。

## 6. 倫理評価

良い点:

- AIエージェントの対外/破壊系操作に承認ゲートがある。
- アプリ開発は事前確認を通す設計になっている。
- Googleスコープは用途別に分割されている。

懸念:

- AIがメール本文、議事録、請求書、会員情報を横断的に扱うため、ユーザーが「何がAIに渡るか」を直感的に理解しにくい。
- カスタムプロンプト、外部能力、A2A公開アクションは、管理者の誤設定で予想外のデータ露出や自動処理につながる。
- 「AIの相棒」という表現は魅力的だが、誤回答・誤操作・費用発生の責任境界を明確にしないと期待過剰を招く。

推奨:

- AI処理前に「使用データ」「外部送信先」「費用見込み」「承認要否」を短く表示する。
- 重要操作は「AIが提案、人が確定」を標準にする。
- 監査ログを利用者にも見える形で提供し、AIの操作履歴を説明可能にする。

## 7. セキュリティ評価

良い点:

- `MASTER_KEY` は本番未設定時に暗号処理をブロックする設計がある（`apps/client/src/lib/client.ts:133-153`）。
- セッションHMACはHKDFで用途分離されている。
- Google refresh token は暗号化保存し、失効・最終利用日時を管理する。
- LINE Webhook は署名検証、A2A は署名・期限・nonceを持つ。
- `apps/client/src/middleware.ts:8-19` でCSP等のセキュリティヘッダを付与している。

懸念:

- P0-1のファイルIDOR。
- `script-src 'unsafe-inline'` と `style-src 'unsafe-inline'` が残る（`apps/client/src/middleware.ts:10-11`）。
- 公開HTMLの正規表現サニタイズ。
- CSRFトークンは見当たらない。SameSite=Lax と JSON preflight で一定軽減されるが、全変更系APIに対する明示防御ではない。
- 本番/開発の分岐が複数箇所にあり、`ENV` / `ENVIRONMENT` / Stripe secret の誤設定に弱い。
- APIキー、Google refresh token、ファイル暗号鍵が顧客アカウント内にあるため、顧客Cloudflare侵害時の影響は大きい。

推奨:

- 高リスクAPIにCSRFトークンまたはOrigin/Referer検証を追加する。
- CSP nonce移行、公開サイト用CSP追加、HTML sanitizer導入。
- 本番起動時の preflight で `ENVIRONMENT=production`、`MASTER_KEY`、`ADMIN_KEY`、Stripe設定、Google OAuth設定を検査する。
- アクセス制御テストをIDOR中心に追加する。

## 8. コスト計算評価

良い点:

- API使用量画面で日次/月次、provider別、token、推定USD、上限を可視化している。
- `AI_MAX_JOB_USD` によるジョブ単位停止がある。
- Workers Paid 自己申告により、並列数やhop上限を変える設計がある。

懸念:

- Cloudflare Workers Paid は最低月額や超過利用がある。D1はrows read/write/storage、R2はstorageとClass A/B操作等で課金されるため、AIのtoken上限だけでは全体費用を抑えられない。
- `recordUsage`/`recordTokens` が失敗を握りつぶすため、上限判定が壊れても気づきにくい。
- 任意API能力の単価・無料枠・失敗課金はプロバイダごとに異なる。

推奨:

- Cloudflare D1/KV/R2/Workers とAIを分けた月次予算を設定する。
- 管理者に80%/100%到達通知を送る。
- 外部能力APIは登録時に単価、最大回数、最大ファイルサイズ、最大秒数を必須入力にする。

## 9. UI/UX評価

良い点:

- README上の「ホーム/AI/アプリ/設定」4画面集約は、理解しやすい情報設計である。
- 使用量画面、診断、Google連携、承認待ちなど、運用上必要な画面がある。
- モバイル横スクロールテーブルやレスポンシブ配慮がある。

懸念:

- 設定・高度なオプション・連携・課金・使用量・外部APIが多く、非技術管理者には判断負荷が高い。
- Gmail/Meet/Drive、外部AI、A2A、オートパイロットなど危険度の違う機能が同じ設定体験に混在しやすい。
- UI文言が技術寄りで、費用・法務・外部送信の意味が利用者に伝わりにくい場面がある。
- `--radius: 14px` などカード的UIが多く、業務SaaSとしてはやや装飾寄りになりやすい。

推奨:

- 初期設定ウィザードを「必須」「AI」「Google」「外部公開」「自動化」に分割する。
- 危険操作はリスクラベル、確認画面、監査ログへのリンクを統一する。
- Google Restricted Scope と外部APIは「何にアクセスするか」「どこに送るか」「費用」を同一画面で確認させる。
- アクセシビリティとして、色だけに依存しない状態表示、テーブルのモバイル代替、フォームエラーの明示を強化する。

## 10. 参照した公式情報

- 個人情報保護委員会: [Amended Act on the Protection of Personal Information](https://www.ppc.go.jp/files/pdf/APPI_english.pdf)
- Google: [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
- Google: [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- Google: [Google Workspace API user data and developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
- Cloudflare: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- Cloudflare: [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- Cloudflare: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- Cloudflare: [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- OWASP: [Top 10 2025 A01 Broken Access Control](https://owasp.org/Top10/2025/A01_2025-Broken_Access_Control/)

## 11. 実行確認

試行したが、この環境では `node` / `npm` がPATH上に無く、以下は未実行。

- `npm test`
- `npm run typecheck`
- `npm audit --omit=dev --audit-level=moderate`

次回は Node/npm が利用できる環境で、契約テスト、型検査、ビルド、依存監査を通したうえで再評価することを推奨する。

## 12. 優先アクション一覧

1. ファイル取得/削除に所有者・ロール検査を追加し、IDORテストを追加する。
2. `dev-confirm` を `ENV=development` 限定にし、本番Stripe未設定時は fail-closed にする。
3. 公開HTMLを allowlist sanitizer に置換し、公開サイトCSPを追加する。
4. API認可の allowlist/denylist と静的検査をCIに追加する。
5. Google API/Workspace向けのプライバシー開示、Limited Use、削除手順、Restricted Scope審査要件を整備する。
6. コスト上限の推定性をUI/契約で明示し、記録失敗を診断へ残す。
7. 本番preflightで `MASTER_KEY`、`ADMIN_KEY`、Stripe、Google OAuth、ENV設定を一括検査する。
