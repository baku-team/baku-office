#!/usr/bin/env bash
# 自動セットアップは【クライアント側】と【ホスト側】に分割しました（役割分離：検証のみ / 署名権限）。
#   - setup-client.sh : 顧客Worker（インフラ・BYOK・LINE・デプロイ・Webhook。署名鍵を持たない）
#   - setup-host.sh   : ホスト/CP（Ed25519鍵発行・公開検証鍵の配布・lease/config署名発行）
# このラッパーは開発の単一Worker構成向けに、client → host の順で続けて実行します。
# 本番で別Workerに割る場合は各スクリプトを個別に実行してください（setup-host.sh 末尾の注記参照）。
set -uo pipefail
cd "$(dirname "$0")"

echo "== 自動セットアップ（client → host の順で実行）=="
echo "個別に実行したい場合は: bash setup-client.sh / bash setup-host.sh"
read -r -p "続行しますか? (Y/n): " go
[ "${go:-Y}" = "n" ] && { echo "中断しました。"; exit 0; }

bash setup-client.sh
echo
echo "== 続いてホスト側（署名鍵発行＋初期lease/config）=="
bash setup-host.sh
