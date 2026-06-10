# baku-office 第三者評価報告書 v2

作成日: 2026-06-10  
対象: `baku-office` リポジトリ一式  
評価観点: 技術、法的、倫理、セキュリティ、コスト計算  
立場: 外部レビュー相当の第三者視点  

> 注意: 本報告書は事業・技術・リスク評価であり、弁護士、公認会計士、税理士、Google/Cloudflare/Anthropic等の公式審査機関による正式な意見ではありません。本番提供前には、利用規約、プライバシーポリシー、委託契約、AI利用、Google Workspace API、決済、個人情報保護について専門家レビューを行うべきです。

## 1. 総合評価

baku-office は「顧客が自社クラウド上にAI業務基盤を所有する」という事業コンセプトが明確で、一般的な中央集約SaaSとは違う強い差別化があります。特に、顧客Cloudflareアカウント内に業務データを置く自己ホスト設計、Ports & Parts による移植性、署名付きライセンス/アプリ配布、AIによるアプリ作成前の4確認は、第三者視点でも評価できます。

一方で、対象はまだ「本番商用提供前の高機能MVP」と見るのが妥当です。P0級だった鍵管理、Google OAuth scope分割、AI使用量のtoken計測、ファイル保存時暗号化、人間承認ゲートはコード上かなり改善されています。ただし、署名鍵運用、Google Restricted scopes 審査、UIのXSS面、AIプロンプトインジェクション、モデル価格/廃止リスク、法務文書と事故対応手順は、本番提供の前提として追加統制が必要です。

推奨判定:

| 項目 | 評価 | コメント |
| --- | --- | --- |
| 事業性 | A- | 「自社所有AI業務基盤」は訴求力が高い。非営利、小規模団体、士業、地域企業向けに合う。 |
| 技術実現性 | B+ | Astro/Cloudflare/D1/KV/R2/Workersの構成は妥当。移植性テストの思想もよい。実行検証は今回環境に `node`/`npm` がなく未実施。 |
| 法務適合性 | B | 自己ホストでホスト側の個人情報保有を抑える設計は強い。Google/AI/外国事業者への外部送信整理はまだ運用文書が必要。 |
| 倫理/AIガバナンス | B+ | 4確認、人間承認、A2A read-only設計は好材料。高リスク用途制限と利用者への透明性を製品内にさらに入れるべき。 |
| セキュリティ | B | 鍵・暗号・OAuth・A2A・承認まわりは改善済み。ただし署名鍵、サプライチェーン、UI XSS、SSRF残余が残る。 |
| コスト管理 | B- | token/推定USDの記録が追加されている。モデル単価の固定値、メディア/検索/ツールtokenの完全なhard capは継続課題。 |

総合判定: **社内利用と少数の限定ベータは条件付きGo。一般公開・本番商用提供は、署名鍵運用、Google審査/同意、法務文書、CI検証、XSS監査、事故対応を完了してからが望ましい。**

## 2. 評価対象の理解

本リポジトリは npm workspaces のモノレポです。

| 領域 | 役割 |
| --- | --- |
| `apps/host` | ホストポータル。申込、ライセンス、課金、通知、アプリ承認、A2A中継、レポート集積。 |
| `apps/client` | 顧客が自己Cloudflareへ配備する業務アプリ。AI、会計、名簿、Google連携、ファイル、A2A等を含む。 |
| `apps/apply` | 申込専用Worker。 |
| `apps/scheduler` | Cron/Service Binding による巡回、drain/sweep起動。 |
| `packages/shared` | 暗号、ライセンス署名、型、GitHub連携。 |

中核の信頼境界は「ホストはライセンス/配信/課金/サポートを担い、顧客業務データ・APIキー・PIIは顧客Cloudflare内に置く」です。この思想はREADME/ARCHITECTURE/OPERATIONSと実装の大枠で整合しています。

今回の確認方法:

- リポジトリ内のREADME、ARCHITECTURE、OPERATIONS、主要lib/API/migration/testを静的確認。
- 公式ドキュメントで価格、Google Workspace API、個人情報保護委員会、AI事業者ガイドラインを確認。
- `npm run typecheck` は実行不能。理由はローカル環境に `npm` と `node` が存在しないため。

## 3. 技術評価

### 3.1 強み

