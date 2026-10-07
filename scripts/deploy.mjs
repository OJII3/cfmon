import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { loginAndSelectAccount, configureAccess } from './setup-cloudflare.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const worker = resolve(root, 'worker');
const configPath = resolve(worker, 'wrangler.local.json');
const setup = process.argv.includes('--setup');
const dryRun = process.argv.includes('--dry-run');

function run(command, args, cwd = worker, capture = false) {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
  return result.stdout;
}
const wrangler = (args, capture = false) => run('npx', ['--no-install', 'wrangler', ...args], worker, capture);

async function main() {
  if (setup && dryRun) throw new Error('--setup と --dry-run は同時に指定できません');
  run('npm', ['ci']);
  let ownerEmail;
  let config = JSON.parse(await readFile(resolve(worker, 'wrangler.jsonc'), 'utf8'));
  if (setup) {
    const { accountId, email } = await loginAndSelectAccount();
    ownerEmail = email;
    config.account_id = accountId;
    config.vars = {};
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    wrangler(['login']);
    const databases = JSON.parse(wrangler(['d1', 'list', '--json', '--config', configPath], true));
    const name = config.d1_databases[0].database_name;
    const existing = databases.find((database) => database.name === name);
    if (existing) {
      config.d1_databases[0].database_id = existing.uuid;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    } else {
      const binding = config.d1_databases[0];
      config.d1_databases = [];
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
      wrangler(['d1', 'create', name, '--binding', binding.binding, '--update-config', '--config', configPath]);
      config = JSON.parse(await readFile(configPath, 'utf8'));
      config.d1_databases[0].migrations_dir = binding.migrations_dir;
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    }
  } else if (!dryRun) {
    config = JSON.parse(await readFile(configPath, 'utf8').catch(() => {
      throw new Error('初回は npm run setup を実行してください');
    }));
    if (config.vars?.DEVELOPMENT) throw new Error('開発用の認証迂回設定をデプロイできません');
    if (!config.account_id || !config.vars?.ACCESS_TEAM_DOMAIN || !config.vars?.ACCESS_AUD || !config.d1_databases?.[0]?.database_id || /^0+$/.test(config.d1_databases[0].database_id.replaceAll('-', ''))) {
      throw new Error('セットアップが未完了です。npm run setup を実行してください');
    }
  }
  run('npm', ['ci'], resolve(root, 'dashboard'));
  run('npm', ['run', 'build'], resolve(root, 'dashboard'));
  if (!dryRun) wrangler(['d1', 'migrations', 'apply', 'REGISTRY', '--remote', '--config', configPath]);
  if (dryRun) {
    wrangler(['deploy', '--dry-run']);
    return;
  }
  const deploy = () => {
    const output = wrangler(['deploy', '--config', configPath], true);
    process.stdout.write(output);
    const url = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0];
    if (!url) throw new Error('デプロイ結果から Worker URL を取得できませんでした');
    return url;
  };
  console.log('Worker をデプロイしています…');
  let url = deploy();
  if (setup) {
    const { teamDomain, aud } = await configureAccess({ accountId: config.account_id, email: ownerEmail, hostname: url });
    config.vars = { ACCESS_TEAM_DOMAIN: teamDomain, ACCESS_AUD: aud };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    url = deploy();
  }
  await mkdir(resolve(root, '.cfmon'), { recursive: true });
  await writeFile(resolve(root, '.cfmon/deployment.json'), `${JSON.stringify({ url }, null, 2)}\n`);
  console.log(`セットアップ完了: ${url}\nAgent 起動: npm run agent`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
