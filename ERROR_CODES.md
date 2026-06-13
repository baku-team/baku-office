# エラー番号 早見表（サポート用）

利用者の画面に「エラー番号: Exxxx」が表示されたら、この表で**発生箇所**が分かります（ログ不要）。
実体は [`apps/client/src/lib/errors.ts`](apps/client/src/lib/errors.ts)。コードを増減したら本表も必ず更新すること。

## 仕組み
- 想定済みの失敗は `AppError(code, 利用者向け文言, status)` を投げる（細かいコード）。
- 想定外の未捕捉エラーは `middleware.ts` の全体catchが、**APIルート/ページ由来の確定コード**を必ず付与。
- 画面表示：API失敗はトーストに「…（エラー番号: Exxxx）」、ページ表示不能時は専用ページに大きく番号を表示。
- 任意で D1 `diagnostics` に `[Exxxx] METHOD path: 詳細` を記録（取得は任意・番号だけで特定可能）。

## 採番規約
| 帯 | 区分 |
|---|---|
| E0xxx | 画面（ページ描画）・クライアント側（通信失敗 等） |
| E1xxx | 認証・参加・同意 |
| E2xxx | 会計 |
| E3xxx | 人・会員 |
| E4xxx | 予定・Google 連携 |
| E5xxx | ファイル・取り込み・保存 |
| E6xxx | AI・エージェント |
| E7xxx | 設定・通知・課金 |
| E8xxx | 連携(A2A)・外部・Webhook |
| E9xxx | 基盤（KV/暗号/移行 等の横断） |

## クライアント／画面（E0xxx）
| コード | 箇所・意味 |
|---|---|
| E0001 | 通信失敗（端末側・オフライン/電波）。`window.bo.api` の fetch 例外 |
| E0100 | ホーム画面の描画 |
| E0200 / E0210 | 会計 / 請求書 画面の描画 |
| E0300 / E0310 | 会員・人ロール / 共有承認 画面 |
| E0400 / E0401 / E0402 / E0403 / E0410 | 予定 / カレンダー / Meet / Gmail / 議事録 画面 |
| E0500 / E0510 / E0520 / E0530 | ファイル / 取り込み / ドライブ / バックアップ 画面 |
| E0600 / E0610 | AI / アプリ 画面 |
| E0700 / E0710 / E0720 / E0730 / E0740 / E0750 | 設定 / 課金 / 利用状況 / 診断 / 開示 / 承認 画面 |
| E0800 / E0810 / E0820 / E0830 / E0840 / E0850 | 個人 / アカウント / 同意 / アクティベート / ログイン / 参加 画面 |
| E0000 | 上記いずれにも該当しないパス |

## API（E1xxx〜E8xxx）
未捕捉エラー時に「どのAPIで失敗したか」を示す。
| コード | API ルート |
|---|---|
| E1001 / E1002 / E1003 | /api/login / /api/join / /api/consent |
| E1010 / E1011 / E1012 | /api/auth/*/start / /api/auth/*/callback / /api/auth/google/relay |
| E2001 / E2002 | /api/tx / /api/invoices |
| E3001 / E3002 / E3003 / E3004 | /api/members / /api/membership / /api/review / /api/me/leave-request |
| E4001 | /api/docs（予定・議事録 等の保存） |
| E4010 / E4011 / E4012 | /api/google / /api/google/start / /api/google/callback |
| E5001 / E5002 | /api/files / /api/import |
| E5010 / E5011 / E5012 | /api/drive / /api/drive/start / /api/drive/callback |
| E5020 / E5030 / E5040 | /api/store / /api/data / /api/backup |
| E6001 / E6002 / E6003 / E6004 | /api/chat / /api/chat-sessions / /api/skills / /api/agent-actions |
| E6005 / E6006 / E6007 / E6008 | /api/autopilot / /api/mascot / /api/capabilities / /api/activity |
| E7001 / E7002 / E7003 / E7004 | /api/settings / /api/site / /api/site/join / /api/update |
| E7005 / E7006 / E7007 / E7008 / E7009 | /api/billing/start / /api/notifications / /api/personal / /api/usage / /api/keys |
| E8001 / E8002 | /api/a2a/inbound / /api/a2a/manage |
| E8010 / E8020 | /api/report / /api/cron/drain |
| E8030 / E8031 | /api/line/webhook / /api/site/stripe-webhook |

## 基盤・横断（E9xxx）
| コード | 意味・対処 |
|---|---|
| E9001 | KV/D1 の1日あたり書き込み上限超過。日付が変わると回復。恒久対策は Workers Paid 有効化 |
| E9002 | 本番で MASTER_KEY 未設定（暗号処理ブロック）。`wrangler secret put MASTER_KEY --env production` を投入 |
| E9003 | 暗号化/復号/ハッシュの失敗（鍵不整合・データ破損 等） |
| E9004 | スキーマ自動適用（マイグレーション）の失敗。診断ログを確認 |
| E9005 | 起動時点検の失敗 |
| E9006 | ホスト(host worker)との通信失敗 |
| E9007 | アプリ（パーツ）が宣言していない能力(Port)へアクセスした（capability scoping 違反）。アプリのマニフェスト permissions に不足権限を追加 |
