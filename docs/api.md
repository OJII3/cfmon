# API と認証

## エンドポイント

| Method | Path | 認証 |
| --- | --- | --- |
| POST | `/api/v1/pair` | 自動生成された Agent トークン (`Authorization: Bearer <token_hex>`)。承認待ちは202、承認済みは200（Access Service Token を配布） |
| POST | `/api/v1/ingest` | Cloudflare Access Service Token (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) + 承認済み Agent トークン (`Authorization: Bearer <token_hex>`)。host は登録内容と一致必須 |
| GET | `/api/v1/hosts` | Cloudflare Access |
| GET | `/api/v1/hosts/:id/metrics` | Cloudflare Access |
| GET | `/api/v1/agents` | Cloudflare Access |
| POST | `/api/v1/agents/:public_key/approve` | Cloudflare Access、同一 Origin、指紋一致 |
| POST | `/api/v1/agents/:public_key/revoke` | Cloudflare Access、同一 Origin |

## Agent ペアリングと Service Token 認証

Agent は初回起動時に 32 バイトの乱数トークン (`agent.token`) を自動生成し、その SHA-256 指紋 (`fingerprint`) を表示して `POST /api/v1/pair` に `Authorization: Bearer <64-char-hex>` で申請します。D1 には生のトークンではなく SHA-256 ハッシュのみを保存します。承認待ちの有効期限は最後の申請から15分です。

管理者が Dashboard 上で指紋の一致を確認して承認すると、次回の `POST /api/v1/pair` が `200 OK` で Cloudflare Access Service Token (`access_client_id`, `access_client_secret`) を返します。Agent はこれを `service.token` (mode `0600`) に保存し、以降の `POST /api/v1/ingest` では `CF-Access-Client-Id`・`CF-Access-Client-Secret` と `Authorization: Bearer <token_hex>` の両方を送信します。

## Access

Cloudflare Access アプリケーションでは、ペアリング用の `/api/v1/pair` のみを public override とし、`/api/v1/ingest` は `cfmon-agent` Service Token (`non_identity` policy) でエッジ保護します。さらに Worker 側でも Service Token ヘッダーまたは Access JWT (`common_name`) と Agent トークンの両方を検証し、Dashboard で失効 (`revoked`) された Agent を個別に拒否します。

人間向けの閲覧・管理 API (`/api/v1/hosts`, `/api/v1/agents` など) では、Worker は Access JWT の署名・issuer・audience・期限・`email` クレームを検証します（Service Token では管理 API にアクセスできません）。登録申請 (`/api/v1/pair`) には IP ごとのレート制限を設けています。

参照: [Analytics SQL binding](https://developers.cloudflare.com/analytics/sql-api/workers-binding/)、[Cloudflare Access JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[Cloudflare Access Service Tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)、[MoonBit C FFI](https://docs.moonbitlang.com/en/latest/language/ffi.html)。
