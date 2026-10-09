# Agent の運用

## インストールと承認

Dashboard の「インストールコマンドをコピー」を押し、監視するホストで実行します。Worker URL はコマンドに含まれます。インストーラーはチェックサムを検証したネイティブ Agent をダウンロードし、ユーザー領域に配置します。MoonBit、Node.js、C 開発環境は不要です。インストールコマンドを再実行すると最新版に更新してサービスを再起動します。

Linux x86_64 / arm64（Raspberry Pi など）と macOS arm64 に対応しています。

Agent は初回起動時に Ed25519 鍵を作り、公開指紋を表示して承認を待ちます。Dashboard の指紋と Agent 側の SHA-256 指紋が一致することを確認してから承認してください。ホスト名だけでは承認しないでください。承認後にメトリクスの送信が始まります。

## ログ

Linux では systemd user service を使います。

```sh
journalctl --user -u cfmon-agent -f
```

systemd user service がない Linux 環境では、インストーラーが表示するコマンドで Agent を起動できます。macOS のログは `$HOME/Library/Logs/cfmon-agent.log` にあります。

## 保存先と設定

- Agent バイナリ: `$HOME/.local/bin/cfmon-agent`
- Agent の接続設定: `$HOME/.config/cfmon/agent.env`
- 秘密鍵: `$XDG_STATE_HOME/cfmon`（未設定時は `$HOME/.local/state/cfmon`）

Agent の設定は環境変数で変更できます。

| 変数 | 説明 |
| --- | --- |
| `CFMON_URL` | ingest の完全な URL。本番では HTTPS、ローカルテストでは loopback HTTP を使用します。 |
| `CFMON_HOST` | 省略時は OS の hostname。1〜128文字で、英数字で始まり、英数字・`.`・`_`・`-` を使用できます。ホストごとに異なる ID を使ってください。 |
| `CFMON_INTERVAL_SECONDS` | 送信間隔。既定値は30秒です。 |
| `CFMON_STATE_DIR` | 鍵を保存するディレクトリ。既定値は `$XDG_STATE_HOME/cfmon`、未設定時は `$HOME/.local/state/cfmon` です。 |

## 鍵の失効と再登録

秘密鍵は Agent が管理します。同じ鍵で再起動すれば再承認は不要です。Dashboard で登録を解除すると送信権限が失効します。再登録する場合は Agent を停止し、新しい状態ディレクトリで起動して、表示される指紋を確認してから承認してください。

## 収集メトリクス

CPU、メモリ、ロード、ルートディスク、ネットワーク RX/TX、uptime を収集します。温度、サービス状態、アラート、R2 保存は含みません。

- Linux の CPU は `/proc/stat` の差分、メモリは `MemAvailable` を使います。
- macOS の CPU・メモリは Mach の統計、ロードは `getloadavg` を使います。
- 両 OS ともディスクは `/` の statvfs、ネットワークは loopback を除くインターフェースのカウンタ差分です。
- ネットワークの単位は bytes/second です。仮想インターフェースも含むため、ブリッジやコンテナ環境では同じ通信が複数回数えられる場合があります。

CPU・メモリ・ディスクは0〜1、その他は非負の数値です。ホスト一覧は過去24時間、グラフは過去1時間の1分集計です。サンプリングを考慮した加重平均を表示します。時刻は Worker の受信時刻で、Analytics Engine への反映には遅延があります。

送信する JSON の例:

```json
{"host":"bronya","os":"linux","cpu":0.32,"memory":0.71,"load1":1.42,"disk":0.51,"rx_bps":120340,"tx_bps":58321,"uptime":93211}
```

Analytics Engine では `index1=host`、`blob1=host`、`blob2=os`、`double1..7=cpu,memory,load1,disk,rx_bps,tx_bps,uptime` として保存します。
