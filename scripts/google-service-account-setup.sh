#!/usr/bin/env bash
set -euo pipefail

# Google 連携（キーレス：Workload Identity Federation ＋ ドメイン全体の委任 / DWD）の資格情報を
# ほぼ自動で用意するヘルパー。**サービスアカウント鍵(JSON)は一切作成しない**（鍵レス＝案B）。
#   ・GCP プロジェクト作成（または既存）／必要 API 有効化（Calendar/Gmail/Meet ＋ IAMCredentials/STS）
#   ・サービスアカウント作成（鍵なし）
#   ・Workload Identity Pool ＋ OIDC プロバイダ作成（issuer = あなたの baku-office Worker の URL）
#   ・IAM 付与（principalSet:subject/baku-office に workloadIdentityUser ＋ serviceAccountTokenCreator）
#   ・最後に、設定画面に貼る JSON（sa_email/client_id/project_number/pool/provider）と DWD 用の値を表示
# OAuth クライアントID/シークレットや SA 鍵は不要。組織ポリシー iam.disableServiceAccountKeyCreation 下でも動く。
# 残る手動は管理コンソールでの委任承認 1 回のみ。
#
# 使い方:
#   WORKER_URL=https://<あなたのbaku-office>.workers.dev scripts/google-service-account-setup.sh [PROJECT_ID] [SA_NAME]
#     WORKER_URL  必須。あなたの baku-office アプリの URL（OIDC issuer になる）。設定画面のコマンドに埋め込み済み。
#     PROJECT_ID  省略時は baku-office-XXXX を自動生成
#     SA_NAME     省略時は baku-office-bot
#   SUBJECT 環境変数で代理ユーザーを表示用に指定可（実際に効くのは設定画面の代理ユーザー欄）。
#
# 前提: gcloud CLI 導入済み・`gcloud auth login` 済み・課金/権限が有効なこと。

PROJECT_ID="${1:-baku-office-$(printf '%04d' $((RANDOM % 10000)))}"
SA_NAME="${2:-baku-office-bot}"
POOL="${POOL:-baku-office-pool}"
PROVIDER="${PROVIDER:-baku-office-prov}"

# 委任するスコープ（設定画面で選んだ機能に合わせて取捨選択可。既定は Calendar + Meet）。
SCOPES="https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/meetings.space.created,https://www.googleapis.com/auth/meetings.space.readonly"
APIS=(
  "calendar-json.googleapis.com"      # Google Calendar API
  "gmail.googleapis.com"              # Gmail API
  "meet.googleapis.com"              # Google Meet API
  "iamcredentials.googleapis.com"     # signJwt（DWDアサーション署名・鍵レスの要）
  "sts.googleapis.com"               # Security Token Service（WIF トークン交換）
)

# ---- 視覚ヘルパ（Cloud Shell は色対応。非TTYなら無色）。値そのもの（ID/メール/URL）には色を付けない＝コピー安全。 ----
if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; R=$'\e[31m'; N=$'\e[0m'; else B=; D=; G=; R=; N=; fi
TOTAL=6
step() { printf '\n%s━━ [%s/%s] %s%s\n' "$B" "$1" "$TOTAL" "$2" "$N"; }
ok()   { printf '   %s✓%s %s\n' "$G" "$N" "$1"; }
info() { printf '   %s%s%s\n' "$D" "$1" "$N"; }
die()  { printf '\n%s✗ %s%s\n' "$R" "$1" "$N" >&2; exit 1; }

step 1 "前提チェック"
command -v gcloud >/dev/null 2>&1 || die "gcloud が見つかりません: https://cloud.google.com/sdk/docs/install"
ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
[ -n "${ACTIVE_ACCOUNT}" ] || die "gcloud にログインしていません。まず実行: gcloud auth login"
# WORKER_URL（OIDC issuer）は必須。未指定なら（対話端末では）入力を促し、非対話では中断。
if [ -z "${WORKER_URL:-}" ]; then
  if [ -t 0 ]; then
    printf '   %sあなたの baku-office アプリの URL を入力してください（例 https://baku-office-app.example.workers.dev）%s\n' "$D" "$N"
    printf '   WORKER_URL = '; read -r WORKER_URL
  fi
fi
[ -n "${WORKER_URL:-}" ] || die "WORKER_URL（あなたの baku-office の URL）が必要です。設定画面に表示されたコマンドをそのままコピーして実行してください。"
WORKER_URL="${WORKER_URL%/}" # 末尾スラッシュ除去（issuer は origin・OIDC iss と一致必須）
case "${WORKER_URL}" in https://*) ;; *) die "WORKER_URL は https:// で始まる必要があります（現在: ${WORKER_URL}）";; esac
SUBJECT="${SUBJECT:-${ACTIVE_ACCOUNT}}"
ok "アカウント   : ${ACTIVE_ACCOUNT}"
ok "Worker URL  : ${WORKER_URL}（OIDC issuer）"
info "プロジェクト: ${PROJECT_ID} ／ SA: ${SA_NAME} ／ Pool: ${POOL} ／ Provider: ${PROVIDER}"

