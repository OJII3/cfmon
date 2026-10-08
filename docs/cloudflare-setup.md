# Cloudflare セットアップ

## 前提条件

- Cloudflare アカウント
- Workers Analytics Engine が有効であること
- 初回セットアップを実行する端末で Nix とブラウザが使えること

メトリクスの照会には Analytics SQL binding を使います。Worker 自身のアカウント権限で照会するため、Analytics 用 API トークンは不要です。

## 初回セットアップ

```sh
nix run github:OJII3/cfmon -- setup
```

初回は `cf` の OAuth 認可を1回行います。URL と確認コードが表示されるので、ローカル・SSH・コンテナのどこからでも、別端末のブラウザで承認できます。コードの有効時間内に承認してください。複数の Cloudflare アカウントがある場合だけ、表示された一覧から使用するアカウントを選びます。

スクリプトはログイン中のメールアドレス、アカウント ID、Access チームドメイン、AUD を自動取得します。active zone がある場合、複数なら一覧から選び、ひとつなら自動選択します。続けてサブドメインを入力し、`<入力値>.<zone>` を Worker の Custom Domain に割り当てます。空欄なら `cfmon` を使います。DNS レコードと証明書は Cloudflare が作成し、`workers.dev` は無効にします。active zone がない場合は `workers.dev` を使います。

セットアップは D1 データベースの作成・マイグレーション、Dashboard のビルド、Worker のデプロイ、Access アプリの設定を行います。既存の reusable Allow policy がある場合は選択できます。全員許可・One-time PIN のみ・Service Token 全許可の policy は候補から除外されます。既存 policy を選ばない場合は、ログイン中のメールアドレスだけを許可します。Agent 用の `/api/v1/pair` と `/api/v1/ingest` だけを Access の対象外にします。

公開設定やシークレットの手入力は不要です。Nix CLI の設定は `$XDG_CONFIG_HOME/cfmon/`（未設定なら `$HOME/.config/cfmon/`）に保存され、シェルを閉じても更新に使えます。OAuth 認証情報は `cf` が管理します。実アカウントでのセットアップには Analytics Engine の有効化と Cloudflare 側の利用権限が必要です。

## 更新と dry run

更新時も clone や `nix develop` は不要です。実行時点の flake ソースを使ってビルド・デプロイします。

```sh
nix run github:OJII3/cfmon -- deploy
```

ビルドと設定の検証だけ行う場合は、Cloudflare に接続せず dry run を使えます。

```sh
nix run github:OJII3/cfmon -- deploy --dry-run
```

## clone 済みの開発環境を使う場合

リポジトリを clone した開発環境では、`npm run setup` と `npm run deploy` も使えます。この方法では設定を `worker/.env` と `.cfmon/deployment.json` に保存します。開発手順は [CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。
