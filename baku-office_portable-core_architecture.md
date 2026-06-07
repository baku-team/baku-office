# ポータブルコア＋パーツ設計（移植性アーキテクチャ）

> 設計思想：**コア（DB・ストレージ・AI・エージェント）をあらゆる環境へ移植可能にし**、その上に
> **パーツ（会計・庶務・組織ナレッジ・議事録 等の機能）や外部API を連動**させることで、
> 各団体にとって使いやすい**専用ツールとして振る舞わせる**。コアの移植性そのものを資産価値とし、
> 両極端——「外部依存ゼロの完全自己完結」⇄「全部クラウド依存でスマホ一台」——を同一コードで成立させる。

---

## 0. 用語と原則

- **コア（基盤）**：移植対象。**DB／ストレージ／AI／エージェント**の4能力。ドメイン知識（会計の仕訳ルール等）
  は持たず、純粋に「保存する・置く・推論する・道具を束ねて動かす」基盤に徹する。
- **パーツ（機能モジュール）**：団体ごとに可変する部分。**会計・庶務・組織ナレッジ・議事録・名簿・
  リマインダー**…等。コアの能力＋外部APIを使って具体的な業務機能を提供する“差し替え可能な部品”。
- **環境アダプタ（移植の境界）**：コアを CF／ローカル／別クラウド等で動かすための実装差し替え層。

原則：
1. **コアは外部依存ゼロ**。Port（インターフェース）にのみ依存し、特定基盤や外部APIを直接触らない。
2. **「依存なし」を必須にしない**。フルクラウド依存も第一級。依存は“選べる”もの。
3. **コアは薄く、ドメインはパーツへ**。業務ロジックは必ずパーツ側に置き、コアに業務を埋め込まない。
4. **過度な抽象化をしない**。実在2〜3環境を通す最小限のPortとPartコントラクトに留める。
5. **挙動不変で段階移行**。既存実装を“そのまま包む”ところから始める（作り直しでなく括り直し）。

---

## 1. 三層モデル

```
┌──────────────────────────────────────────────────────────────┐
│  パーツ（団体ごとに可変）                                          │
│   会計 / 庶務 / 組織ナレッジ / 議事録 / 名簿 / リマインダー / …       │
│   ・各パーツ＝ データスキーマ＋業務ロジック＋UI＋エージェント道具＋外部API  │
│      ↓ コアの能力APIにのみ依存（DB/ストレージ/AI/エージェント）          │
├──────────────────────────────────────────────────────────────┤
│  ★ ポータブルコア（あらゆる環境へ移植）                              │
│   DB        ストレージ      AI            エージェント               │
│   保存・問合せ ファイル/KV/Blob 推論(chat/転写/埋込) 道具を束ねて実行・対話 │
│      ↓ Port（環境アダプタ）にのみ依存                                │
├──────────────────────────────────────────────────────────────┤
│  環境アダプタ（移植の境界）                                         │
│   SQL  Blob/KV  AIプロバイダ  認証  ライセンス  チャネル  ランタイム      │
│   D1/SQLite/…  R2/FS/S3/…  外部API/ローカルLLM  …    LINE/LAN  Workers/Node │
└──────────────────────────────────────────────────────────────┘
   団体ごと＝（環境Profile）×（有効化するパーツ）×（連動する外部API）＝専用ツール
```

- パーツはコアの**能力API**にのみ依存し、環境（CFかローカルか）を知らない。
- コアは**環境アダプタ（Port）**にのみ依存し、業務（会計のルール等）を知らない。
- 団体ごとの“専用ツール”は、環境Profile・有効パーツ・外部API の**組み合わせ**で決まる。

---

## 2. ポータブルコア（4つのコア能力）

各能力は上位（パーツ）へ綺麗なAPIを見せ、下位は環境アダプタ（§3）へ委譲する。

### 2.1 DB（データ）
- 役割：パーツのデータ保存・問い合わせ・スキーマ適用（追加のみマイグレーション・冪等）。
- API例：`db.query(sql,params)` / `db.batch()` / `db.applyMigrations(part)` / `db.dump()/load()`。
- 現行：`env.DB`(D1) 直参照、初回リクエスト時の `ensureSchema`。

