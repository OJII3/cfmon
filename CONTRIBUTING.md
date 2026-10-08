# 開発・検証

## ローカル開発

```sh
nix develop
(cd worker && npm ci && npx wrangler d1 migrations apply REGISTRY --local)
(cd dashboard && npm ci && npm run build)
npm run dev
# 別ターミナル
(cd dashboard && npm run dev)
```

認証の開発用迂回は `DEVELOPMENT=true` かつ loopback URL のリクエストだけに適用します。本番デプロイにこの設定を含めないでください。ローカルでは登録・承認・署名付き送信を検証できますが、Analytics Engine の保存・照会は本番を再現しません。

## 検証

```sh
node --test scripts/setup-cloudflare.test.ts
npm run test:pairing
(cd worker && npm run typecheck && npm test)
(cd dashboard && npm run build)
npm run deploy -- --dry-run
(cd agent && moon check --target native && moon test --target native && moon build --target native)
```

GitHub Actions でも検証を実行します。Actions の依存は `gh actions-lock` と `.github/workflows/actions.lock` で管理します。
