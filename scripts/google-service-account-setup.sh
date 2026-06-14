#!/usr/bin/env bash
set -euo pipefail

# Google 連携（サービスアカウント＋ドメイン全体の委任 / DWD）の資格情報をほぼ自動で用意するヘルパー。
#   ・代理ユーザー（Workspace）を対話で確認（既定はログイン中のアカウント）
#   ・GCP プロジェクト作成（または既存を使用）／必要 API 有効化（Calendar / Gmail / Meet）
#   ・サービスアカウント作成 ＋ 鍵(JSON) 発行
#   ・鍵(JSON) をクリップボードへ自動コピー（OSC52・Cloud Shell 対応）
#   ・最後に、設定画面に貼る値（代理ユーザー・鍵・クライアントID・スコープ）を 1 画面に集約表示
# OAuth クライアントID/シークレットや同意画面は不要。残る手動は管理コンソールでの委任承認 1 回のみ。
#
# 使い方:
#   scripts/google-service-account-setup.sh [PROJECT_ID] [SA_NAME]
#     PROJECT_ID  省略時は baku-office-XXXX を自動生成
#     SA_NAME     省略時は baku-office-bot（6〜30字・英小文字始まり）
#   SUBJECT 環境変数で代理ユーザーを非対話指定も可（例: SUBJECT=admin@example.com ...）。
#
# 前提: gcloud CLI 導入済み・`gcloud auth login` 済み・課金/権限が有効なこと。

PROJECT_ID="${1:-baku-office-$(printf '%04d' $((RANDOM % 10000)))}"
SA_NAME="${2:-baku-office-bot}"
KEY_FILE="${SA_NAME}-key.json"

# 委任するスコープ（設定画面で選んだ機能に合わせて取捨選択可。既定は Calendar + Meet）。
SCOPES="https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/meetings.space.created,https://www.googleapis.com/auth/meetings.space.readonly"
APIS=(
  "calendar-json.googleapis.com"  # Google Calendar API
  "gmail.googleapis.com"          # Gmail API
  "meet.googleapis.com"           # Google Meet API
)

# ---- 視覚ヘルパ（Cloud Shell は色対応。非TTYなら無色）。値そのもの（鍵/ID/メール）には色を付けない＝コピー安全。 ----
if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; R=$'\e[31m'; N=$'\e[0m'; else B=; D=; G=; R=; N=; fi
TOTAL=5
step() { printf '\n%s━━ [%s/%s] %s%s\n' "$B" "$1" "$TOTAL" "$2" "$N"; }
ok()   { printf '   %s✓%s %s\n' "$G" "$N" "$1"; }
info() { printf '   %s%s%s\n' "$D" "$1" "$N"; }
die()  { printf '\n%s✗ %s%s\n' "$R" "$1" "$N" >&2; exit 1; }
# gcloud の結果整合（作成直後の NOT_FOUND 等）を吸収するリトライ。成功するまで最大 max 回。
retry() { local n=0 max=12; until "$@" >/dev/null 2>&1; do n=$((n + 1)); [ "$n" -ge "$max" ] && return 1; printf '   %s…反映待ち (%s/%s)%s\n' "$D" "$n" "$max" "$N"; sleep 5; done; }
# 鍵(JSON)をターミナル経由でクリップボードへ。Cloud Shell の端末(hterm)は OSC52 クリップボード書込に対応。
# 効かない端末では無害（エスケープが無視されるだけ）。最後に手動コピー用ブロックも必ず表示する。
clip_copy() { local b64; b64="$(base64 -w0 <"$1" 2>/dev/null || base64 <"$1" | tr -d '\n')"; printf '\e]52;c;%s\a' "$b64"; }