### 2.2 ストレージ（ファイル/KV/Blob）
- 役割：ファイル・添付・設定値・セッション等の保存。
- API例：`kv.get/put/delete/list` ／ `blob.get/put/delete`。
- 現行：`src/lib/storage.ts` の `storageMode(env):"r2"|"kv"`、`getFile/saveFile`、`env.LICENSE/MEDIA/MEDIA_R2`。
  **R2↔KV を分岐する継ぎ目が既に存在**。

### 2.3 AI（推論）
- 役割：チャット（道具呼び出し対応）・音声転写・（任意）埋め込み・（任意）Web検索。
- API例：`ai.chat(messages,tools?)` / `ai.transcribe(audio)` / `ai.embed?(text)` / `ai.webSearch?(q)` / `ai.capabilities`。
- 現行：`src/lib/media-ai.ts`（Gemini Files/転写/grounding）、鍵は `client.ts` の `getApiKey`。
  AIは**外部HTTPS API前提**（Workers AI 不使用）＝どの環境でも fetch で同一に動く。

### 2.4 エージェント（オーケストレーション）
- 役割：AI の道具呼び出しループを回し、**パーツが登録した道具（tools）**を実行し、チャネル越しに対話する。
  **道具・能力レジストリ**を持ち、ここにパーツがプラグインする。
- API例：`agent.run(input,ctx)` / `agent.registerTool(tool)` / `agent.registerPart(part)`。
- 現行：`src/lib/agent.ts`（function-calling ループ）、`agent-tools.ts`（`list_expenses`／`save_knowledge`／
  `search_members`／`list_reminders`…）。**これらの道具は本来それぞれ会計・ナレッジ・庶務・リマインダーの
  “パーツ”が提供すべきもの**＝エージェントはコア、道具はパーツ、という分離の実証。

> 暗号（MASTER_KEY・Ed25519検証・暗号化）は Web Crypto の純粋関数としてコアユーティリティに留める
> （Port化不要・Workers/Node 双方で同一動作）。

---

## 3. 環境アダプタ（コアを各環境へ移植する境界＝Port）

コアの各能力を実環境に接続する。Port は最小限に限定する。

| Port | 支える能力 | CF | 自己完結 | クラウド/別基盤 |
|---|---|---|---|---|
| SqlStore | DB | D1 | SQLite | libSQL/Turso |
| Kv / Blob | ストレージ | KV / R2 | ローカルストア / FS | Upstash / S3互換 |
| AiProvider | AI | 外部API(Gemini/Claude) | ローカルLLM(OAI互換)+Whisper / None | 外部API |
| Identity | （横断） | Portal+OAuth | ローカル(pass/passkey・LAN) | クラウドIdP |
| Licensing | （横断） | Portal | 署名永続 / None | Portal |
| Channel | エージェント入出力 | LINE/Discord(要公開受口) | LAN内チャットUI / None | LINE/Discord |
| Runtime/Scheduler | 全体 | Workers＋Cron/外部ping | workerd / Node+Miniflare＋OS cron | 任意 |

- 現行の `env.d.ts`：`DB/LICENSE/MEDIA/MEDIA_R2/HOST_BASE_URL/HOST/GOOGLE_*/LINE_LOGIN_*/DISCORD_*/
  INTERNAL_KEY` が、上表の各 Port に対応。**認証は未設定時 dev/local フォールバックの種が既にある**。
- 定期実行は `scheduled()` 不使用で **`/api/cron/drain` を外部トリガ**＝既にポータブル。

---

## 4. パーツ（団体ごとに可変する機能モジュール）

パーツ＝「データスキーマ＋業務ロジック＋UI＋エージェント道具＋（任意）外部API」をひとまとめにした部品。

