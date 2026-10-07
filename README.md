# cfmon

Linux ホストのメトリクスを MoonBit のネイティブエージェントで収集し、Cloudflare で保存・表示する最小構成です。

```text
Linux host → MoonBit agent → HTTPS Worker → Analytics Engine
                                   ↑
                            React Dashboard
```

- `agent/`: CPU、メモリ、ロード、ルートファイルシステムの使用率、ネットワーク転送速度、uptime を収集して JSON POST。
- `worker/`: 認証・入力検証・Analytics Engine への書き込みと照会。
- `dashboard/`: ホスト一覧、数値カード、CPU・メモリ・RX/TX グラフ。Worker の static assets として同じオリジンから配信。

Linux 専用です。温度、systemd 状態、通知、D1、R2 はまだ含みません。

## 開発環境

```sh
nix develop
(cd worker && npm ci)
(cd dashboard && npm ci)
(cd dashboard && npm run build)
(cd agent && moon build --target native)
```

MoonBit の OS 操作と HTTPS 通信には小さな C FFI と libcurl を使います。Nix devShell にコンパイラ、libcurl、pkg-config が入っています。Nix を使わない場合は MoonBit、Node.js、C コンパイラ、libcurl の開発パッケージ、pkg-config を用意してください。

## Cloudflare の設定とデプロイ

Cloudflare アカウントで Workers Analytics Engine を有効にします。`worker/wrangler.jsonc` の `cfmon_metrics` がデータセット名です。最初の書き込みでデータセットが作成されます。

```sh
cd worker
npx wrangler login
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put INGEST_TOKEN
npx wrangler secret put QUERY_TOKEN
npm run deploy
```

- `CF_ACCOUNT_ID`: Cloudflare のアカウント ID。
- `CF_API_TOKEN`: 対象アカウントの **Account Analytics:Read** 権限を持つ API トークン。Worker 内だけで使用します。
- `INGEST_TOKEN`: エージェントの送信認証用に作成したランダムな値。
- `QUERY_TOKEN`: Dashboard の閲覧認証用に作成した別のランダムな値。

デプロイ前に `dashboard` をビルドしてください。公開 URL を開き、QUERY_TOKEN を入力すると Dashboard が表示されます。閲覧トークンはブラウザのメモリだけに保持し、再読み込み時は再入力します。

## エージェントの起動

```sh
cd agent
moon run src --target native -- --print

export CFMON_URL=https://cfmon.YOUR-SUBDOMAIN.workers.dev/api/v1/ingest
export CFMON_TOKEN=YOUR_INGEST_TOKEN
export CFMON_HOST=bronya
export CFMON_INTERVAL_SECONDS=30
moon run src --target native -- --once
moon run src --target native
```

`CFMON_HOST` の省略時は OS の hostname を使用します。ホスト ID は英数字で始まる 1〜128 文字で、英数字・`.`・`_`・`-` が使えます。複数ホストでは異なる ID を指定してください。`CFMON_URL` は ingest の完全な URL です。本番は HTTPS を使います。

CPU とネットワーク速度はカウンタ差分から計算します。メモリは `MemAvailable`、ディスクは `/` の statvfs、ネットワークは loopback を除くインターフェースの合計です。ネットワークの単位は **bytes/second** です。仮想インターフェースも含むため、コンテナやブリッジ環境では同じ通信が複数回数えられる場合があります。

## API とデータ

| Method | Path | 認証 | レスポンス |
| --- | --- | --- | --- |
| POST | `/api/v1/ingest` | Bearer INGEST_TOKEN | `202 {"ok":true}` |
| GET | `/api/v1/hosts` | Bearer QUERY_TOKEN | `{hosts:[{id,hostname,os,last_seen}]}` |
| GET | `/api/v1/hosts/:id/metrics` | Bearer QUERY_TOKEN | `{host,metrics:[{timestamp,cpu,memory,load1,disk,rx_bps,tx_bps,uptime}]}` |

```json
{"host":"bronya","os":"Linux","cpu":0.32,"memory":0.71,"load1":1.42,"disk":0.51,"rx_bps":120340,"tx_bps":58321,"uptime":93211}
```

CPU・メモリ・ディスクは 0〜1、ほかは非負の数値です。Analytics Engine には `index1=host`、`blob1=host`、`blob2=os`、`double1..7=cpu,memory,load1,disk,rx_bps,tx_bps,uptime` として保存します。

ホスト一覧は過去24時間に送信したホスト、グラフは過去1時間の1分集計です。Analytics Engine のサンプリングを考慮した加重平均を使用します。表示値は最新の集計バケットの値です。時刻は Worker の受信時刻を使用します。Analytics Engine への反映には遅延があります。

## ローカル開発と検証

`worker/.dev.vars.example` を `worker/.dev.vars` にコピーして設定します。これは Git に含まれません。

```sh
(cd worker && npm run dev)
# 別ターミナル
(cd dashboard && npm run dev)
```

Vite は `/api` を `localhost:8787` に転送します。ローカル Analytics Engine binding は本番の保存・照会を再現しません。実データの照会には Cloudflare の設定が必要です。

```sh
(cd worker && npm run typecheck && npm test)
(cd dashboard && npm run build)
(cd worker && npx wrangler deploy --dry-run)
(cd agent && moon check --target native && moon test --target native && moon build --target native)
```

GitHub Actions は同じ検証を実行します。Actions の依存関係は `gh actions-lock` と `.github/workflows/actions.lock` で管理します。

参照: [Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)、[MoonBit C FFI](https://docs.moonbitlang.com/en/latest/language/ffi.html)。
