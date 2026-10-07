import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const worker = resolve(root, 'worker');
const CF_BIN = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function defaultRunCf(args, { env = process.env, interactive = false } = {}) {
  const result = spawnSync(CF_BIN, ['--no-install', 'cf', ...args], {
    cwd: worker,
    encoding: 'utf8',
    env,
    stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 2 * 1024 * 1024,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function parseOutput(result, command) {
  if (result.status !== 0) {
    const error = new Error(`cf ${command} に失敗しました。Cloudflare CLI のログイン状態と権限を確認してください。`);
    error.status = result.status;
    error.stderr = result.stderr;
    throw error;
  }
  try {
    return result.stdout.trim() ? JSON.parse(result.stdout) : null;
  } catch {
    throw new Error(`cf ${command} がJSONを返しませんでした。Cloudflare CLIを更新して再実行してください。`);
  }
}

function resultOf(value) {
  let current = value;
  for (let i = 0; i < 3 && current && typeof current === 'object' && 'result' in current; i++) {
    current = current.result;
  }
  return current;
}

function listOf(value) {
  const result = resultOf(value);
  if (Array.isArray(result)) return result;
  if (result && typeof result === 'object') {
    for (const key of ['accounts', 'identity_providers', 'apps', 'applications', 'items']) {
      if (Array.isArray(result[key])) return result[key];
    }
  }
  return [];
}

function findEmail(value) {
  const result = resultOf(value);
  const candidates = [result?.email, result?.user?.email, result?.user?.email_address, result?.account?.email];
  return candidates.find((email) => typeof email === 'string' && email.includes('@'));
}

async function chooseAccount(accounts, choose) {
  if (accounts.length === 0) throw new Error('このCloudflare OAuth userで利用できるaccountがありません。');
  if (accounts.length === 1) return accounts[0];
  const selected = await choose(accounts);
  const account = accounts.find((item) => item.id === selected || item.id === selected?.id);
  if (!account) throw new Error('Cloudflare account が選択されませんでした。');
  return account;
}

async function terminalAccountChoice(accounts) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('複数のCloudflare accountがあります。対話端末からセットアップを実行してください。');
  }
  process.stdout.write('使用するCloudflare accountを選択してください:\n');
  accounts.forEach((account, index) => process.stdout.write(`  ${index + 1}. ${account.name ?? account.id}\n`));
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await input.question('番号: ');
    const index = Number(answer) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= accounts.length) {
      throw new Error('account の選択番号が正しくありません。');
    }
    return accounts[index];
  } finally {
    input.close();
  }
}

function cliEnv(accountId) {
  const env = { ...process.env };
  // cf must use its OAuth profile. Never pass an ambient API token into setup.
  delete env.CLOUDFLARE_API_TOKEN;
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  return env;
}

function command(runCf, args, accountId, interactive = false) {
  const cmd = args.join(' ');
  const result = runCf(args, { env: cliEnv(accountId), interactive });
  return parseOutput(result, cmd);
}

function isNotFound(error) {
  return error.status === 1 && /\b404\b|not found|does not exist/i.test(error.stderr ?? '');
}