```ts
interface Part {
  id: string; name: string; version: string;
  migrations?: Migration[];          // 自分のテーブル（追加のみ・冪等）。id は `<partId>_<seq>` で名前空間化（§14-4）
  routes?: Route[];                  // 画面/APIエンドポイント
  agentTools?: AgentTool[];          // コアのエージェントに登録する道具（認可メタ必須・§14-1）
  needs?: { ai?: Capability[]; externalApi?: string[] }; // 必要なコア能力・外部API
  menu?: MenuItem[];                 // ナビ表示
  onEnable?(ctx): Promise<void>;     // 有効化時の初期化（スキーマ適用等）
}

// 道具は「必要ロール」または明示認可を必ず宣言する。コアは実行前にこれで弾く（§14-1）。
interface AgentTool {
  name: string; description: string; parameters: object;
  requiredRole?: Role[];                       // 例: ["admin","accounting","clerical"]（名簿照会など）
  authorize?(ctx, caller): boolean | Promise<boolean>; // 細粒度が要る場合
  run(ctx, args): Promise<string>;
}
```

パーツはコアの能力（`ctx.db`/`ctx.storage`/`ctx.ai`/`ctx.agent`）と外部APIだけに依存し、環境を知らない。

例（現行コードからの再配置イメージ）：
- **会計**：仕訳/領収書スキーマ＋集計ロジック＋画面＋道具 `list_expenses`。
- **組織ナレッジ**：knowledge スキーマ＋道具 `save_knowledge`/`search_knowledge`。
- **庶務／名簿**：users/members スキーマ＋道具 `search_members`。
- **議事録**：音声→`ctx.ai.transcribe`→要約保存（要約ジョブ drain）＋画面。AI能力を“使う側”の代表。
- **リマインダー**：reminders スキーマ＋道具 `list_reminders`＋drain での配信。

団体ごとに**有効化するパーツの集合**を変えれば、同じコア上で「会計だけの団体」「議事録＋ナレッジの団体」等、
専用ツールとして振る舞う。パーツの追加＝新モジュールの登録、で水平に拡張できる。

---

## 5. 団体ごとの組み立て（Composition）

```
専用ツール(団体X) = 環境Profile(§6)  ×  有効パーツ集合  ×  連動する外部API
```

- **環境Profile**：どこで動かすか（フルクラウド／自宅サーバ／完全オフライン…）。コアの移植先を決める。
- **有効パーツ**：何ができるか（会計・庶務・ナレッジ・議事録…）。団体の業務に合わせて取捨。
- **外部API**：AIプロバイダや各パーツが使う外部サービス。鍵登録で連動／未登録で当該機能オフ。

この3軸が直交しているのが要点。環境を変えてもパーツは無改変、パーツを変えても環境は無改変で動く。

---

## 6. 環境Profile（両極＋中間）

環境アダプタ（§3）の組合せプリセット。パーツとは独立。

- **Profile A：フルクラウド（スマホ一台）**：SqlStore=D1, Storage=KV/R2, AI=外部API, Identity=Portal+OAuth,
  Licensing=Portal, Channel=LINE/Discord, Runtime=Workers。端末は薄く、すべてマネージド依存。最大の手軽さ。
- **Profile B：ハイブリッド（自宅/組織内サーバ）**：Store=ローカルSQLite/FS, AI=外部API(任意ローカル),
  Identity/Licensing=Portal or 署名, Channel=トンネル経由, Runtime=workerd/Node常駐。主権と利便の中間。
- **Profile C：完全オフライン（買い切り）**：Store=暗号化SQLite/FS, AI=ローカルLLM+Whisper,
  Identity=ローカル(pass/passkey), Licensing=署名永続 or None, Channel=LAN内のみ, Runtime=workerd/Node常駐。
  **外部通信ゼロ**。ディスク暗号化＋MASTER_KEY＋自動ローカルバックアップ前提（堅牢性を設計で補う）。

> Profile はアダプタ選択表を表す設定オブジェクト。コアは Profile を知らず、注入された Port 実装で動く。

---

## 7. 現行コードからの括り直しマッピング

