# baku-office（クライアントアプリ）

クラウド会計・庶務補助システム **baku-office** のクライアントアプリ（Web管理画面＋LINE/Discord連携）。
このリポジトリは**配布用のビルド済みバンドル**です（ソースは非公開・当社管理）。

## ワンクリック導入（Deploy to Cloudflare）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/baku-team/baku-office-app)

1. ボタンを開き、Cloudflareに**団体のCloudflareアカウント**でサインイン。
2. Cloudflareがこのリポジトリを**あなたのGitHubへ複製**し、**D1・KVをあなたのアカウントに自動作成**してデプロイ。
3. **秘密鍵などの設定は不要**：暗号鍵（MASTER_KEY）は初回に自動生成され、ライセンス検証鍵・ログインは当社ホストと自動連携します。
4. 申込時に届いた**アクティベーションURL**を開く → ライセンスを自動取得 → **「Googleでログイン」**（団体側のGoogle設定は不要）。

## 導入後の設定（管理画面から）

- **連携設定**：AIを使う場合のみ Gemini／（Pro）LINE・Claude のAPIキーを登録（保存時に検証→暗号化保存）。AI不要なら設定不要で会計・庶務が使えます。
- **プラン・課金**：**Free（無料）**はそのまま利用可。**Plus（AI）／Pro（エージェント）**はアップグレード。
- **ログイン**：組織＝Google（当社ホスト経由の中継。団体側の設定不要）。

## 更新

当社が新バージョンを公開したら、**あなたの複製（フォーク）を上流と同期**するだけで Workers Builds が自動再デプロイ（§3.3）。当社はあなたのアカウントに入りません。

---
※ 業務データ（会計・名簿・ファイル）は**あなたのCloudflare内のみ**に保存されます。当社はアクセスしません（§1.2）。バックアップは各団体の責任で実施してください。
