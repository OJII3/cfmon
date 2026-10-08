# cfmon

Linux または macOS ホストを MoonBit のネイティブエージェントで監視し、Cloudflare に保存・表示します。API トークンや共有シークレットを発行・コピー・入力する必要はありません。

```text
Linux / macOS host → MoonBit Agent → 署名付き HTTPS → Worker → Analytics Engine
                                               ↑          ↓
                                         D1 登録台帳   Analytics SQL binding
                                               ↑          ↓
                                    Access ログイン → Dashboard
```

- `agent/`: CPU、メモリ、ロード、ルートディスク、RX/TX、uptime を収集。秘密鍵は自動生成・保存し、送信に署名します。
- `worker/`: Agent の公開鍵登録・承認・失効、署名検証、Analytics Engine への書き込み・照会。
- `dashboard/`: Cloudflare Access でログインして Agent を承認。ホスト一覧、数値カード、CPU・メモリ・ネットワークグラフを表示します。
- D1: 公開鍵と承認状態、再送検知用 nonce を保存します。秘密鍵は保存しません。

Cloudflare の設定・リソース作成・デプロイには `cf` CLI を使います。Analytics SQL binding を含む `cloudflare.config.ts` に移行済みで、初回認証は1回です。ビルドは `cf` がWrangler bundlerへ委譲します。

Agent は Linux x86_64 と macOS arm64 に対応します。温度、サービス状態、アラート、R2 はまだ含みません。

## 初回セットアップ

Cloudflare アカウントで Workers Analytics Engine を有効にしてください。照会には Analytics SQL binding を使用します（SQL API は Beta）。Worker 自身のアカウント権限で照会するため、Analytics 用 API トークンは不要です。

Nix が使える環境なら、リポジトリを clone せずに初回セットアップできます。

```sh
nix run github:OJII3/cfmon -- setup
```

Cloudflare OAuth の認可 URL を開いて承認してください。複数のアカウントがある場合だけ、表示された一覧から使用するアカウントを選びます。Nix がソースと Node.js を用意し、依存関係のインストールからデプロイまで実行します。設定は `$XDG_CONFIG_HOME/cfmon/`（未設定なら `$HOME/.config/cfmon/`）に保存されるため、シェルを閉じても更新に使えます。

初回は `cf` で1回だけ認可します。URL と確認コードが表示されるので、ローカル・SSH・コンテナのどこからでも、別端末のブラウザで開いて承認できます。コードの有効時間内に承認してください。

メールアドレス、アカウント ID、Worker URL、Access チームドメイン、AUD は自動取得します。active zone がある場合、複数なら一覧から選び、ひとつなら自動選択します。続けてサブドメインを入力し、`<入力値>.<zone>` を Worker の Custom Domain に割り当てます。空欄なら `cfmon` を使います。DNS レコードと証明書は Cloudflare が作成し、`workers.dev` は無効にします。zone がない場合は従来どおり `workers.dev` を使います。

スクリプトは D1 の作成・マイグレーション、Dashboard ビルド、Worker デプロイ、Access アプリ設定を行います。既存の reusable Allow policy がある場合は選択でき、全員・One-time PIN だけ・Service Token 全許可の policy は候補から除外します。既存 policy を選ばない場合は、ログイン中のメールアドレスだけを許可する設定を使います。Agent 用の2パスだけを Access の対象外にします。公開設定もシークレットも手入力しません。

Nix CLI の公開設定と接続先は `$XDG_CONFIG_HOME/cfmon/`（未設定なら `$HOME/.config/cfmon/`）に保存されます。clone 済みの開発環境では `worker/.env` と `.cfmon/deployment.json` に保存します。OAuth 認証情報は `cf` が管理します。Access が未設定・JWT が不正な場合、閲覧と承認 API は拒否されます。実アカウントでの初回実行には Analytics Engine の有効化と Cloudflare 側の利用権限が必要です。

更新も clone や `nix develop` は不要で、次の1コマンドです。実行時点の flake ソースを使ってビルド・デプロイします。

```sh
nix run github:OJII3/cfmon -- deploy
```

ビルドと設定の検証だけなら、Cloudflare に接続せずに次を実行できます。

```sh
nix run github:OJII3/cfmon -- deploy --dry-run
```

従来どおり clone 済みの開発環境から `npm run setup` / `npm run deploy` を使うこともできます。

## Agent を登録する

Dashboard の「インストールコマンドをコピー」を押し、監視する Linux x86_64 または macOS ホストのターミナルで実行します。Worker URL はコマンドに含まれるため、入力やリポジトリの clone は不要です。

インストーラーはチェックサムを検証したネイティブ Agent をダウンロードし、ユーザー領域に配置します。Linux では systemd user service、macOS では LaunchAgent を使ってログイン時に起動します。MoonBit、Node.js、C 開発環境は必要ありません。インストールコマンドをもう一度実行すると、最新版に更新してサービスを再起動します。

Agent は初回に Ed25519 鍵を作り、公開指紋を出力して承認を待ちます。次のコマンドで指紋を確認し、Dashboard に表示された **SHA-256 指紋と一致することを確認して承認**してください。ホスト名だけでは承認しないでください。承認後にメトリクスの送信が始まります。

```sh
journalctl --user -u cfmon-agent -f
```