| 現行（直接依存） | 行き先 | 作業 |
|---|---|---|
| `env.DB`, `ensureSchema` | コアDB ← SqlStore Port | 直参照を `ctx.db` 経由に。マイグレーションをパーツ単位で適用 |
| `storage.ts` `storageMode`/`getFile/saveFile`, `env.LICENSE/MEDIA/MEDIA_R2` | コアStorage ← Kv/Blob Port | `storageMode` を実装選択に昇格 |
| `media-ai.ts`＋`getApiKey` | コアAI ← AiProvider Port | Gemini/Claude 固有 fetch を実装裏へ。`chat/transcribe/embed/webSearch` で抽象化 |
| `agent.ts` ループ | コアAgent | ループ本体はコアに。道具は登録制に |
| `agent-tools.ts` の各道具 | **各パーツへ移設** | `list_expenses`→会計、`save/search_knowledge`→ナレッジ、`search_members`→庶務、`list_reminders`→リマインダー |
| `auth/*`・`login.ts`・`oauth.ts`（dev/local 種あり） | Identity Port | フォールバックを正式 Local アダプタに昇格 |
| `client.ts` `hostFetch/poll/entitlement/getVerifyJwk` | Licensing Port | オンライン照会と署名検証を分離 |
| `line/webhook.ts`・`lineReply/linePush` | Channel Port | 受口/送出を抽象化、LAN-only/None を追加 |
| `ctx.waitUntil`・`/api/cron/drain` | Runtime/Scheduler Port | Workers 固有を隔離。drain を登録式スケジューラに |
| `import.ts` | データ可搬性（§8） | 全 Store 実装で export/import を契約化 |

注入：`locals.runtime.env` 直参照をやめ、起動時に Profile から組み立てた `ctx`（各能力＝Port実装を保持）を
`locals` に載せ、コア・パーツは `ctx.db/storage/ai/agent` 経由でのみ呼ぶ。

---

## 8. データ可搬性（売却・乗り換えの要）

- SqlStore に `dump()/load()` を必須化し、**全実装で export/import** を成立（D1ダンプ↔汎用SQLite、KV/Blob↔ファイル）。
- パーツのスキーマも含めて丸ごと退避・復元できること＝「データを連れて出られる」を正式機能化。

---

## 9. 適合性テスト（移植性とパーツ互換の“証明”）

- **Port 契約テスト**：各環境アダプタが満たすべき振る舞いを固定（移行コストが読める＝資産価値）。
- **Part 契約テスト**：パーツが「どのコア能力を要求し、何を登録するか」を検証（コア更新で壊れない保証）。
- **最低2リファレンス構成を常時グリーン**：CF版＋「Node+Miniflare+ローカルSQLite」版。
  「2環境で実際に動く」事実が、移植性の最強の証明。

---

## 10. 段階的移行プラン（作り直さない）

- **Phase 1**：4コア能力APIと Port を定義し、**既存実装をそのまま CF アダプタとして包む**（挙動不変・無リスク）。
- **Phase 2**：`agent-tools` の道具を**パーツへ移設**し、パーツ登録制を導入（コア/パーツ分離の実体化）。
- **Phase 3**：2つ目のリファレンス（Node+Miniflare+SQLite）で**アダプタ差し替えが効くこと**を実証。
- **Phase 4**：AiProvider にローカルLLM、Identity にローカル認証を追加 → **Profile C** 成立。
- **Phase 5**：Profile/パーツをプリセット化し、団体ごとの組み立てを設定で選択可能に。
- 各 Phase で Port/Part 契約テストを緑に保つ。

---

## 11. やらないこと（暴走防止）

- コアに業務ロジック（会計ルール等）を埋め込まない。必ずパーツへ。
- Port は最小限。将来の仮想基盤のための投機的な層を作らない。
- コアは Web 標準 API に寄せ、Workers 固有（`waitUntil` 等）は Runtime Port に隔離するだけに留める。

---

## 12. 売却を見据えた付随事項

- **IP/ライセンスの清潔さ**：依存 OSS のライセンス棚卸し、独自IP・キャラクター・第三者素材の権利関係、
  関係する法人・団体との間で「このコード資産の所有主体は誰か」を明確化（デューデリ必須項目）。
- **ドキュメントの資産化**：本設計・脅威モデル・運用・意思決定ログは引き継ぎ価値。
  「ポータブルなコア＋パーツ＋契約テスト＋データ可搬性」が揃った設計は、コードと同等に評価される。
- **単一テナント自己完結コア＋パーツ**は買い手が載せ替えやすい（マルチテナント運用の作り込みより優先）。

---

## 13. 決定待ち