function normalizedHostname(input) {
  let url;
  try { url = new URL(input.includes('://') ? input : `https://${input}`); }
  catch { throw new Error('Worker のURLをCloudflare Accessに設定できませんでした。'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('WorkerのHTTPS workers.dev URLを指定してください。');
  }
  return url.hostname;
}

function orgDomain(accountId) {
  return `cfmon-${accountId.replaceAll('-', '').slice(0, 12).toLowerCase()}.cloudflareaccess.com`;
}

function managedPolicy(email) {
  return {
    name: 'cfmon-owner',
    decision: 'allow',
    include: [{ email: { email } }],
    exclude: [],
    require: [],
  };
}

function appBody(app, { hostname, email, idpId }) {
  const body = app ? { ...app } : {};
  const destinations = Array.isArray(body.destinations) ? [...body.destinations] : [];
  const targetIndex = destinations.findIndex((destination) => destination.type === 'public' && destination.uri === hostname);
  const target = {
    type: 'public',
    uri: hostname,
    overrides: [
      { behavior: 'public', path_pattern: '/api/v1/pair' },
      { behavior: 'public', path_pattern: '/api/v1/ingest' },
    ],
  };
  if (targetIndex === -1) destinations.push(target);
  else destinations[targetIndex] = target;

  const policies = Array.isArray(body.policies) ? body.policies.filter((policy) => policy.name !== 'cfmon-owner') : [];
  const existingBroadAllow = policies.some((policy) => policy.decision === 'allow' && (policy.include ?? []).some((rule) => 'everyone' in rule || 'any_valid_service_token' in rule));
  if (existingBroadAllow) {
    throw new Error('既存のcfmon Access appに全ユーザー許可policyがあります。既存policyを確認してから再実行してください。');
  }

  for (const key of ['id', 'aud', 'created_at', 'updated_at', 'uid']) delete body[key];
  return {
    ...body,
    name: 'cfmon',
    type: 'self_hosted',
    domain: hostname,
    destinations,
    allowed_idps: [idpId],
    policies: [...policies, managedPolicy(email)],
    session_duration: '24h',
  };
}

/** Log in using cf's browser OAuth and select the account without asking for identifiers. */
export async function loginAndSelectAccount({ runCf = defaultRunCf, selectAccount = terminalAccountChoice } = {}) {
  let whoami;
  try {
    whoami = command(runCf, ['auth', 'whoami']);
  } catch {
    whoami = null;
  }
  let email = findEmail(whoami);
  if (!email) {
    const login = runCf(['auth', 'login'], { env: cliEnv(), interactive: true });
    if (login.status !== 0) throw new Error('Cloudflare OAuth ログインが完了しませんでした。');
    whoami = command(runCf, ['auth', 'whoami']);
    email = findEmail(whoami);
  }
  if (!email) throw new Error('Cloudflare CLIからログイン中のemailを取得できませんでした。cf auth whoami を確認してください。');

  const accounts = listOf(command(runCf, ['accounts', 'list', '--per-page', '100']));
  const envAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const existing = envAccountId && accounts.find((account) => account.id === envAccountId);
  const account = existing ?? await chooseAccount(accounts, selectAccount);
  if (typeof account.id !== 'string' || !account.id) throw new Error('Cloudflare account IDを取得できませんでした。');
  return { accountId: account.id, email };
}

/** Create or reuse only cfmon's Access resources. No token or public value is saved. */
export async function configureAccess({ accountId, email, hostname, runCf = defaultRunCf }) {
  if (typeof accountId !== 'string' || !accountId || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('Cloudflare OAuth account情報を取得できませんでした。');
  }
  hostname = normalizedHostname(hostname);
  const call = (args) => command(runCf, args, accountId);
  let organization;
  try {
    organization = resultOf(call(['zero-trust', 'organization', 'get']));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    organization = resultOf(call(['zero-trust', 'organization', 'create', '--body', JSON.stringify({
      name: 'cfmon',
      auth_domain: orgDomain(accountId),
    })]));
  }
  const teamDomain = organization?.auth_domain;
  if (typeof teamDomain !== 'string' || !teamDomain.endsWith('.cloudflareaccess.com')) {
    throw new Error('Cloudflare Access organization の team domain を取得できませんでした。Access の設定権限を確認してください。');
  }

  const providers = listOf(call(['zero-trust', 'identity-providers', 'list', '--per-page', '100']));
  let idp = providers.find((provider) => provider.type === 'onetimepin');
  if (!idp) {
    idp = resultOf(call(['zero-trust', 'identity-providers', 'create', '--body', JSON.stringify({ name: 'cfmon-email', type: 'onetimepin' })]));
  }
  if (typeof idp?.id !== 'string' || !idp.id) throw new Error('Cloudflare Access email identity provider を取得できませんでした。');

  const apps = listOf(call(['zero-trust', 'access', 'applications', 'list', '--domain', hostname, '--exact', '--per-page', '100']));
  const matches = apps.filter((app) => app.domain === hostname || (app.destinations ?? []).some((destination) => destination.uri === hostname));
  if (matches.length > 1) throw new Error('同じhostnameのAccess appが複数あります。Cloudflare Zero Trustで整理してください。');
  let app = matches[0];
  if (app && app.name !== 'cfmon') {
    throw new Error('同じhostnameにcfmon以外のAccess appがあります。既存policyを保持するため自動変更しません。');
  }
  let response;
  if (!app) {
    response = resultOf(call(['zero-trust', 'access', 'applications', 'create', '--body', JSON.stringify(appBody(null, { hostname, email, idpId: idp.id }))]));
  } else {
    const detail = resultOf(call(['zero-trust', 'access', 'applications', 'get', app.id]));
    const body = appBody(detail, { hostname, email, idpId: idp.id });
    response = resultOf(call(['zero-trust', 'access', 'applications', 'update', app.id, '--body', JSON.stringify(body)]));
  }
  const aud = response?.aud ?? response?.aud_tag ?? app?.aud;
  if (typeof aud !== 'string' || !aud) throw new Error('Cloudflare Access app の AUD を取得できませんでした。');
  return { teamDomain, aud };
}