| 強み | 根拠 |
| --- | --- |
| 自己ホスト型の境界が明確 | README/ARCHITECTUREで、ホストが顧客業務データに到達しない前提を明示。 |
| Ports & Parts 設計 | `apps/client/src/core/ports.ts`、`parts/`、Node+SQLite契約テスト群により、Cloudflare依存を薄くする方向。 |
| AIモデル抽象 | `core/ai.ts`、`core/models/gemini.ts`、`core/models/claude.ts`、`core/models/local.ts` により Gemini/Claude/local を同じtool loopへ接続。 |
| 本番鍵管理の改善 | `client.ts` で `ENVIRONMENT=production` かつ `MASTER_KEY` 未投入時に暗号処理をブロックする実装。 |
| Google scope分割 | `google.ts` で `calendar`、`gmail_read`、`gmail_send`、`meet` の段階同意へ分離。 |
| token/推定USD計測 | `usage.ts`、`core/models/*`、`migrations/0022_usage_tokens.sql` で input/output token と推定USDを保存。 |
| ファイル保存時暗号化 | `storage.ts`、`migrations/0023_files_encryption.sql` でファイル本体をAES-GCM暗号化。 |
| 対外/破壊操作の承認 | `approvals.ts` と `agent.ts` で A2A/Gmail/Calendar等の危険操作に承認ゲートを置く思想。 |

### 3.2 技術的な懸念

| 重要度 | 懸念 | 根拠/該当箇所 | 推奨 |
| --- | --- | --- | --- |
| 高 | 実行検証が今回できない | `npm`/`node` がローカルに存在せず、`typecheck`/test/build未実行。 | CIを必須化し、PRで `npm run typecheck`、`npm test`、host/client/apply/scheduler buildをゲートにする。 |
| 高 | モデル名と価格がコード固定 | `gemini-2.5-flash`、`claude-sonnet-4-6`、`usage.ts` の単価が固定。 | モデルID、単価、廃止日、capをKV/設定で更新可能にする。定期的に公式価格を同期。 |
| 高 | UIに `innerHTML` が複数ある | `settings/advanced.astro`、`settings/members.astro`、`index.astro` 等。escape済み箇所もあるが、全経路の保証が必要。 | DOMPurify相当またはtextContent/DOM APIへ寄せる。全 `innerHTML` の入力源を棚卸し。 |
| 中 | `preflight.ts` のコスト判定に古い概念が残る | `monthlyCap` をtoken予算のように扱うが、`monthTotals` は回数ベース。 | `monthUsd`/`monthTokens` ベースへ統一。AIアプリ草案では推定USDも出す。 |
| 中 | Google Meet/Gmail等の連携ログ粒度 | `google_last_used` はあるが、操作単位の外部送信ログは限定的。 | 外部API呼び出しログ、データ種別、利用者、モデル、同意scopeを監査できるようにする。 |
| 中 | A2AのSSRF残余 | `isSafeDeployUrl` はDNS rebindingを完全には防げないとコメントで明記。 | 可能ならカスタムドメインallowlist、顧客URL検証、到達先証明、Service Binding優先を導入。 |
| 中 | AIプロンプトインジェクション | Gmail本文、Meet文字起こし、PDF、外部Web、A2A相手の内容がツール実行文脈へ入る。 | 外部入力を「untrusted data」として隔離し、ツール実行直前のポリシー判定を追加。 |

## 4. 法的評価

### 4.1 個人情報保護法

自己ホスト型により、ホストが顧客の業務データを直接保有しない設計は、個人情報保護上のリスク低減に有効です。ただし、顧客側では会員名簿、領収書、Gmail本文、Meet文字起こし、請求書などの個人情報を扱うため、利用目的、安全管理措置、委託先管理、開示/削除、漏えい対応が必要です。

生成AI利用については、個人情報保護委員会が生成AIサービスの利用に関する注意喚起を公表しています。baku-officeは、AIプロンプトに個人情報が入る可能性が高いため、顧客に「どのデータが、どのAI/外部APIに送られるか」を明示すべきです。

外国にある第三者への提供については、Cloudflare、Google、Anthropic等の外国法人/海外処理を使う場合に、本人への情報提供、同意、委託/第三者提供の整理、相当措置の継続的確保などの検討が必要です。

推奨:

- 管理画面に「外部送信先一覧」を設け、Gemini/Claude/Google/LINE/Stripe/Cloudflareごとに送信データ、目的、保存期間、学習利用有無、停止方法を表示する。
- 顧客自身が公開できるプライバシーポリシー/外部送信ポリシーのテンプレートを提供する。
- AIに送信してよいデータ種別を組織単位で設定し、Gmail/Meet/ファイルは既定で慎重側にする。