1. 最初に括る対象（推奨：コアStorage／DB＝依存が広く、`storageMode` の足がかりがある）。
2. パーツ移設の先頭（推奨：リマインダー or ナレッジ＝道具が単純で分離効果を早く実証できる）。
3. 2つ目のリファレンス構成（推奨：Node＋Miniflare＋ローカルSQLite）。
4. AiProvider のローカル実装で狙うランタイムと対象モデル。

> 上記が決まれば、4コア能力API・Part コントラクト・CF アダプタの“包み”実装・契約テスト雛形を、
> Phase 1〜2 ぶんから具体コードで書き出せる。

---

## 14. 契約の補強点（移植時のセキュリティ後退・Part横断依存の防止）

レビューで判明した「Port/Part 契約に足りない論点」。これを欠くと移植・パーツ化の過程で既存の防御が抜ける。

### 14-1. エージェント道具の認可を Part 契約に組み込む
- 問題：道具を Part へ移設する際、認可（必要ロール）が道具メタに無いと、現行の `search_members` ロールゲート
  （admin/会計/庶務のみ）が移設で抜け、非権限者が名簿（復号PII）を引ける🔴穴が再発する。
- 対策：`AgentTool` に `requiredRole?` / `authorize?` を必須化（§4）。コアのエージェントは**道具実行の直前に**
  これを評価し、満たさなければ実行せず定型の拒否文を返す。道具の宣言自体をモデルに見せるかも role で絞る。
- 現行の対応点：`agent.ts execTool` のインラインゲート＝この契約の最小実装。Part 移設時はメタへ昇格させる。

### 14-2. ロール解決を独立 Port（Identity）に逃がす（Part横断依存の遮断）
- 問題：ロール判定は庶務/名簿 Part のスキーマ（`users`/`identities`）依存。コアの agent が特定 Part のテーブルを
  直接引くと「コアは業務を知らない」原則（§11）に反し、その Part 無効時に agent が壊れる。
- 対策：`ctx.identity.roleOf(callerRef): Promise<Role>` を Identity Port に置き、agent はそこ経由でのみロールを得る。
  名簿 Part が無い Profile では Identity アダプタが既定ロールを返す（疎結合）。
- 現行の対応点：`webhook.ts` が `memberByExternalId` でロールを解決し `runAgent(...,role)` に渡す形＝既にコア側は
  テーブルを引かず「呼び出し側がロールを供給」している。これを `roleOf` シームとして関数化すれば契約化できる。

### 14-3. MASTER_KEY の「鍵保管」は Kv/Blob Port 越境
- 問題：暗号“演算”は Port 不要のコアユーティリティ（§2 脚注）で正しいが、鍵の**永続先が現状 `env.LICENSE`(KV) 固定**。
  Profile C（オフライン）では保管先が変わる（暗号化ディスク等）ため、KV固定のままだと移植できない。
- 対策：鍵の get/put を Kv/Blob Port 経由に分離（`keyStore.get/put("master_key")`）。演算は不変、保管だけ差し替え可に。
  併せて、KV自動生成フォールバックは「鍵と暗号文の同居」リスクのため本番は Worker Secret 推奨（既存の警告/診断を維持）。

### 14-4. Part 所有マイグレーションの統合規約
- 問題：現行 `migrate.ts` は固定配列＋Vite `?raw` バンドル。Part が自前 `migrations[]` を持つと、コアの runner が
  Part 横断で順序・id衝突を管理する規約が要る。
- 対策：マイグレーション id を **`<partId>_<seq>`** で名前空間化し、`schema_migrations` に Part 単位で記録。適用順は
  「コア → 有効 Part（依存順）」。`ignorable` は限定列挙のまま、失敗は診断記録（既存方針を踏襲）。

### 14-6. UI も「共通ベース＋上書き」で環境・団体ごとに分離（3層）

コア/パーツと同じ思想を UI に適用。共通の画面はそのまま、団体/環境ごとに上書きできる。

- **第1層 テーマ（実行時・団体ごと・コード不要）**：`core/theme.ts`。ブランド名/ロゴ/配色を `ctx.storage.kv` に保存し、
  `App.astro` が head に `:root` 上書きCSSを注入（CSSは既に変数化済み）。色値はサニタイズ（CSSインジェクション防止）。
