# cfmon

Linux x86_64 または macOS arm64 のホストを監視し、メトリクスを Cloudflare に保存・表示するツールです。ホストには MoonBit のネイティブ Agent をインストールします。API トークンや共有シークレットの発行・入力は不要です。

## セットアップ

Cloudflare アカウントで Workers Analytics Engine を有効にしたうえで、Nix が使える端末から実行します。

```sh
nix run github:OJII3/cfmon -- setup
```

表示された URL をブラウザで開いて Cloudflare OAuth を承認してください。セットアップが Worker と Dashboard をデプロイし、Dashboard の URL を表示します。詳しい前提条件や設定内容は [Cloudflare セットアップ](docs/cloudflare-setup.md) を参照してください。

## ホストを追加する

1. Dashboard にログインし、「インストールコマンドをコピー」を押します。
2. 監視する Linux x86_64 または macOS arm64 ホストでコマンドを実行します。
3. Dashboard に表示される SHA-256 指紋を確認して Agent を承認します。

Agent はログイン時に自動起動します。インストール、ログ確認、鍵の管理については [Agent の運用](docs/operations.md) を参照してください。

## 更新

Cloudflare にデプロイした端末から実行します。

```sh
nix run github:OJII3/cfmon -- deploy
```

## ドキュメント

- [Cloudflare セットアップの詳細](docs/cloudflare-setup.md)
- [Agent の運用とメトリクス](docs/operations.md)
- [API と認証の仕様](docs/api.md)
- [開発・検証](CONTRIBUTING.md)