step 2 "プロジェクトの用意"
if gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  ok "既存を使用: ${PROJECT_ID}"
else
  gcloud projects create "${PROJECT_ID}" --name="baku-office" >/dev/null || die "プロジェクト作成に失敗（課金/権限をご確認ください）"
  ok "作成: ${PROJECT_ID}"
fi
gcloud config set project "${PROJECT_ID}" >/dev/null
PROJECT_NUMBER="$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
[ -n "${PROJECT_NUMBER}" ] || die "プロジェクト番号の取得に失敗しました"
ok "プロジェクト番号: ${PROJECT_NUMBER}"

step 3 "API の有効化（Calendar / Gmail / Meet ＋ IAMCredentials / STS）"
gcloud services enable "${APIS[@]}" >/dev/null || die "API 有効化に失敗"
ok "有効化完了"

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
step 4 "サービスアカウント作成（鍵は作りません）"
if gcloud iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1; then
  ok "SA 既存: ${SA_EMAIL}"
else
  gcloud iam service-accounts create "${SA_NAME}" --display-name="baku-office bot" >/dev/null || die "サービスアカウント作成に失敗"
  ok "SA 作成: ${SA_EMAIL}"
fi
CLIENT_ID="$(gcloud iam service-accounts describe "${SA_EMAIL}" --format='value(oauth2ClientId)')"
[ -n "${CLIENT_ID}" ] || die "client_id（oauth2ClientId）の取得に失敗しました"

step 5 "Workload Identity Federation（プール / OIDC プロバイダ / IAM）"
if gcloud iam workload-identity-pools describe "${POOL}" --location=global >/dev/null 2>&1; then
  ok "Pool 既存: ${POOL}"
else
  gcloud iam workload-identity-pools create "${POOL}" --location=global --display-name="baku-office" >/dev/null || die "Pool 作成に失敗"
  ok "Pool 作成: ${POOL}"
fi
# OIDC プロバイダ：issuer=あなたの Worker URL。subject クレームを google.subject にマップ（principalSet で参照）。
# 既定の許可 audience（https://iam.googleapis.com/projects/.../providers/<PROV>）が Worker 自署名 JWT の aud と一致する。
if gcloud iam workload-identity-pools providers describe "${PROVIDER}" --location=global --workload-identity-pool="${POOL}" >/dev/null 2>&1; then
  ok "Provider 既存: ${PROVIDER}（issuer 更新）"
  gcloud iam workload-identity-pools providers update-oidc "${PROVIDER}" --location=global --workload-identity-pool="${POOL}" \
    --issuer-uri="${WORKER_URL}" --attribute-mapping="google.subject=assertion.sub" >/dev/null || die "Provider 更新に失敗"
else
  gcloud iam workload-identity-pools providers create-oidc "${PROVIDER}" --location=global --workload-identity-pool="${POOL}" \
    --issuer-uri="${WORKER_URL}" --attribute-mapping="google.subject=assertion.sub" --display-name="baku-office" >/dev/null || die "Provider 作成に失敗"
  ok "Provider 作成: ${PROVIDER}"
fi
# principalSet：自署名 JWT の sub="baku-office" を、この SA を使える主体として束縛。
MEMBER="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/subject/baku-office"
# workloadIdentityUser＝この主体が SA として動ける。serviceAccountTokenCreator＝signJwt を呼べる（DWDアサーション署名）。
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" --role="roles/iam.workloadIdentityUser" --member="${MEMBER}" >/dev/null || die "IAM 付与(workloadIdentityUser)に失敗"
gcloud iam service-accounts add-iam-policy-binding "${SA_EMAIL}" --role="roles/iam.serviceAccountTokenCreator" --member="${MEMBER}" >/dev/null || die "IAM 付与(serviceAccountTokenCreator)に失敗"
ok "IAM 付与完了（workloadIdentityUser ＋ serviceAccountTokenCreator）"

step 6 "完了 — 下の値で登録してください"
printf '\n%s【A】baku-office の「Google連携セットアップ」→ サービスアカウント（キーレス）方式%s\n' "$B" "$N"
printf '   1) 下の JSON を「WIF設定」欄にそのまま貼り付け（Ctrl+V / Cmd+V）\n'
printf '   2) 代理ユーザー欄を確認（既定は団体アカウント）\n'
printf '   3) 利用機能を選んで「登録して接続テスト」を押す\n'
printf '%s┌─ WIF設定（この1行をコピー）─────────────────────────────────%s\n' "$D" "$N"
printf '{"sa_email":"%s","client_id":"%s","project_number":"%s","pool":"%s","provider":"%s"}\n' \
  "${SA_EMAIL}" "${CLIENT_ID}" "${PROJECT_NUMBER}" "${POOL}" "${PROVIDER}"
printf '%s└─ ここまで ───────────────────────────────────────────────%s\n' "$D" "$N"
printf '\n%s【B】Google Workspace 管理コンソールで「ドメイン全体の委任」を 1 回承認%s\n' "$B" "$N"
printf '   URL          : https://admin.google.com/ac/owl/domainwidedelegation\n'
printf '   クライアントID : %s\n' "${CLIENT_ID}"
printf '   スコープ       : %s\n' "${SCOPES}"
printf '\n%s承認後、設定画面の「登録して接続テスト」をもう一度押すと連携完了です。%s\n' "$G" "$N"
