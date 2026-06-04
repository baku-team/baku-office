# 02. クラウドエージェント — Workers AI + Claude API

LINE（または任意の入力）から渡されたテキストを受け取り、ツールを呼び、応答文を返す
エージェント本体。AI は **2 層だけ** に絞る。

> **運用形態（03）との関係**：本章のコードは単体構成の説明。**新運用形態（ベース）では、この
> オーケストレーションは固定 Worker として顧客アカウントへ事前配備（難読化）し、当社CPが
> ライセンスゲートで配信するのは config（プロンプト/ツール/人格/パラメータ＝データ）のみ**
> （Workers は eval 不可＝コードはエフェメラル配信できず事前配備が前提。03 の 17-2）。
> Anthropic/LINE は顧客が直接呼び、本文は当社を通らない＝非中継。ライセンス無効で config 配信停止＝機能停止。

| 層 | 使うもの | 役割 |
|---|---|---|
| **メインブレイン（必須・BYOK）** | Claude／GPT／Gemini 等から顧客が**1つ設定** | オーケストレーター。対話・推論・ツール選択・最終判断 |
| **能力別プロバイダ（任意・BYOK）** | 画像生成・動画生成・文字起こし(話者分離)・TTS・Web検索 等を**能力ごとに**設定 | ブレインが必要に応じて呼ぶ |
| **無料フォールバック** | Cloudflare Workers AI（`env.AI`） | 埋め込み・基本文字起こし・基本画像・OCR を無料枠で代替 |

> baku-pta の「貘AIゲートウェイ（JWT中継・PIIマスキング）」は持たない。**鍵は顧客の Worker Secrets に置き各プロバイダを直接叩く（非中継・BYOK）。**

## 構成方針：必須メインブレイン＋能力対応オーケストレーション（マルチプロバイダBYOK）

- **メインブレインを必ず1つ設定**（Claude/GPT/Gemini 等・BYOK）。意図解釈・ツール選択・最終応答はブレインが担う。
- **各種能力（capability）は BYOK で差し替え可能**：`image_gen`／`video_gen`／`transcribe`(話者分離)／`tts`／`embed`／`web_search`／`ocr` 等を、**能力ごとにプロバイダを割り当て**（鍵は顧客Secrets・検証済み）。
- **能力対応オーケストレーション**：ブレインには**設定済みの能力だけがツールとして見える**。タスクに必要な能力が **設定済み→BYOKで実行**／**未設定→「未設定です。有効化しますか？」と案内 or Workers AI 無料フォールバック**（対応能力のみ）。
- 詳細な能力レジストリ・ルーティングは 03 の 5-2b。コストレバー：**モデル階層**（既定 Sonnet／簡易 Haiku／難問 Opus、※他ブレインでも同様に難易度で切替）＋**プロンプトキャッシュ**。
- 始め方：まず下記「最小構成（ブレイン単体）」で動かし、能力プロバイダ（Workers AI委譲含む）を足していく。

## 最小構成 — Claude API だけのエージェント

Claude の Tool Use（function calling）でツールを呼び、結果を踏まえて応答させる。

```ts
// src/agent.ts
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-sonnet-4-6"; // 既定。簡易は claude-haiku-4-5、難問は claude-opus-4-8（下記モデル階層）

export async function runAgent(input: string, userId: string, env: Env): Promise<string> {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // 会話履歴を KV から復元（直近 10 ターン）
  const history = await loadHistory(userId, env);

  const messages = [...history, { role: "user" as const, content: input }];

  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  });

  // ツール呼び出しがあれば実行 → 結果を返して最終応答を得る
  // 暴走防止：1ターンのツール連鎖に必ずハード上限を置く（fail-safe to STOP・03 16-11）
  const MAX_STEPS = 8;
  let steps = 0;
  while (response.stop_reason === "tool_use") {
    if (++steps > MAX_STEPS) {                       // 回数上限で打切り
      return "処理が長くなったため中断しました。条件を絞ってお試しください。";
    }
    if (await overBudget(userId, env)) {             // per-turn / 月次コスト予算で打切り（5-3）
      return "本日のご利用上限に達しました。管理者へご連絡ください。";
    }
    const toolResults = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const result = await executeTool(block.name, block.input, userId, env);
        toolResults.push({
          type: "tool_result" as const,
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
    }
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({       // 失敗時はリトライ上限＋バックオフ＋サーキットブレーカ
      model: MODEL, max_tokens: 1024, system: SYSTEM_PROMPT, tools: TOOLS, messages,
    });
  }

  const text = response.content.filter((b) => b.type === "text").map((b: any) => b.text).join("\n");

  await saveHistory(userId, [...messages, { role: "assistant", content: text }], env);
  return text;
}
```