systemd user service がない Linux 環境では、インストーラーが表示するコマンドで Agent を起動できます。macOS のログは `$HOME/Library/Logs/cfmon-agent.log` で確認できます。Agent は `$HOME/.local/bin/cfmon-agent`、秘密鍵は `$XDG_STATE_HOME/cfmon`（未設定時 `$HOME/.local/state/cfmon`）に保存します。

- `CFMON_URL`: ingest の完全な URL。本番は HTTPS、ローカルテストのみ loopback HTTP を許可します。
- `CFMON_HOST`: 省略時は OS の hostname。英数字で始まる1〜128文字で、英数字・`.`・`_`・`-` が使えます。ホストごとに異なる ID を使ってください。
- `CFMON_INTERVAL_SECONDS`: 送信間隔。既定は30秒。
- `CFMON_STATE_DIR`: 鍵を自動保存するディレクトリの指定。既定は `$XDG_STATE_HOME/cfmon`、未設定時は `$HOME/.local/state/cfmon`。

秘密鍵は Agent が管理します。同じ鍵で再起動すれば再承認は不要です。Dashboard の登録解除で送信権限を失効できます。再登録する場合は Agent を止め、新しい状態ディレクトリで起動し、再度指紋を確認して承認します。既存の秘密鍵を出力・コピーする操作は不要です。

```sh
moon run src --target native -- --print  # メトリクス JSON の表示のみ。鍵の作成・通信はしない
moon run src --target native -- --once   # 登録申請・承認状態を確認して一度送信
moon build --target native              # 常駐用ネイティブ実行ファイルをビルド
```

`--once` で承認待ちの場合は指紋を表示して終了します。承認後に再実行してください。

## メトリクス

Linux では CPU は `/proc/stat` の差分、メモリは `MemAvailable` を使います。macOS では Mach の CPU・メモリ統計と `getloadavg` を使います。両 OS ともディスクは `/` の statvfs、ネットワークは loopback を除くインターフェースのカウンタ差分です。ネットワークの単位は **bytes/second** です。仮想インターフェースも含むため、ブリッジ・コンテナ環境では同じ通信が複数回数えられる場合があります。

```json
{"host":"bronya","os":"linux","cpu":0.32,"memory":0.71,"load1":1.42,"disk":0.51,"rx_bps":120340,"tx_bps":58321,"uptime":93211}
```

CPU・メモリ・ディスクは0〜1、ほかは非負の数値。Analytics Engine の `index1=host`、`blob1=host`、`blob2=os`、`double1..7=cpu,memory,load1,disk,rx_bps,tx_bps,uptime` に保存します。

ホスト一覧は過去24時間、グラフは過去1時間の1分集計です。サンプリングを考慮した加重平均を表示します。時刻は Worker の受信時刻で、Analytics Engine への反映には遅延があります。

## API と認証

| Method | Path | 認証 |
| --- | --- | --- |
| POST | `/api/v1/pair` | 自動生成鍵による署名。承認待ち202、承認済み200 |
| POST | `/api/v1/ingest` | 承認済み鍵による署名。host は登録内容と一致必須 |
| GET | `/api/v1/hosts` | Cloudflare Access |
| GET | `/api/v1/hosts/:id/metrics` | Cloudflare Access |
| GET | `/api/v1/agents` | Cloudflare Access |
| POST | `/api/v1/agents/:public_key/approve` | Cloudflare Access、同一 Origin、指紋一致 |
| POST | `/api/v1/agents/:public_key/revoke` | Cloudflare Access、同一 Origin |

Agent の署名対象は `POST\npathname\ntimestamp\nnonce\nbody` の UTF-8 バイト列です。公開鍵・署名は Ed25519、指紋は公開鍵32バイトの SHA-256。署名ヘッダーは `X-Cfmon-Key`、`X-Cfmon-Timestamp`、`X-Cfmon-Nonce`、`X-Cfmon-Signature`。時刻の許容差は5分です。D1 の一意制約で nonce 再利用を拒否し、失効鍵を再登録できないようにします。承認待ちの有効期間は最後の申請から15分です。

Worker は Access JWT の署名・issuer・audience・期限を検証します。Access の許可対象は管理者に限定してください。登録申請には IP ごとのレート制限を設けています。

## ローカル開発・検証

```sh
nix develop
(cd worker && npm ci && npx wrangler d1 migrations apply REGISTRY --local)
(cd dashboard && npm ci && npm run build)
npm run dev
# 別ターミナル
(cd dashboard && npm run dev)
```

認証の開発用迂回は `DEVELOPMENT=true` かつ loopback URL のリクエストだけに適用します。本番デプロイにこの設定を含めないでください。ローカルでは登録・承認・署名付き送信を検証できますが、Analytics Engine の保存・照会は本番を再現しません。

```sh
node --test scripts/setup-cloudflare.test.ts
npm run test:pairing
(cd worker && npm run typecheck && npm test)
(cd dashboard && npm run build)
npm run deploy -- --dry-run
(cd agent && moon check --target native && moon test --target native && moon build --target native)
```

GitHub Actions も検証を実行します。Actions の依存は `gh actions-lock` と `.github/workflows/actions.lock` で管理します。

参照: [Analytics SQL binding](https://developers.cloudflare.com/analytics/sql-api/workers-binding/)、[Cloudflare Access JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[MoonBit C FFI](https://docs.moonbitlang.com/en/latest/language/ffi.html)。
