> ⚠️ **レガシー設計（背景資料）**：本書は旧 `cf-line-agent-kit`（LINEエージェント単体・Workers AI二層）の設計です。
> 現行 **baku-office**（会計・庶務SaaS／ホスト・クライアント自己ホスト）の**正本は [integrated_design_package_v1.0.md](../spec/integrated_design_package_v1.0.md)**、
> 実装は `apps/`、運用は [OPERATIONS.md](../../OPERATIONS.md) を参照。本書は経緯・参考として保持。

# 01. デプロイ基盤 — GitHub ⇔ Cloudflare ⇔ LINE 連動

コードを GitHub に置き、push したら Cloudflare に自動デプロイされ、LINE からの Webhook を
Cloudflare Workers で受ける——という 3 者の連動を作る。

## 全体像

```
[GitHub: アプリのリポジトリ]
   │ main へ push
   ▼
[GitHub Actions]  ── wrangler deploy ──▶ [Cloudflare Workers]
                                              ▲
                                              │ Webhook (HTTPS)
                                         [LINE Messaging API]
                                              ▲
                                              │ トーク
                                            ユーザー
```

役割分担：

| 主体 | 役割 |
|---|---|
| **GitHub** | ソースの単一管理。Actions が CI/CD を回す。 |
| **Cloudflare Workers** | 実行環境。LINE Webhook の受け口かつエージェント本体。 |
| **Cloudflare D1 / KV** | 永続データ（D1）と会話状態・短期データ（KV）。 |
| **LINE Messaging API** | ユーザーとの接点。Webhook で受け、reply / push で返す。 |

## 1. プロジェクト初期化

```bash
npm create cloudflare@latest my-agent -- --type hello-world
cd my-agent
git init && git remote add origin git@github.com:<org>/my-agent.git
```

### wrangler.toml（最小構成）

```toml
name = "my-agent"
main = "src/index.ts"
compatibility_date = "2024-09-23"

# Workers AI バインド（02 で使用）
[ai]
binding = "AI"

# 会話状態・短期データ
[[kv_namespaces]]
binding = "SESSIONS"
id = "<kv-namespace-id>"

# 永続データが要るときだけ
[[d1_databases]]
binding = "DB"
database_name = "my-agent-db"
database_id = "<d1-database-id>"
```

KV / D1 の作成：

```bash
npx wrangler kv namespace create SESSIONS
npx wrangler d1 create my-agent-db
npx wrangler d1 migrations apply my-agent-db
```

## 2. Secrets（環境変数）

機密値はコードにもリポジトリにも置かず、Worker の Secrets に入れる。

```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN   # LINE Developers → Messaging API
npx wrangler secret put LINE_CHANNEL_SECRET         # 署名検証用
npx wrangler secret put ANTHROPIC_API_KEY           # Claude API
```

| Secret | 用途 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE への返信・push 送信 |
| `LINE_CHANNEL_SECRET` | Webhook 署名（`x-line-signature`）の検証 |
| `ANTHROPIC_API_KEY` | Claude API 呼び出し |

> Workers AI（`env.AI`）は Cloudflare アカウント内なので API キー不要。

## 3. LINE Webhook の受け口

LINE は Webhook に **5 秒以内の応答（200）** を期待する。重い処理は `ctx.waitUntil` で
非同期に逃がし、まず即 ACK を返すのが定石。

```ts
// src/index.ts
export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/line/webhook" && req.method === "POST") {
      const body = await req.text();

      // 1. 署名検証
      const signature = req.headers.get("x-line-signature") ?? "";
      if (!(await verifyLineSignature(body, signature, env.LINE_CHANNEL_SECRET))) {
        return new Response("invalid signature", { status: 401 });
      }

      // 2. 重い処理は waitUntil に逃がして即 ACK（5秒ルール）
      const { events } = JSON.parse(body);
      ctx.waitUntil(handleEvents(events, env));
      return new Response("ok"); // 200 を即返す
    }

    return new Response("not found", { status: 404 });
  },
};
```

### 署名検証（HMAC-SHA256, WebCrypto）

```ts
async function verifyLineSignature(body: string, signature: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === signature;
}
```

### イベント振り分け

```ts
async function handleEvents(events: any[], env: Env) {
  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      const reply = await runAgent(event.message.text, event.source.userId, env); // → 02
      await replyToLine(event.replyToken, reply, env);
    }
    // follow / unfollow / postback などは必要に応じて追加
  }
}
```

### LINE へ返信

```ts
async function replyToLine(replyToken: string, text: string, env: Env) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
}
```

`replyToken` は 1 回 / 短時間限定。あとから送るなら `push`（`/v2/bot/message/push`、`to: userId`）を使う。

### Webhook URL の登録

デプロイ後の Worker URL を LINE Developers コンソールに登録：

```
https://my-agent.<subdomain>.workers.dev/line/webhook
```

LINE Developers → Messaging API → Webhook URL に設定し、Webhook 利用を ON、応答メッセージを OFF。

## 4. CI/CD（GitHub Actions）

`main` に push したら自動で `wrangler deploy`。

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

GitHub リポジトリの Settings → Secrets に `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` を登録。
API トークンは Cloudflare ダッシュボード → My Profile → API Tokens で「Edit Cloudflare Workers」テンプレートから発行。

D1 のマイグレーションも回すなら deploy の前に一行足す：

```yaml
      - run: npx wrangler d1 migrations apply my-agent-db --remote
      - run: npx wrangler deploy
```

## 5.（任意）複数アカウント／複数テナントへの一括配布

1 つのコードを複数の Cloudflare アカウントや環境に配る必要が出たときだけ、Actions の matrix を使う。
**単一テナントなら不要** — 上の章までで完結する。

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        tenant: ${{ fromJson(vars.ACTIVE_TENANTS) }}  # 例: [{"name":"a","account_id":"..."},...]
      fail-fast: false   # 1 つ失敗しても他は継続
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - name: Deploy ${{ matrix.tenant.name }}
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets[format('CF_TOKEN_{0}', matrix.tenant.name)] }}
          CLOUDFLARE_ACCOUNT_ID: ${{ matrix.tenant.account_id }}
        run: npx wrangler deploy --env ${{ matrix.tenant.name }}
```

`wrangler.toml` 側に `[env.a]` `[env.b]` … を定義し、テナント一覧は GitHub の
Repository variables（`vars.ACTIVE_TENANTS`）に JSON で持たせる。

> baku-pta では各団体が別 Cloudflare アカウントを持ちゼロタッチで自動プロビジョニング（D1/KV 作成・Secrets 投入・解約時の自動削除ジョブまで）していたが、汎用キットでは過剰。必要になった案件で個別に足す。

## チェックリスト

- [ ] Cloudflare アカウント・`wrangler login` 済み
- [ ] KV namespace（SESSIONS）作成・`wrangler.toml` に記載
- [ ] `[ai]` バインド追加
- [ ] Secrets 3 種投入（LINE 2 つ + Anthropic）
- [ ] LINE Developers で Webhook URL 登録・応答メッセージ OFF
- [ ] GitHub Secrets に Cloudflare トークン登録
- [ ] `main` push でデプロイされることを確認
- [ ] LINE で話しかけて応答が返ることを確認（→ [02](02_cloud-agent.md)）