- **第2層 構成（実行時・団体ごと）**：`core/nav.ts buildNav()`＝共通ナビ＋有効パーツの `Part.menu`＋団体ごと上書き
  （非表示/ラベル/並び替え）を合成。Phase5 の有効パーツ選択と連動。
- **第3層 画面・部品の上書き（配布時・デプロイごと）**：`core/overrides.ts`＋`components/Slot.astro`。
  `src/overrides/<name>.astro` があればベースの `<Slot name="…">` を差し替え（部分上書き）。全面置換は配布バンドルに
  `src/pages/<page>.astro` を同梱（ファイル上書き）。ベース未編集のまま上流更新を取り込める。
- 管理は `api/settings.ts`（`ui_theme`/`nav_overrides`/`enabled_parts`）＋`settings/advanced.astro` のフォーム。
- 線引きは Profile A/B/C と同じ：**第1・2層は単一バイナリで実行時上書き可**、第3層の画面構造置換は配布時構成。

### 14-5. SqlStore Port は SQL 方言サブセットを固定
- 問題：SqlStore は SQL 素通し前提だが、D1 ↔ libSQL/Turso/SQLite は `batch` セマンティクスや一部関数に差がある。
- 対策：Port 契約で**使用してよい SQL サブセット**（標準的な DDL/DML・バインド変数・`INSERT OR IGNORE` 等）を固定するか、
  アダプタ側で正規化する。逸脱は契約テスト（§9）で検出する。

---

## 15. アプリ・プラットフォーム（レジストリ／マーケット・開発・連動・セキュリティ）

パーツ＝**アプリ**を、公開カタログから必要なものだけ導入し、AIで開発でき、相互に連動でき、
かつ baku-office に対する破壊・認証回避は構造的に拒絶する——ノーコードを超える拡張基盤。

### 15-1. レジストリ／マーケットと最小構成
- **マニフェスト**：`Part` に `version`/`category`/`description`/`permissions`/`actions`（[`core/parts.ts`](apps/client/src/core/parts.ts)）。
- **公開カタログ**：`appCatalog()`（[`core/apps.ts`](apps/client/src/core/apps.ts)）。導入集合＝`installedAppIds(ctx)`（KV・`enabled_parts` を流用）。
- **最小構成＝設定のみ**：導入していないアプリは画面・道具とも出ない。設定画面「アプリ（マーケット）」から `install_app`/`uninstall_app` で増減。
- **Plus 以上は AIチャットアプリ必須**（`MANDATORY_APPS=["chat"]`・削除不可）＝設定・開発のハブ。

### 15-2. セキュリティ（破壊・認証回避を構造的に拒絶）
- アプリはコア能力 `ctx`（スコープ済みPort）にのみ触れる。**生 env・署名鍵・認証内部・破壊操作（削除/課金/ライセンス/admin）・他テナントには到達不可**＝列挙された `Permission` の範囲だけ。
- `Permission`：`db:read`/`db:write`/`storage:*`/`ai`/`agent`/`members:read`/`net`。マニフェストで宣言した分のみ付与。
- アプリ間呼び出し（§15-3）は呼び出し元の保有権限を検査して拒否。AI生成アプリは既存スキル同様サンドボックス（Worker内 eval なし）。
- ＝「baku-office 上で動く範囲（CF/ローカルサーバの制限内）」は自由、悪意ある仕組みは作れない。
- （次フェーズ）アプリへ渡す `ctx` から `env` を外した**完全スコープ ctx**、外部送信の allowlist 実体化。

### 15-3. アプリ間連動
- `ctx.apps.list()` / `ctx.apps.call(appId, action, args, caller)`（[`core/apps.ts`](apps/client/src/core/apps.ts)）。
- 各アプリは `actions`（`name`＋`requiredPermission`）を公開。呼び出しは「対象操作の必要権限を呼び出し元アプリが保有しているか」を検査。
- 例：`ctx.apps.call("knowledge","search",{query})`（要 `db:read`）。