> `@anthropic-ai/sdk` は Workers で動く。`compatibility_flags = ["nodejs_compat"]` を `wrangler.toml` に足しておく。
> プロンプトキャッシュを使うなら system / tools 定義に `cache_control: { type: "ephemeral" }` を付ける（同じ前置きを使い回すぶんが安くなる）。

## システムプロンプト

エージェントの性格・制約・できることをここで固定する。**「読む・足す」中心にして
破壊的操作はツール側で制御する**のが安全。

```ts
const SYSTEM_PROMPT = `あなたはユーザーを支援する AI アシスタントです。

# 制約
1. ツールで取得した情報のみを答える。推測や創作をしない。
2. 編集・削除・承認など影響の大きい操作は専用ツール経由でのみ行い、勝手に実行しない。
3. ユーザーの権限を超える要求は丁寧に断る。
4. 不明なことは「分かりません」と正直に答える。
5. 回答は**あくまで参考情報・補助的なアドバイス**。法律・税務・医療等の**断定的な専門助言や代理は行わず**、最終判断は利用者・有資格者に委ねる旨を添える（非弁・業法回避。03 の 18章）。
6. **AIである旨を各セッション冒頭で開示**する（例：「AIアシスタントが対応します」）。これは Anthropic Usage Policy（消費者向けチャットボットの開示義務）に基づく必須要件。
7. **法律・医療等のハイリスク領域**では、AI開示に加え**有資格者の確認を前提**とし、AIだけで確定させない（Anthropic High-Risk Use Case Requirements）。
8. LINE では**提供元（顧客の商号）とプライバシーポリシーの所在**を案内できるようにする（LINE 公式アカウントAPI利用規約 第5条4項）。

# 利用可能な能力・スキル・プラグイン
${capabilities}
（↑ configから注入。設定済みの能力＝ツールとして使える。例：chat / image_gen / video_gen / transcribe / tts / embed / web_search / ocr / マイツール・外部コネクタ）

# 能力と拡張の案内（重要）
ユーザーの要望に**必要な能力／スキル／プラグイン／APIが未設定**のときは、**「できません」で終わらせず、能動的に案内**する：
1. **何が必要かを具体的に説明**（例：「動画生成には video_gen のAPI設定が必要です」）。
2. **有効化の道筋を提案**：
   - 既存の能力タイプ → **「有効化しますか？ 設定ウィザードでAPIキーを登録できます（アカウント作成はご本人で・代理不可）」**と案内。
   - 任意の外部サービス → **外部APIコネクタの登録**を案内（破壊的操作・許可ドメイン等のガード内）。
   - 無料で簡易対応できるなら → **Workers AI の無料フォールバック**を提案。
   - 新カテゴリで未対応なら → **要望として記録し、提供元（当社）へのリクエスト**として扱う。
3. 可能なら**代替案も提示**（例：「今は基本の文字起こしなら無料で可能、話者分離つき高精度はAPI追加で対応できます」）。
無断で外部送信・課金・破壊的操作はしない。設定変更・キー登録は管理者の操作/承認を前提とする。

# 応答スタイル
- 簡潔に。LINE 上で読みやすいよう箇条書きを活用。
- 長すぎる説明を避け、必要なら「詳細はこちら」のリンクを示す。
`;
```

> baku-pta では役職・在籍期間・利用可能ツールを差し込んで動的生成していた。汎用キットでは固定文で十分。
> ユーザー属性で振る舞いを変えたくなったら、`buildSystemPrompt(user)` 形式でテンプレートに変数を差し込む。

**団体別の人格＋組織記憶を差し込む（SaaS運用時）**
`buildSystemPrompt` に、テナントの **persona 設定**（名前・トーン・口調・団体固有ルール）と
**団体プロファイル＋RAGで引いた組織記憶**を織り込むと、「その団体らしい・蓄積を踏まえた」応答になる。