### 4.2 Google Workspace API

GoogleのGmail APIドキュメントでは、必要最小限のscopeを選ぶことが推奨され、`gmail.modify` は Restricted scope とされています。Restricted scope のデータをサーバーで保存・送信する場合、Googleの審査やセキュリティ評価が必要になり得ます。

現状の改善点:

- `google.ts` は scope group を分割し、`gmail_read` と `gmail_send` を分離。
- `disconnectGoogle`、`googleStatus`、`LAST_USED_KEY` があり、失効と最終利用表示の土台がある。

残課題:

- 顧客が自分のGoogle Cloudプロジェクトで内部アプリとして使う場合と、baku-officeとして公開OAuthアプリ化する場合で責任/審査が大きく違う。
- Google Workspace API User Data Policy の Limited Use、明示的同意、データ管理/削除説明を、製品UIと公開文書に反映する必要がある。

### 4.3 AIガイドライン/高リスク用途

経済産業省/総務省は2026年3月31日にAI事業者ガイドライン第1.2版を公表しています。baku-officeは基盤モデル開発者ではなく、AIシステム提供/利用支援の立場に近いため、安全性、透明性、説明責任、人間中心、アカウンタビリティを運用へ落とす必要があります。

特に、顧客がAIアプリを作れる構造は強みである反面、採用、人事評価、信用判断、医療、行政、児童、金融助言などの高リスク用途へ転用される可能性があります。

推奨:

- 利用規約で禁止用途と高リスク用途を明確化する。
- AIアプリ公開申請に、用途分類、対象データ、外部送信、想定される不利益、説明可能性、人間承認の有無を追加する。
- AI出力が会計、契約、雇用、医療等に影響する場合は、人間承認を必須にする。

## 5. 倫理評価

良い点:

- AIが実装前に企画/仕様と4確認を通す思想は、人間中心のガバナンスに近い。
- A2Aは公開アクションを read-only/許可テーブル中心にしており、過剰な団体間データ共有を避けようとしている。
- 対外/破壊的操作の人間承認ゲートがあり、AIを完全自律で暴走させない方向。
- 自己ホストにより、ホスト側へのデータ集中を避ける倫理的利点がある。

懸念:

- 「個人」画面や個人ログインが、利用者に私的空間と誤認される可能性がある。組織管理者がどこまで閲覧できるかを明示すべき。
- Gmail/Meet/Calendar/請求書/会計をAIが横断すると、誤送信、過剰共有、誤記録の被害が大きい。
- AI生成アプリが組織内監視、人事評価、差別的判断に使われる可能性がある。
- AI生成物の著作権、誤情報、名誉毀損、営業秘密漏えいの責任分界が未整理だと、事故時にホストが巻き込まれる。

推奨:

- 初回オンボーディングで「個人領域は完全な私的領域ではない」ことを明示する。
- AI生成物には、作成者、モデル、入力データ種別、外部送信有無、承認者を残す。
- ユーザーが「AIが何を見て何を実行したか」を後から確認できる履歴画面を整備する。

## 6. セキュリティ評価

### 6.1 良い設計

| 領域 | 評価 |
| --- | --- |
| ライセンス/配布 | Ed25519署名、公開鍵検証、署名付きアプリパッケージ。 |
| 鍵管理 | 本番 `MASTER_KEY` 未投入時の暗号処理ブロック。用途別HKDF。 |
| OAuth | state cookie、Google scope分割、refresh token失効導線。 |
| A2A | ホスト署名、exp、nonce、接続/グループ同意、read-only公開アクション。 |
| Webhook | LINE/Stripe署名検証の実装。 |
| 権限 | role、part minPlan、requiredRole、承認ゲート。 |
| ファイル | 保存時暗号化、保持期限、物理削除ジョブ。 |

### 6.2 主要リスク

