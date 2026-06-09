# baku-office 第三者評価報告書

作成日: 2026-06-10  
対象: `baku-office` リポジトリ一式  
評価観点: 技術、法的、倫理、セキュリティ、コスト計算  
立場: 外部レビュー相当の第三者視点  

> 注意: 本報告書は事業・技術・リスク評価であり、弁護士・公認会計士・税理士による正式な法務/税務意見ではありません。本番提供前には、利用規約、プライバシーポリシー、委託契約、個人情報保護、決済、AI利用に関する専門家レビューを推奨します。

## 1. 総合評価

結論として、baku-office は「顧客が自社クラウドにAI業務基盤を所有する」という事業仮説が明確で、既存SaaSとの差別化も強いです。特に、ホストが顧客の業務データを保持しない自己ホスト型、Ports & Parts による移植性、署名付きライセンス/配布、AIアプリ作成前の4確認という設計は、技術面でも事業面でも筋が良いです。

一方で、現時点の完成度は「MVPから本番商用化へ進む直前」です。最大のボトルネックは、鍵管理、Google Workspaceの制限スコープ、AIエージェントの暴走/誤操作対策、コスト管理の精度、法務文書と運用統制です。これらを未解消のまま顧客の本番業務データを扱うと、事故発生時の説明責任と補償負担が重くなります。

推奨判定:

| 項目 | 評価 | コメント |
| --- | --- | --- |
| 事業性 | A- | 「自社所有AI業務基盤」は訴求力が高い。非営利/小規模団体/士業/地域企業向けに刺さる可能性がある。 |
| 技術実現性 | B+ | 構成は妥当。ポータブルコアの方向性も良い。ただし本番運用の成熟度は要強化。 |
| 法務適合性 | B- | 自己ホストによりホスト側の個人情報保有を抑える設計は強いが、AI/APIへの外部送信、Google制限スコープ、規約整備が課題。 |
| 倫理/AIガバナンス | B | 4確認や権限チェックは好材料。人間による承認、説明、ログ、異議申立てを製品体験に組み込む必要がある。 |
| セキュリティ | B- | 脅威モデルと改善履歴は良い。MASTER_KEYのKV自動生成、OAuth refresh token、サプライチェーン、コストDoSが残る。 |
| コスト管理 | C+ | BYOKと自己ホストで原価転嫁しやすいが、現実のAI費用はトークン/ツール単位。実装上の使用量管理は回数ベース中心で不足。 |

総合判定: **限定ベータ提供は可。本番商用提供は「鍵管理、OAuth、AIコスト上限、規約/同意、監査ログ」の5点をゲート化してからが望ましい。**

## 2. 評価対象の理解

本リポジトリは、以下の複数アプリから成るモノレポです。

- `apps/host`: ホストポータル。申込、ライセンス、課金、通知、アプリ承認、A2A中継、報告集積。
- `apps/client`: 顧客が自分のCloudflareアカウントへ配備する業務アプリ本体。
- `apps/apply`: 申込導線。
- `apps/scheduler`: Cloudflare Cron Triggers による巡回/自己修復補助。
- `packages/shared`: 暗号、ライセンス、型、GitHub連携等の共有コード。

中核コンセプトは「ホストはライセンス/配信/課金/サポートを担い、顧客業務データは顧客Cloudflare内に残す」ことです。AI、会計、名簿、ファイル、Google Workspace、A2A、外部アプリ、AIによるアプリ草案生成まで含む広い業務基盤として設計されています。

## 3. 技術評価

### 3.1 強み

- **自己ホスト型の信頼境界が明確**  
  READMEと設計書では、ホストが顧客の業務データ/PII/APIキーに到達しない構造を明示しています。これは、一般的なマルチテナントSaaSよりもプライバシー訴求が強いです。

- **Ports & Parts 設計が良い**  
  `SqlStore`、`StoragePort`、`AiPort`、`AgentPort`、`IdentityPort` により、Cloudflare依存を薄くしようとしています。Node + SQLite テストで移植性を検証する方針も妥当です。

- **セキュリティ改善の履歴が残っている**  
  脅威モデルには、無認証活性化、SSRF、A2Aリプレイ、管理者セッション、Webhook署名、セッション署名鍵の用途分離などへの対応が記録されています。セキュリティ設計を後付けではなく継続管理している点は高く評価できます。

