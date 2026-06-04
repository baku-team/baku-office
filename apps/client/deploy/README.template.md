# baku-office（クライアントアプリ）

LINE上で動くクラウド会計・庶務補助システム **baku-office** のクライアントアプリ。
このリポジトリは**配布用の難読化バンドル**です（ソースは非公開・当社管理）。

## ワンクリック導入（Deploy to Cloudflare）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/baku-team/baku-office-app)

1. ボタンを開き、Cloudflareに**団体専用Googleアカウント**でサインイン（§5-A/B）。
2. Cloudflareがこのリポジトリを**あなたのGitHubへ複製**し、**D1・KVをあなたのアカウントに自動作成**してデプロイ（§3.2）。
3. デプロイ後、初めてアプリを開くと**当社のアクティベーション画面**へ遷移。申込時のGoogleで認証するとライセンスを自動取得（**認証キー入力なし**・§4）。

## 導入後の設定（管理画面から）

- **連携設定**：Gemini／LINE／Claude のAPIキー（保存時に検証→暗号化保存・§7.2/10.3）。
- **プラン・課金**：X（無料）はそのまま利用可。Y/Z はアップグレード（§2）。
- **組織/個人ログイン**：組織=Google、個人=LINE/Discord（各OAuthクライアントは当社が案内）。

## 更新

当社が新バージョンを公開したら、**あなたの複製（フォーク）を上流と同期**するだけで Workers Builds が自動再デプロイ（§3.3）。当社はあなたのアカウントに入りません。

---
※ 業務データ（会計・名簿・ファイル）は**あなたのCloudflare内のみ**に保存されます。当社はアクセスしません（§1.2）。バックアップは各団体の責任で実施してください。