```ts
const sys =
  PERSONA(tenant.persona) +           // 団体別人格（可変）
  PROFILE(tenant.profile) +           // 団体の方針・好み・重要事実（蓄積から要約）
  RAG(relevantKnowledge) +            // company スコープの組織記憶（人が替わっても継承）
  SAFETY_RULES;                       // 権限・スコープ・破壊禁止・インジェクション対策（固定・上書き不可）
```

- 人格は可変だが **`SAFETY_RULES` は常に末尾固定で上書き不可**。詳細は 03 の 15 章（組織記憶・団体別人格）。

## ツール定義

Claude に渡す `tools`。**読み取り系・追加系・誘導系** に分けて考えると権限制御が楽。

```ts
const TOOLS = [
  {
    name: "search_docs",
    description: "ナレッジを検索して関連情報を返す（読み取り）",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "検索キーワード" } },
      required: ["query"],
    },
  },
  {
    name: "add_note",
    description: "メモを仮登録する。登録後はユーザー確認を求める（追加）",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "redirect_to_app",
    description: "編集・削除など破壊的操作はアプリ画面へ誘導する（直接実行しない）",
    input_schema: {
      type: "object",
      properties: { action: { type: "string" }, reason: { type: "string" } },
      required: ["action"],
    },
  },
];
```

### ツール実行と権限チェック

```ts
async function executeTool(name: string, input: any, userId: string, env: Env) {
  // 権限が要るツールはここで弾く（ロールは KV / D1 から引く）
  if (REQUIRES_PERMISSION.has(name) && !(await hasPermission(userId, name, env))) {
    return { error: "権限がありません" };
  }

  switch (name) {
    case "search_docs": return await searchDocs(input.query, env);
    case "add_note":     return await addNoteTentative(input.text, userId, env); // 仮登録
    case "redirect_to_app":
      return { message: `この操作はアプリで行ってください: ${input.action}`,
               url: "https://app.example.com" };
    default: return { error: `unknown tool: ${name}` };
  }
}
```

破壊的操作（編集・削除・承認・確定）はエージェントから直接実行せず、`redirect_to_app` で
人間の操作に委ねるか、`*_tentative`（仮登録）→ ユーザーのボタン確認 → 確定、の二段にする。

## 会話履歴（KV）

```ts
async function loadHistory(userId: string, env: Env) {
  const raw = await env.SESSIONS.get(`history:${userId}`);
  return raw ? JSON.parse(raw) : [];
}

async function saveHistory(userId: string, messages: any[], env: Env) {
  // 直近 20 件だけ保持。TTL で自動失効。
  const trimmed = messages.slice(-20);
  await env.SESSIONS.put(`history:${userId}`, JSON.stringify(trimmed), {
    expirationTtl: 60 * 60 * 24 * 7, // 7 日
  });
}
```

履歴が長くなったら、Claude に要約させて `summary` として畳む（古い生メッセージは捨てる）と
トークンを抑えられる。

## 推奨構成 — Claude が Workers AI ツールを委譲呼び出し

Claude を主に動かしつつ、**高くつく機械的処理を Workers AI ツールとして Claude に委譲させる**。Claude の `tools` に安価サブスキルを足すだけ。

```ts
const TOOLS = [
  // …業務ツール（search_docs / add_note / redirect_to_app）…

  // Claude が委譲できる安価サブスキル（中身は Workers AI）
  { name: "embed",          description: "テキストを埋め込みベクトル化して関連文書を検索（大量текスト探索向け）",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "summarize_bulk", description: "長文・大量текストを要約（Claudeの文脈に全文を入れる代わりに使う）",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "ocr",            description: "画像から文字起こし",
    input_schema: { type: "object", properties: { image_url: { type: "string" } }, required: ["image_url"] } },
];

// executeTool 側で Workers AI に流す（Claudeのトークンを消費しない）
async function executeTool(name: string, input: any, userId: string, env: Env) {
  switch (name) {
    case "summarize_bulk":
      return await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8-fast", {
        messages: [{ role: "system", content: "次の文章を簡潔に要約" }, { role: "user", content: input.text }],
        temperature: 0.2,
      });
    case "embed":
      return await searchByEmbedding(input.query, env); // @cf/baai/bge-m3 等で検索
    case "ocr":
      return await runOcr(input.image_url, env);         // vision モデル
    // …業務ツール…
  }
}
```