- **機能追加の前に4確認を置く思想が良い**  
  `preflight.ts` で環境、権限、安全、コストを確認し、AIにいきなり実装させない構造があります。AIアプリ開発をプロダクトにするなら必須のガードです。

### 3.2 技術的な懸念

| 重要度 | 懸念 | 根拠/該当箇所 | 推奨 |
| --- | --- | --- | --- |
| 高 | 実行環境前提が未確認 | このレビュー環境では `npm`/`node` が無く、`npm run typecheck` と `npm -w apps/client run test` が実行不能。`bun` は存在するが既存スクリプトは `npm`/`node` 前提。 | CIで `typecheck`、全テスト、依存監査、ビルドを必須化。READMEに必要Node/npmバージョンを明記。 |
| 高 | コスト管理の単位が実費とズレる | `usage.ts` は回数カウント中心。一方 `preflight.ts` は token 予算のように表示。AI費用は入力/出力token、画像/音声/動画秒数、検索グラウンディング等で変動。 | provider別に `input_tokens`、`output_tokens`、`tool_units`、`estimated_usd` を保存。モデル応答のusageを必ず記録。 |
| 高 | MASTER_KEY のKV自動生成が本番リスク | `client.ts` で `MASTER_KEY` 未設定時に `LICENSE` KVへ自動生成。暗号文と鍵が同居し、Cloudflareアカウント侵害時に暗号化が実質無効化する。 | 本番は Worker Secret または Secrets Store 必須。KV自動生成はdev/test限定か、初回起動時に重大ブロック。 |
| 中 | Google Workspace scope が一括かつ広い | `google.ts` で `calendar.events`、`gmail.modify`、`gmail.send`、Meet系を一括要求。 | 用途別OAuth分割。閲覧のみ、送信あり、Meetあり等で段階同意。管理画面でscopeとリスクを表示。 |
| 中 | AIツール宣言が増えるほどコスト/誤実行が増える | `agent.ts` は有効パーツ、Core tools、Gemini/Claude、A2A、autonomy、capabilitiesをまとめて提示。 | ツール選択を文脈別に最小化。危険操作は確認トークン、2段階承認、dry-runを既定化。 |
| 中 | ファイル保存の暗号化が限定的 | `storage.ts` はR2/KV保存を行うがファイル本体のアプリ層暗号化は見えない。 | Google/請求書/議事録等は保存時暗号化、保持期限、削除ジョブ、エクスポート制御を実装。 |

## 4. 法的評価

### 4.1 個人情報保護法

自己ホスト型により、ホストが顧客の業務データを持たない設計は、個人情報保護上のリスクを抑えます。ただし、法的には「ホストが保有しない」だけでは十分ではありません。

主な論点:

- 顧客は会員名簿、領収書、Gmail本文、Meet議事録、請求書などを扱うため、個人情報取扱事業者として安全管理措置、利用目的、第三者提供、委託先管理、開示/削除対応が必要。
- Gemini/Claude/Google/LINE/Stripe/Cloudflare等に個人データが送信される場合、第三者提供または委託/外部サービス利用として整理が必要。
- 外国にある第三者への提供が発生する場合、本人への情報提供や同意、または相当措置の継続的確保の整理が必要。PPCの外国第三者提供ガイドラインは、令和7年12月一部改正のものが公開されています。
- PPCは生成AIサービス利用に関する注意喚起を出しており、個人情報をプロンプトへ入力する場合の利用目的、本人同意、安全管理の整理が必要です。

推奨:

- 顧客向けに「利用者が入力/連携するデータの外部送信先一覧」を管理画面と規約に表示する。
- プライバシーポリシー雛形ではなく、顧客自身が公開できる「外部送信・AI利用・保存期間・削除方法」テンプレートを提供する。
- Google/Anthropic/Google Gemini等のデータ利用条件について、無料枠と有料枠で学習利用の扱いが異なる点を明示する。

### 4.2 Google Workspace API

Gmail本文や添付、メタデータを読み書きするスコープは Google Workspace の Restricted scopes に該当します。Googleのポリシーでは、必要最小限の収集、同意、透明な開示、データ管理手段、暗号化や適切な鍵管理が求められます。

現状の `google.ts` は `gmail.modify` と `gmail.send` を含むため、公開アプリとして広く提供する場合はOAuth審査、場合によってはセキュリティ評価の負担が発生する可能性があります。

