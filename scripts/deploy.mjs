import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { loginAndSelectAccount, configureAccess } from './setup-cloudflare.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const worker = resolve(root, 'worker');
const envPath = resolve(worker, '.env');
const setup = process.argv.includes('--setup');
const dryRun = process.argv.includes('--dry-run');

function run(command, args, cwd, { capture = false, env = process.env } = {}) {
  const child = spawnSync(command, args, {
    cwd, env, encoding: 'utf8',
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    const details = child.stderr?.trim();
    throw new Error(`${command} ${args[0]} に失敗しました${details ? `: ${details}` : ''}`);
  }
  return capture ? { stdout: child.stdout ?? '', stderr: child.stderr ?? '' } : undefined;
}

function runCf(args, options = {}) {
  const env = { ...process.env, ...options.env };
  delete env.CLOUDFLARE_API_TOKEN;
  return run('npx', ['--no-install', 'cf', ...args], worker, { ...options, env });
}

function unwrap(value) {
  let current = value;
  for (let i = 0; i < 3 && current && typeof current === 'object' && 'result' in current; i++) current = current.result;
  return current;
}

function parseJson(text, label) {
  try { return unwrap(JSON.parse(text)); }
  catch { throw new Error(`${label} の結果を読み取れませんでした`); }
}

function listOf(value) {
  const data = unwrap(value);
  if (Array.isArray(data)) return data;
  for (const key of ['databases', 'result', 'items']) if (Array.isArray(data?.[key])) return data[key];
  return [];
}

async function saveLocalConfig({ accountId, databaseId, teamDomain, aud }) {
  const rows = [
    `CLOUDFLARE_ACCOUNT_ID=${accountId}`,
    `CFMON_D1_ID=${databaseId}`,
    `CFMON_ACCESS_TEAM_DOMAIN=${teamDomain ?? 'setup-pending.cloudflareaccess.com'}`,
    `CFMON_ACCESS_AUD=${aud ?? 'setup-pending'}`,
  ];
  await writeFile(envPath, `${rows.join('\n')}\n`, { mode: 0o600 });
}

async function deploy() {
  const result = runCf(['deploy'], { capture: true });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  const url = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0];
  if (!url) throw new Error('デプロイ結果から Worker URL を取得できませんでした');
  return url;
}

async function main() {
  if (setup && dryRun) throw new Error('--setup と --dry-run は同時に指定できません');
  run('npm', ['ci'], worker);
  if (setup) {
    const { accountId, email } = await loginAndSelectAccount();
    const localEnv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };
    delete localEnv.CLOUDFLARE_API_TOKEN;
    const databaseResult = runCf(['d1', 'list', '--per-page', '100'], { capture: true, env: localEnv });
    const databases = listOf(parseJson(databaseResult.stdout, 'D1一覧'));
    const databaseName = 'cfmon-registry';
    let database = databases.find((item) => item.name === databaseName);
    if (!database) {
      const created = runCf(['d1', 'create', '--name', databaseName], { capture: true, env: localEnv });
      database = parseJson(created.stdout, 'D1作成');
    }
    const databaseId = database?.uuid ?? database?.id;
    if (typeof databaseId !== 'string' || !databaseId) throw new Error('D1のIDを取得できませんでした');
    await saveLocalConfig({ accountId, databaseId });

    run('npm', ['ci'], resolve(root, 'dashboard'));
    run('npm', ['run', 'build'], resolve(root, 'dashboard'));
    runCf(['d1', 'migrations', 'apply', databaseId, '--dir', 'migrations']);
    console.log('Worker を初回デプロイしています…');
    let url = await deploy();
    const { teamDomain, aud } = await configureAccess({ accountId, email, hostname: url });
    await saveLocalConfig({ accountId, databaseId, teamDomain, aud });
    console.log('Access 認証を反映しています…');
    url = await deploy();
    await mkdir(resolve(root, '.cfmon'), { recursive: true });
    await writeFile(resolve(root, '.cfmon/deployment.json'), `${JSON.stringify({ url }, null, 2)}\n`);
    console.log(`セットアップ完了: ${url}\nAgent 起動: npm run agent`);
    return;
  }

  if (!dryRun) {
    const local = await readFile(envPath, 'utf8').catch(() => {
      throw new Error('初回は npm run setup を実行してください');
    });
    if (!/^CFMON_D1_ID=(?!0+$).+/m.test(local) || !/^CFMON_ACCESS_TEAM_DOMAIN=(?!setup-pending).+/m.test(local) || !/^CFMON_ACCESS_AUD=(?!setup-pending$).+/m.test(local)) {
      throw new Error('セットアップが未完了です。npm run setup を実行してください');
    }
  }
  run('npm', ['ci'], resolve(root, 'dashboard'));
  run('npm', ['run', 'build'], resolve(root, 'dashboard'));
  if (dryRun) {
    runCf(['deploy', '--dry-run']);
    return;
  }
  const url = await deploy();
  await mkdir(resolve(root, '.cfmon'), { recursive: true });
  await writeFile(resolve(root, '.cfmon/deployment.json'), `${JSON.stringify({ url }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