Claude は「50ページの資料を読む」前にまず `summarize_bulk`/`embed` を呼んで圧縮し、要点だけ自分で推論する——という判断を**ツール選択として自律的に行う**。

### モデル階層（3段ルーティング）

**Sonnet を既定**にし、簡易なものは Haiku、難しいものは Opus に切り替える。

| 層 | モデルID | 使いどころ |
|---|---|---|
| 簡易 | `claude-haiku-4-5` | 定型Q&A・分類・単一ツール・短い応答・進捗確認 |
| **既定** | **`claude-sonnet-4-6`** | 通常の対話・ツール選択・要約後の推論（大半はここ） |
| 難問 | `claude-opus-4-8` | 複数ツールの連鎖・曖昧な依頼の解釈・長文を踏まえた高度推論・マクロ仕様化 |

```ts
function pickModel(input: string, session: AgentSession): string {
  if (isTrivial(input))   return "claude-haiku-4-5"; // 短文・FAQ・確認系
  if (isHard(input, session)) return "claude-opus-4-8"; // 長い/多ツール連鎖/低confidence/「詳しく」要求
  return "claude-sonnet-4-6";                          // 既定
}
```

- コスト目安（per Mtok 概算・2026時点）: Haiku $1/$5 ＜ Sonnet $3/$15 ＜ **Opus 4.8 $5/$25**。Opusは Sonnet の約1.7倍（旧世代の「約5倍」ではない）。差が想定より小さいため、**「難問」判定の閾値はやや気前よく**振っても原価インパクトは限定的。ただし出力$25/Mtok と低レイテンシでない点を踏まえ、正確性が効く依頼に絞りつつ上限管理（03 5-3）で歯止めをかける。コード側の単価表は `index.ts` の `PRICE`（Opus=$5/$25・Sonnet=$3/$15・Haiku=$1/$5）が正。
- プロンプトキャッシュ（system/tools使い回し）で入力コストを圧縮。Sonnet常用・Opus併用時のコスト緩和に有効。

Workers AI の主なモデル（Claude が委譲する先）：

| 用途 | モデル例 |
|---|---|
| 短文生成・意図分類 | `@cf/meta/llama-3.1-8b-instruct-fp8-fast` |
| 埋め込み（日本語） | `@cf/pfnet/plamo-embedding-1b` |
| 埋め込み（多言語・低コスト） | `@cf/baai/bge-m3` |
| 画像/OCR | `@cf/meta/llama-3.2-11b-vision-instruct` |
| 再ランク（RAG精度） | `@cf/baai/bge-reranker-base` |

> **AI の出力は人間の確認を経て確定する**運用が安全（自動確定しない）。OCR・要約・検索結果はドラフト扱い。

## フォールバック

| 障害 | 挙動 |
|---|---|
| Claude API 不通 | Workers AI の軽量応答に切替、または「高品質応答は一時的に利用できません」と返す |
| Workers AI 不通 | キーワード検索など非AI処理にフォールバック |
| 両方不通 | 定型メッセージで案内し、エラーをログに残す |

## 監査ログ（任意）

誰が・いつ・どのツールを呼んだかを残すと運用が楽。**UPDATE/DELETE API を構造的に持たない**
（追記専用テーブル）にしておくと改ざん耐性が上がる。

```ts
async function logInvocation(userId: string, input: string, tools: string[], env: Env) {
  await env.DB.prepare(
    "INSERT INTO agent_logs (user_id, input, tools, created_at) VALUES (?, ?, ?, ?)"
  ).bind(userId, input, JSON.stringify(tools), Date.now()).run();
}
```

## このキットで「やらないこと」（シンプル維持のため）

- BYOK / AIゲートウェイ中継 — Claude を直接叩く
- PII マスキング層 — 必要な案件だけ後付け
- 役職ごとの動的システムプロンプト生成 — まずは固定文
- 自動確定（会計・承認など）— 確定は人間に残す