推奨:

- Google連携は当初「顧客自身の内部アプリ」として案内し、外部公開OAuthアプリ化の要否を分ける。
- Gmail読み取り、Gmail送信、Calendar、Meetを分離し、必要な顧客だけが必要なscopeを有効にする。
- `google_refresh` はクラウンジュエルとして扱い、MASTER_KEY Secret必須、失効ボタン、最終使用日時、連携ログを実装する。

### 4.3 AIガイドライン/AI Act

日本では、経済産業省/総務省の「AI事業者ガイドライン 第1.2版」が2026年時点の最新版として公開されています。baku-officeは自社で基盤モデルを開発するサービスではなく、主にAIシステムの提供/利用支援に該当します。そのため、リスク管理、透明性、安全性、公平性、人間中心、説明責任を製品運用に落とすことが重要です。

EU向けに提供する場合、AI Actの対象になり得ます。特に採用、教育、信用、行政、医療等の高リスク用途に顧客がbaku-officeを転用できるため、「禁止/高リスク用途には使わせない」または「用途別に追加義務を満たす」設計が必要です。

推奨:

- 利用規約で禁止用途と高リスク用途を明確化。
- AI出力は参考情報であり、会計/契約/雇用/医療等の判断は人間承認を必須化。
- AIアプリの公開申請に、用途分類、対象データ、外部送信、予想される不利益、説明可能性を追加。

## 5. 倫理評価

良い点:

- AIが作業前に企画/仕様と4確認を行う思想は、人間中心のガバナンスに近い。
- ロール権限、招待承認、A2A同意、公開アクションのスコープ制御など、勝手に何でもできるAIにしない設計がある。
- 自己ホストにより、顧客データの集中保有を避ける倫理的メリットがある。

懸念:

- AIエージェントがGmail、Calendar、Meet、会計、請求書、A2Aを横断すると、誤操作や過剰共有の被害が大きくなる。
- 個人コンテキストは組織管理者が閲覧可能という設計だが、利用者に十分伝わらないと「個人用」と誤認される。
- AI生成アプリ/スキルが組織内の差別、監視、評価、懲戒、人事判断に使われる可能性がある。
- 生成AIの出力による著作権、誤情報、名誉毀損、機密漏えいの責任分界が未整理だと、事故時にホストの責任を問われやすい。

推奨:

- 初回オンボーディングで「個人領域は私的空間ではない」と明示。
- エージェントの破壊的/対外的操作は、原則として人間承認、操作プレビュー、取り消し可能性を付ける。
- AI生成物には監査ログ、作成者、モデル、入力データ種別、外部送信有無を残す。
- AIアプリ公開時に「人事/信用/医療/行政/児童/金融助言」などの高リスク用途チェックを必須化する。

## 6. セキュリティ評価

### 6.1 良い設計

- Ed25519署名によるライセンス/配布検証。
- ホスト署名relayによるアクティベーション。
- 管理者Cookieの本番 `ADMIN_KEY` 必須化。
- A2Aの署名、期限、nonceによるリプレイ対策。
- SSRF対策として `deploy_url` のhttps必須、credentials拒否、内部ホスト名/IP拒否、redirect manual。
- LINE webhook署名、Stripe webhook鮮度と署名検証。
- セッションHMAC鍵をMASTER_KEYからHKDF分離。
- ホスト側監査ログとアプリキルスイッチ。

### 6.2 主要リスク

| 重要度 | リスク | 説明 | 推奨対応 |
| --- | --- | --- | --- |
| Critical | 署名鍵/管理者権限の侵害 | 全顧客への毒配信、ライセンス偽造、アプリ統制の悪用につながる。 | KMS/HSM、FIDO2、複数人承認、署名鍵ローテーション、署名イベント監視、break-glass手順。 |
| Critical | 顧客側 `MASTER_KEY` と暗号文の同居 | KV侵害時、APIキー/PII暗号化の価値が落ちる。 | 本番Secret必須。KV自動生成は評価用に限定。 |
| High | Google refresh token の漏えい | Gmail/Calendar/Meetへの永続アクセスに直結。 | scope分割、Secret必須、失効、ローテーション、最終利用表示、異常検知。 |
| High | AIプロンプトインジェクション | Gmail本文、Meet文字起こし、PDF、外部Web、A2A相手から指示混入が起きる。 | 外部テキストを常に untrusted data として隔離。ツール実行前のポリシー判定と人間承認。 |
| High | サプライチェーン | 公開配布バンドル、GitHub Actions、依存、難読化、リリース署名が攻撃面。 | SBOM、lockfile検証、依存監査、SLSA相当、段階配信、顧客側検証UI。 |
| Medium | コストDoS | 巨大入力、PDF/音声/動画、ツールループ、A2A連鎖で顧客のAPI費用が膨らむ。 | token/秒/検索回数/動画秒数ベースのhard cap。日次/ジョブ単位上限。 |
| Medium | SSRFの残余 | `isSafeDeployUrl` はDNS rebindingを完全には防げない旨がコメントにある。 | DNS解決後IP検査、固定 allowlist、Service Binding優先、A2A先検証の定期再評価。 |