| 重要度 | リスク | 説明 | 推奨対応 |
| --- | --- | --- | --- |
| Critical | ホスト署名鍵の侵害 | 毒配信、偽ライセンス、A2A署名悪用につながる。 | Cloudflare SecretsだけでなくKMS/HSM相当、複数人承認、署名鍵ローテーション、署名イベント監視を導入。 |
| High | サプライチェーン | 配布リポ、GitHub Actions、release tarball、依存、難読化、prebuild-updateが攻撃面。 | SBOM、依存監査、lockfile検証、SLSA相当、リリース署名検証のCI必須化。 |
| High | UI XSS | `innerHTML` 利用箇所が複数ある。AI応答や外部データが混ざると事故化しやすい。 | 全箇所棚卸し、textContent/DOM API化、sanitize、CSP導入。 |
| High | プロンプトインジェクション | メール/議事録/PDF/Web/A2A由来テキストからツール実行指示が混入し得る。 | 外部文書を信頼しないsystem設計、ツール前policy check、危険操作承認、外部入力の引用境界表示。 |
| Medium | SSRF残余 | URL構文上の拒否はあるがDNS解決後IP検査ができない。 | allowlistまたは顧客URL登録時の所有確認、カスタムドメイン固定、redirect manual継続。 |
| Medium | 長期token漏えい | Google refresh token、LINE token、Cloudflare/GitHub tokenは強い権限を持つ。 | 最終利用表示、権限スコープ説明、失効、ローテーション、異常検知、Secret優先。 |
| Medium | ローカルパスワード認証 | PBKDF2は実装済みだが、2FA/レート制限/ロックアウトは読み取れない。 | ログイン試行制限、2FA、招待コード強度、監査ログを追加。 |

## 7. コスト計算

### 7.1 前提

本事業の強みは、ホスト原価と顧客BYOK/自己ホスト原価を分けられる点です。ただし顧客体験上は、顧客のAPI請求も「baku-office利用コスト」と認識されます。よって製品内での見える化とhard capが重要です。

公式価格確認日: 2026-06-10

| 費目 | 公式価格/条件の要点 |
| --- | --- |
| Cloudflare Workers Paid | 最低 $5/月。標準モデルは月1,000万リクエスト込み、超過リクエスト/CPU課金あり。 |
| Cloudflare KV | Free/Paidに含まれるが、Paidでは読み取り1,000万/月込み、超過読み取り $0.50/100万、書き込み $5/100万、保存 $0.50/GB-month。 |
| Gemini 2.5 Flash Standard | Paid input $0.30/100万token、output $2.50/100万token。Google Search grounding は無料枠後 $35/1,000 grounded prompts。 |
| Claude Sonnet 4.6 | Base input $3/100万token、output $15/100万token。tool定義/結果もtokenに含まれる。 |

### 7.2 顧客1団体あたりAI費用の概算

以下はAI API費用のみの概算です。Cloudflare、Google Workspace、LINE、Stripe、サポート人件費は別です。為替は変動するためUSDのまま表示します。

| 利用パターン | 月間利用 | Gemini 2.5 Flash概算 | Claude Sonnet 4.6概算 | コメント |
| --- | --- | ---: | ---: | --- |
| Free/軽利用 | AIなし、会計/名簿中心 | $0 | $0 | Cloudflare Free枠で足りる可能性。ただし本番はWorkers Paid推奨。 |
| Plus小規模 | 300回/月、入力3k/output1k | 約 $1.02 | 約 $7.20 | Gemini中心なら低廉。 |
| Plus業務利用 | 2,000回/月、入力5k/output1.5k | 約 $10.50 | 約 $75.00 | 月次hard cap必須。 |
| Proエージェント | 5,000回/月、入力8k/output2k | 約 $37.00 + 検索等 | 約 $270.00 + tool token | 子エージェント/検索/文書処理で増加。 |
| 大PDF/Meet/メディア | PDF、音声、動画、画像生成 | モデル別 | モデル別 | 秒数/画像枚数/検索回数の別capが必要。 |

計算式:

- Gemini小規模: 300 * 3,000 / 1,000,000 * 0.30 + 300 * 1,000 / 1,000,000 * 2.50 = $1.02
- Gemini業務: 2,000 * 5,000 / 1,000,000 * 0.30 + 2,000 * 1,500 / 1,000,000 * 2.50 = $10.50
- Claude小規模: 300 * 3,000 / 1,000,000 * 3 + 300 * 1,000 / 1,000,000 * 15 = $7.20

### 7.3 現状実装との整合

`usage.ts` は `input_tokens`、`output_tokens`、`est_usd`、`units` を記録し、`monthlyUsdCap` による停止判定も持ちます。これは旧来の回数ベースより大きな改善です。

残課題:

- Gemini/Claude単価がコード固定で、価格改定やモデル移行に弱い。
- `preflight.ts` は `monthlyCap` をtoken予算として扱うような文言だが、現在の集計関数は回数ベースも残っている。
- Web検索、画像、音声、動画、Google/LINE/Stripe、Cloudflare KV/R2の従量単位を統一的にUSD換算する仕組みが未完成。
- Claude tool use はツール定義とツール結果もinput tokenに含まれるため、ツール数が多いほど費用が増える。

