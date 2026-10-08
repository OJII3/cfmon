import { bindings, defineConfig, triggers } from "cf/config";

/**
 * Secret-like files were detected but not read or migrated: .dev.vars.example. Only `secrets.required` entries are migrated.
 * @see https://developers.cloudflare.com/workers/configuration/secrets/
 */

export default defineConfig({
	...(process.env.CLOUDFLARE_ACCOUNT_ID
		? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID }
		: {}),
	worker: {
		name: "cfmon",
		compatibilityDate: "2026-10-07",
		entrypoint: "src/index.ts",
		domains: process.env.CFMON_CUSTOM_DOMAIN
			? [process.env.CFMON_CUSTOM_DOMAIN]
			: [],
		workersDev: !process.env.CFMON_CUSTOM_DOMAIN,
		assets: {
			runWorkerFirst: [
				"/api/*",
			],
		},
		triggers: [
			triggers.scheduled({
				schedule: "*/15 * * * *",
			}),
		],
			env: {
			ACCESS_TEAM_DOMAIN: bindings.text(
				process.env.CFMON_ACCESS_TEAM_DOMAIN ?? "setup-pending.cloudflareaccess.com",
			),
			ACCESS_AUD: bindings.text(process.env.CFMON_ACCESS_AUD ?? "setup-pending"),
			METRICS: bindings.analyticsEngineDataset({
				name: "cfmon_metrics",
			}),
			REGISTRY: bindings.d1({
				name: "cfmon-registry",
				id: process.env.CFMON_D1_ID ?? "00000000-0000-0000-0000-000000000000",
			}),
			ANALYTICS_SQL: bindings.analyticsSQL({}),
			PAIR_RATE_LIMIT: bindings.rateLimit({
				namespace: "1001",
				simple: {
					limit: 20,
					period: 60,
				},
			}),
			ASSETS: bindings.assets(),
		},
	},
});