## 7. コスト計算

### 7.1 前提

この事業は、原価構造を「ホスト負担」と「顧客BYOK/自己ホスト負担」に分けられる点が強みです。ただし、AI機能を使い始めると、顧客のAPIキー側に従量課金が発生します。ホストはその費用を直接負担しなくても、顧客体験上は「baku-officeが高い」と見られるため、製品内での見える化が必須です。

参照価格の例:

- Cloudflare Workers Paid はアカウントあたり最低 $5/月。Freeには限定的なWorkers/KV等の利用枠がある。
- コード上のGemini標準モデルは `gemini-2.5-flash`。2026年6月時点の公式価格では、Paid Standardで入力 $0.30/100万token、出力 $2.50/100万token、Google Search grounding は無料枠後 $35/1,000 grounded prompts。
- コード上のClaude資料生成は `claude-sonnet-4-6`。Anthropic公式価格では通常APIが入力 $3/100万token、出力 $15/100万token、Batchが入力 $1.50/100万token、出力 $7.50/100万token。ツール利用時はツール定義/結果もtokenに含まれる。
- Stripe Japanは標準決済手数料のほか、請求書/税務/Managed Payments等の追加サービスで別料金が発生し得る。

### 7.2 顧客1団体あたりの概算

為替は変動するため、USDはそのまま表示します。ここではAIのみ概算します。

| 利用パターン | 月間利用 | Gemini 2.5 Flash概算 | Claude Sonnet概算 | コメント |
| --- | --- | ---: | ---: | --- |
| Free/軽利用 | AIなし、会計/名簿中心 | $0 | $0 | Cloudflare Free枠で足りる可能性。 |
| Plus小規模 | 300回/月、1回あたり入力3k/output1k | 約 $1.02 | 約 $7.20 | Geminiなら低廉。Claudeは文書生成/高精度用途に限定推奨。 |
| Plus業務利用 | 2,000回/月、入力5k/output1.5k | 約 $10.50 | 約 $75.00 | token計測と月次capが必須。 |
| Proエージェント | 5,000回/月、入力8k/output2k、子エージェント/検索あり | 約 $37+検索費 | 約 $270+追加tool token | マルチエージェント、Web検索、大PDF、音声で急増。 |
| メディア/動画 | 画像/音声/動画生成を利用 | モデル別 | モデル別 | 動画は秒単価で跳ねるため、別cap必須。 |

計算例:

- Gemini 2.5 Flash: 300回 × 入力3,000token = 0.9M token × $0.30 = $0.27。300回 × 出力1,000token = 0.3M token × $2.50 = $0.75。合計約 $1.02。
- Gemini 2.5 Flash: 2,000回 × 入力5,000token = 10M token × $0.30 = $3.00。2,000回 × 出力1,500token = 3M token × $2.50 = $7.50。合計約 $10.50。ただしキャッシュ、thinking、画像/音声、検索で変動。
- Claude Sonnet 4.6 通常API: 300回 × 入力3,000token = 0.9M token × $3 = $2.70。300回 × 出力1,000token = 0.3M token × $15 = $4.50。合計約 $7.20。

### 7.3 収益モデル上の注意