### 15-4. 開発（AIでアプリ開発）
- **ランタイム型（再デプロイ不要・推奨の入口）**：チャットから AI に要望→アプリ雛形（manifest＋スキル/宣言設定）を生成→**無効保存→管理者が権限レビューで有効化**（既存 `install_skill` の拡張）。サンドボックス実行。
- **コンパイル型（本格アプリ）**：自リポで AI（Claude/Cursor）で `Part` を実装（`ctx.db/ai/...` 経由）→契約テスト→レジストリへ公開→他団体が導入。
- 既存の Agent Skills／任意API（`capabilities`）が、AIアプリ開発のランタイム土台。

### 15-5. 更新の波及と派生（§14-7 と一体）
- アプリ更新（`version`↑）はコア配布で**導入している全団体に波及**（自動マイグレーション）。
- 既存アプリをコピーし `id` を変えて改変＝**派生で新アプリ**（`derivedFrom`）。元の更新と独立。

### 15-7. ホスト中枢のアプリ管理（存在＋利用状況）

アプリは各リポで作成するが、**ホスト側で「どのアプリが存在し、どこで使われているか」を中枢管理**する。

- **レジストリ（存在）**：`registry_apps`（ホスト D1・`apps/host/migrations/0004_app_registry.sql`）。各リポの公開時にホストへ登録（id/name/version/repo_url/permissions/status=pending→approved/blocked）。`apps/host/src/lib/registry.ts`＋`/api/registry`＋管理画面 `/apps`。
- **利用状況**：クライアントは統合チェック（`/api/check`）の際に**導入アプリ一覧（`id:version`・PIIなし）を申告**。ホストが `app_usage`（license×app×version×last_seen）へ記録し、アプリ別の導入数・版分布・アクティブ数を集計（`usageByApp`）。
- **未登録検知**：レジストリ未登録だが利用申告のあるアプリを管理画面で警告（各リポ確認→登録/承認 or 停止判断）。
- これにより「各リポ作成＋中枢管理（承認・可視化）」が両立。承認制（status）で配布ポリシーを効かせられる。

### 15-8. 署名付き取り込み（外部レジストリ fetch）と AI開発フロー

各リポで作ったアプリを**ホスト中枢レジストリ経由で署名配布**し、クライアントが検証して取り込む。AI開発は「生成→レビュー→公開申請→承認→配布」。

- **署名配布（ホスト）**：承認済みアプリを `signAppPackage`（Ed25519・`SIGNING_JWK`）で署名し `GET /api/registry/fetch?id=` で配布（`/api/registry/list` は承認済みカタログ）。署名対象＝アプリ定義本体（id/name/version/permissions/definition/exp）。
- **検証取り込み（クライアント）**：`lib/external-apps.ts fetchAndInstall` が `VERIFY_PUBLIC_JWK`（ホスト公開鍵）で**署名検証＋鮮度確認**し、`external_apps`（D1）へ保存（ランタイム型・再デプロイ不要）。改竄/未承認/期限切れは拒否。
- **AI開発フロー**：①チャットの `propose_app` 道具が要望から草案（manifest＋permissions＋definition）を生成→`app_drafts`（無効）②管理者が高度なオプション「アプリ開発」で**要求権限をレビュー**③公開申請＝`POST /api/registry/submit`（ライセンス検証）→ホストに pending 登録④ホスト管理者が `/apps` で承認→署名配布対象に。
- **セキュリティ**：配布は署名必須＝改竄不可、承認制＝任意コードの無断流通を防止。取り込んだアプリも宣言 permission の範囲のみ（§15-2）。AI生成の実行はサンドボックス（スキル）。
- **次フェーズ**：定義（definition）の実行ランタイム拡充（宣言的ツール→安全な実体化）、外部リポからの自動公開（CI署名）、アプリ別課金。

### 15-6. フェーズ（本リビジョンの実装範囲）
- **実装済み（基盤スライス）**：マニフェスト/権限、`appCatalog`/導入モデル/最小構成、Plus＝チャット必須、アプリ間API＋権限検査、マーケットUI（高度なオプション）、契約テスト。配信は**ランタイム型中心**。
- **次フェーズ**：外部リポ/パッケージからの取り込み（署名検証付きレジストリ）、AI開発IDE（チャット主導の生成→レビュー→公開）、完全スコープ ctx、外部送信 allowlist、アプリ別課金/配布。
