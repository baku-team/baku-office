# baku-office-scheduler

定期巡回スケジューラ（当社アカウント・単一 Worker）。Cloudflare **Cron Triggers** で、ホストの自己修復 sweep（報告→GitHub 集積）とクライアントの drain（報告のホスト送信・要約/動画/リマインダ）を起動する。外部サービス（cron-job.org 等）に依存せず、CF 内で自動送信を完結させる。

## 仕組み

- `*/5 * * * *`（5分ごと）で巡回。巡回間隔は運用に合わせて調整可（自己修復は分単位の即時性は不要）。
- 各対象 Worker は **Service Binding 経由**で叩く。同一 `workers.dev` への直 fetch は CF が遮断（error 1042）するため。
- 巡回先は `CRON_TARGETS`（JSON 配列）で `{binding, path, key}` を指定する。Astro ビルド非依存の素の Worker。

## デプロイ

```sh
npm -w apps/scheduler run deploy   # = wrangler deploy
```

事前に集積先リポ `baku-team/baku-office-logs` を作成しておく（host の自己修復 sweep が Issue を作る先）。

### secret（`wrangler secret put`）

- `CRON_TARGETS` … 巡回先の JSON 配列。`key` は各 Worker の `INTERNAL_KEY` と同値。

```json
[
  {"label":"host-sweep","binding":"T_HOST","path":"/api/cron/sweep","key":"<host INTERNAL_KEY>"},
  {"label":"client-drain","binding":"T_CLIENT","path":"/api/cron/drain","key":"<client INTERNAL_KEY>"}
]
```

### Service Binding（`wrangler.jsonc`）

- `T_HOST` → `baku-office-portal`（ホストポータル）
- `T_CLIENT` → `baku-office-app`（当社運用のクライアント）

## 手動トリガ / 死活確認

- `GET /` … 設定済みターゲットの label 一覧を返す（秘匿情報は返さない）。
- `POST /` … 即時巡回。乱用防止のため、設定済みターゲット鍵のいずれかを `x-internal-key` ヘッダで要求する。

## 補足

配布クライアント（顧客の別アカウント）の自走 drain は、本スケジューラではなく配布テンプレートへの cron 同梱で対応する（別運用）。