- Freeプランを完全無料で出す場合、サポートとオンボーディングの人件費が先に重くなります。Freeは「データ所有体験」と「導入検証」に限定し、AI/エージェント/Google連携/サポートを有料化するのが自然です。
- Plus/Proの価格は、顧客が別途支払うCloudflare/Google/Anthropic/LINE等の費用を明示したうえで設定する必要があります。
- 顧客BYOKは原価リスクを下げますが、設定難易度が上がります。オンボーディング支援、監視、バックアップ、Google審査支援を有料メニューにできます。
- 自己ホスト型は「解約後もデータが残る」価値がある一方、ライセンス回避は完全には防げません。価格設計は、ソフトウェア利用権よりも更新、署名済みアプリ、監査、サポート、テンプレート、導入支援に価値を置くべきです。

## 8. 優先対応ロードマップ

### Phase 0: 本番前必須ゲート

1. `MASTER_KEY` を本番Secret必須にする。KV自動生成はdev/test限定。
2. 署名鍵/管理者権限をKMS、MFA/FIDO2、複数人承認、監査ログで保護。
3. Google OAuthをscope分割し、`gmail.modify`/`gmail.send` の必要性を顧客単位で明示。
4. AI使用量をtoken/秒/画像/検索単位で記録し、hard capを実装。
5. 利用規約、プライバシーポリシー、外部送信一覧、AI利用注意、禁止用途を整備。
6. CIで `typecheck`、テスト、ビルド、依存監査、リリース署名検証を必須化。

### Phase 1: 限定ベータ

1. 5団体以内、業務データの機微度が低い顧客に限定。
2. Google連携は任意かつ明示同意付き。
3. AIエージェントは人間承認付き操作に限定。
4. 週次でコスト、エラー、診断、ヒヤリハットをレビュー。
5. バックアップ/復旧手順を顧客と共同演習。

### Phase 2: 商用展開

1. 顧客別のセキュリティチェックリストを自動生成。
2. 監査ログ/AIログ/外部送信ログの検索とエクスポート。
3. アプリマーケットの審査基準、署名、撤去、脆弱性通知制度を整備。
4. Google restricted scopes 審査/セキュリティ評価の体制化。
5. 業種別テンプレートを増やし、汎用AI基盤ではなく「所有できる業務OS」として販売。

## 9. Go/No-Go 判断

現時点での判断:

- **社内利用**: Go。自社検証として十分価値がある。
- **親しい顧客との限定ベータ**: 条件付きGo。契約、免責、データ範囲、手動承認、コスト上限を明確にすること。
- **一般公開/本番商用提供**: No-Go寄り。Phase 0の必須ゲートを終えるまで待つべき。

最も重要な経営判断は、「顧客が所有するAI基盤」という強みを守るために、短期の機能追加よりも、鍵管理、OAuth、監査、コスト可視化、法務テンプレートに投資することです。この部分を固めると、競合との差別化はかなり強くなります。

## 10. 参照資料

### リポジトリ内資料

- `README.md`
- `ARCHITECTURE.md`
- `docs/spec/integrated_design_package_v1.0.md`
- `docs/spec/04_threat-model.md`
- `apps/client/src/lib/client.ts`
- `apps/client/src/lib/google.ts`
- `apps/client/src/lib/agent.ts`
- `apps/client/src/lib/preflight.ts`
- `apps/client/src/lib/usage.ts`
- `apps/client/src/lib/storage.ts`
- `apps/host/src/lib/a2a.ts`
- `apps/host/src/pages/api/check.ts`

### 外部参照

- Cloudflare Workers Pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Gemini Developer API Pricing: https://ai.google.dev/gemini-api/docs/pricing
- Claude API Pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Google Workspace API User Data and Developer Policy: https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- 個人情報保護委員会「生成AIサービスの利用に関する注意喚起等について」: https://www.ppc.go.jp/news/careful_information/230602_AI_utilize_alert/
- 個人情報保護委員会「外国にある第三者への提供編」: https://www.ppc.go.jp/personalinfo/legal/guidelines_offshore/
- 経済産業省「AI事業者ガイドライン 第1.2版」: https://www.meti.go.jp/shingikai/mono_info_service/ai_shakai_jisso/20260331_report.html
- Stripe Japan Pricing: https://stripe.com/jp/pricing

## 11. 検証メモ

- `npm run typecheck`: 実行不能。この環境に `npm` が存在しない。
- `npm -w apps/client run test`: 実行不能。この環境に `npm`/`node` が存在しない。
- `bun --version`: `1.3.13` を確認。ただし既存 `typecheck` スクリプトは内部で `npm` を呼ぶため失敗。
