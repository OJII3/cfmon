# API と認証

## エンドポイント

| Method | Path | 認証 |
| --- | --- | --- |
| POST | `/api/v1/pair` | 自動生成鍵による署名。承認待ちは202、承認済みは200 |
| POST | `/api/v1/ingest` | 承認済み鍵による署名。host は登録内容と一致必須 |
| GET | `/api/v1/hosts` | Cloudflare Access |
| GET | `/api/v1/hosts/:id/metrics` | Cloudflare Access |
| GET | `/api/v1/agents` | Cloudflare Access |
| POST | `/api/v1/agents/:public_key/approve` | Cloudflare Access、同一 Origin、指紋一致 |
| POST | `/api/v1/agents/:public_key/revoke` | Cloudflare Access、同一 Origin |

## Agent 署名

Agent の署名対象は `POST\npathname\ntimestamp\nnonce\nbody` の UTF-8 バイト列です。公開鍵と署名には Ed25519 を使い、指紋は公開鍵32バイトの SHA-256 です。

署名ヘッダーは `X-Cfmon-Key`、`X-Cfmon-Timestamp`、`X-Cfmon-Nonce`、`X-Cfmon-Signature` です。時刻の許容差は5分です。D1 の一意制約で nonce の再利用を拒否し、失効鍵を再登録できないようにします。承認待ちの有効期間は最後の申請から15分です。

## Access

Worker は Access JWT の署名・issuer・audience・期限を検証します。Access の許可対象は管理者に限定してください。登録申請には IP ごとのレート制限を設けています。

Access の設定がない場合や JWT が不正な場合、閲覧と Agent 管理 API は拒否されます。

参照: [Analytics SQL binding](https://developers.cloudflare.com/analytics/sql-api/workers-binding/)、[Cloudflare Access JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[MoonBit C FFI](https://docs.moonbitlang.com/en/latest/language/ffi.html)。