step 1 "前提チェック・代理ユーザーの確認"
command -v gcloud >/dev/null 2>&1 || die "gcloud が見つかりません: https://cloud.google.com/sdk/docs/install"
ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
[ -n "${ACTIVE_ACCOUNT}" ] || die "gcloud にログインしていません。まず実行: gcloud auth login"
ok "アカウント : ${ACTIVE_ACCOUNT}"
info "プロジェクト: ${PROJECT_ID} ／ サービスアカウント: ${SA_NAME}"
# 代理ユーザー＝DWD で代理する Workspace ユーザー。対話で確認（既定はログイン中の団体アカウント）。
DEFAULT_SUBJECT="${SUBJECT:-${ACTIVE_ACCOUNT}}"
if [ -t 0 ]; then
  printf '\n   %s代理ユーザー%s = 予定/メールを操作する Workspace ユーザーのメール\n' "$B" "$N"
  read -r -p "   メール [${DEFAULT_SUBJECT}]: " _sub || true
  SUBJECT="${_sub:-${DEFAULT_SUBJECT}}"
else
  SUBJECT="${DEFAULT_SUBJECT}"
fi
ok "代理ユーザー: ${SUBJECT}"

step 2 "プロジェクトの用意"
if gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  ok "既存を使用: ${PROJECT_ID}"
else
  gcloud projects create "${PROJECT_ID}" --name="baku-office" >/dev/null || die "プロジェクト作成に失敗（課金/権限をご確認ください）"
  ok "作成: ${PROJECT_ID}"
fi
gcloud config set project "${PROJECT_ID}" >/dev/null

step 3 "API の有効化（Calendar / Gmail / Meet）"
gcloud services enable "${APIS[@]}" >/dev/null || die "API 有効化に失敗"
ok "有効化完了"

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
step 4 "サービスアカウントと鍵の発行"
if gcloud iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1; then
  ok "SA 既存: ${SA_EMAIL}"
else
  gcloud iam service-accounts create "${SA_NAME}" --display-name="baku-office bot" >/dev/null || die "サービスアカウント作成に失敗"
  ok "SA 作成: ${SA_EMAIL}"
fi
# WHY: 作成直後は IAM 反映遅延で keys create が NOT_FOUND になる。成功するまでリトライする。
retry gcloud iam service-accounts keys create "${KEY_FILE}" --iam-account="${SA_EMAIL}" \
  || die "鍵の発行に失敗しました。数十秒おいて、同じコマンドをもう一度実行してください。"
ok "鍵を発行: ${KEY_FILE}（取扱注意・第三者に渡さない）"
CLIENT_ID="$(gcloud iam service-accounts describe "${SA_EMAIL}" --format='value(oauth2ClientId)')"
clip_copy "${KEY_FILE}" || true
ok "鍵(JSON)をクリップボードにコピーしました（効かない場合は下のブロックを手動コピー）"

step 5 "完了 — 下の値で登録してください"
printf '\n%s【A】baku-office の「Google連携セットアップ」→ サービスアカウント方式%s\n' "$B" "$N"
printf '   1) 代理ユーザー欄 : %s\n' "${SUBJECT}"
printf '   2) 鍵(JSON)欄     : クリップボード済み → そのまま貼り付け（Ctrl+V / Cmd+V）\n'
printf '   3) 利用機能を選んで「登録して接続テスト」を押す\n'
printf '%s┌─ 鍵(JSON)（クリップボードが効かない場合の手動コピー用）──────%s\n' "$D" "$N"
cat "${KEY_FILE}"
printf '%s└─ ここまで ───────────────────────────────────────────────%s\n' "$D" "$N"
printf '\n%s【B】Google Workspace 管理コンソールで「ドメイン全体の委任」を 1 回承認%s\n' "$B" "$N"
printf '   URL          : https://admin.google.com/ac/owl/domainwidedelegation\n'
printf '   クライアントID : %s\n' "${CLIENT_ID}"
printf '   スコープ       : %s\n' "${SCOPES}"
printf '\n%s承認後、設定画面の「登録して接続テスト」をもう一度押すと連携完了です。%s\n' "$G" "$N"