## 8. 優先対応ロードマップ

### Phase 0: 一般公開前の必須ゲート

1. CIで `typecheck`、test、build、依存監査、release署名検証を必須化。
2. 署名鍵をKMS/HSM相当、複数人承認、ローテーション、監査ログで保護。
3. `innerHTML` 全箇所のXSS監査と修正。CSP導入。
4. Google Workspace Restricted scopes の運用方針を決定。内部アプリ/BYOGCPと公開OAuthアプリを分けて案内。
5. 外部送信一覧、プライバシーポリシー、AI利用注意、禁止用途、事故時責任分界を整備。
6. モデルID/価格/capを設定化し、価格改定や廃止に追随できるようにする。
7. AIプロンプトインジェクション対策をsystem promptだけに頼らず、ツール実行前のpolicy layerとして実装。

### Phase 1: 限定ベータ

1. 5団体以内、機微度の低い業務データから開始。
2. Google Gmail/Meet連携は任意かつ明示同意付き。最初はCalendar中心が望ましい。
3. 対外/破壊的操作は人間承認を既定ONのまま運用。
4. 月次のAI費用cap、1ジョブcap、Web検索/メディアcapを設定してから提供。
5. バックアップ/復旧、鍵紛失、Google token失効、署名鍵ローテーションを演習。

### Phase 2: 商用展開

1. 顧客別セキュリティチェックリストと外部送信台帳を自動生成。
2. AIログ、外部APIログ、承認ログ、A2Aログの検索/エクスポートを整備。
3. アプリストア審査基準、脆弱性通知、撤去、署名検証UIを明確化。
4. 業種別テンプレートを増やし、汎用AI基盤ではなく「所有できる業務OS」として販売する。

## 9. Go/No-Go 判断

| 用途 | 判断 | 条件 |
| --- | --- | --- |
| 社内利用 | Go | 本番Secret、バックアップ、権限管理を整える。 |
| 親しい顧客との限定ベータ | 条件付きGo | データ範囲、免責、外部送信、AI費用上限、人間承認を契約/画面で明示。 |
| 一般公開/本番商用提供 | No-Go寄り | Phase 0の完了後に移行。特にGoogle Restricted scopesと署名鍵運用がゲート。 |

最も重要な経営判断は、短期の機能追加よりも「所有モデルを信用できるだけの統制」を優先することです。baku-officeの価値は機能の多さだけではなく、「ホストが業務データを持たず、顧客がAI基盤を所有できる」という約束にあります。この約束を守るための鍵管理、外部送信透明性、監査、コスト制御、Google審査対応に投資すべきです。

## 10. 参照資料

### リポジトリ内資料

- `README.md`
- `ARCHITECTURE.md`
- `OPERATIONS.md`
- `docs/spec/04_threat-model.md`
- `apps/client/src/lib/client.ts`
- `apps/client/src/lib/google.ts`
- `apps/client/src/lib/usage.ts`
- `apps/client/src/lib/storage.ts`
- `apps/client/src/lib/approvals.ts`
- `apps/client/src/lib/agent.ts`
- `apps/client/src/lib/preflight.ts`
- `apps/client/src/lib/a2a-actions.ts`
- `apps/host/src/lib/host.ts`
- `apps/host/src/lib/a2a.ts`
- `apps/host/src/lib/registry.ts`
- `packages/shared/src/crypto.ts`
- `packages/shared/src/license.ts`

### 外部公式資料

- Cloudflare Workers Pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Workers KV Pricing: https://developers.cloudflare.com/kv/platform/pricing/
- Gemini Developer API Pricing: https://ai.google.dev/gemini-api/docs/pricing
- Claude API Pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Gmail API Scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Google Workspace API User Data and Developer Policy: https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- Google Restricted Scope Verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- 個人情報保護委員会「生成AIサービスの利用に関する注意喚起等について」: https://www.ppc.go.jp/news/careful_information/230602_AI_utilize_alert/
- 個人情報保護委員会「外国にある第三者への提供編」: https://www.ppc.go.jp/personalinfo/legal/guidelines_offshore/
- 経済産業省「AI事業者ガイドライン 第1.2版」: https://www.meti.go.jp/shingikai/mono_info_service/ai_shakai_jisso/20260331_report.html
