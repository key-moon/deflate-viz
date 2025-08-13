# GitHub Pagesの設定手順

GitHubリポジトリでGitHub Pagesを有効にするには、以下の手順を実行してください。

1. GitHubのリポジトリページに移動します
2. 「Settings」タブをクリックします
3. 左側のサイドバーから「Pages」を選択します
4. 「Build and deployment」セクションで以下を設定します:
   - Source: GitHub Actions
5. 保存を確認します

設定が完了すると、GitHub Actionsワークフローが自動的にサイトをデプロイします。
デプロイ後、GitHub PagesのURLが表示されます（通常は `https://[username].github.io/[repository-name]/` の形式）。

## 手動デプロイ

リポジトリページの「Actions」タブから「Deploy to GitHub Pages」ワークフローを選択し、「Run workflow」をクリックすることで手動デプロイも可能です。

## 注意事項

- 初回のデプロイ後、実際にサイトが利用可能になるまで数分かかる場合があります
- カスタムドメインを使用する場合は、GitHub Pagesの設定で追加設定が必要です
