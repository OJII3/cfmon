import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const workerDir = resolve(root, 'worker');

function cliEnv(accountId) {
  const env = { ...process.env };
  delete env.CLOUDFLARE_API_TOKEN;
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  else delete env.CLOUDFLARE_ACCOUNT_ID;
  return env;
}

function defaultRunCf(args, { env = cliEnv(), interactive = false } = {}) {
  const child = spawnSync('npx', ['--no-install', 'cf', ...args], {
    cwd: workerDir,
    env,
    encoding: 'utf8',
    stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  return {
    status: child.status ?? 1,
    stdout: child.stdout ?? '',
    stderr: child.stderr ?? '',
  };
}

function unwrap(value) {
  let current = value;
  for (let i = 0; i < 3 && current && typeof current === 'object' && 'result' in current; i++) {
    current = current.result;
  }
  return current;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} のJSONを読み取れませんでした`);
  }
}

function command(runCf, args, accountId) {
  const result = runCf(args, { env: cliEnv(accountId) });
  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || '').trim();
    throw new Error(`cf ${args.join(' ')} に失敗しました${details ? `: ${details}` : ''}`);
  }
  return parseJson(result.stdout, `cf ${args.join(' ')}`);
}

function listOf(value) {
  const data = unwrap(value);
  if (Array.isArray(data)) return data;
  for (const key of ['accounts', 'zones', 'items', 'result']) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

function resultOf(value) {
  const data = unwrap(value);
  return Array.isArray(data) ? data[0] : data;
}

function findEmail(value) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'email' && typeof item === 'string' && item.includes('@')) return item;
    const nested = findEmail(item);
    if (nested) return nested;
  }
  return null;
}

function isNotFound(error) {
  return /404|not found|does not exist|organization.*not/i.test(String(error?.message ?? error));
}

async function promptChoice(items, heading, formatItem) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${heading}の選択には対話端末が必要です。`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`${heading}:\n`);
    items.forEach((item, index) => {
      process.stdout.write(`  ${index + 1}) ${formatItem(item)}\n`);
    });
    const answer = (await rl.question(`番号を入力してください (1-${items.length}): `)).trim();
    const index = Number.parseInt(answer, 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
      throw new Error('有効な番号を選択してください。');
    }
    return items[index];
  } finally {
    rl.close();
  }
}

async function terminalAccountChoice(accounts) {
  return promptChoice(accounts, '使用する Cloudflare アカウントを選択してください', (account) => `${account.name} (${account.id})`);
}

async function terminalZoneChoice(zones) {
  return promptChoice(zones, '公開に使用する Cloudflare ドメインを選択してください', (zone) => zone.name);
}

async function terminalSubdomainChoice(zone) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 'cfmon';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`使用するサブドメインを入力してください (.${zone.name}、未入力で cfmon): `)).trim();
  } finally {
    rl.close();
  }
}

async function terminalPolicyChoice(choices) {
  return promptChoice(choices, 'Access で使用するポリシーを選択してください', (choice) => choice.label);
}

async function chooseAccount(accounts, selectAccount) {
  if (accounts.length === 0) throw new Error('利用可能な Cloudflare アカウントが見つかりませんでした。');
  if (accounts.length === 1) return accounts[0];
  const selected = await selectAccount(accounts);
  const match = accounts.find((account) => account.id === selected?.id || account.id === selected);
  if (!match) throw new Error('有効な Cloudflare アカウントが選択されませんでした。');
  return match;
}

function normalizedHostname(hostname) {
  const url = hostname.includes('://') ? new URL(hostname) : new URL(`https://${hostname}`);
  return url.host;
}

function orgDomain(accountId) {
  return `cfmon-${accountId.slice(0, 12).toLowerCase()}.cloudflareaccess.com`;
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

function isManagedPolicy(policy, email) {
  return policy.decision === 'allow' &&
    Array.isArray(policy.include) && policy.include.length === 1 &&
    policy.include[0]?.email?.email === email &&
    (!Array.isArray(policy.exclude) || policy.exclude.length === 0) &&
    (!Array.isArray(policy.require) || policy.require.length === 0);
}

function ensureManagedPolicy({ accountId, email, policies, runCf }) {
  const matches = policies.filter((policy) => policy.name === 'cfmon-owner');
  if (matches.length > 1) {
    throw new Error('複数のcfmon-owner reusable Access policyがあります。Cloudflare Zero Trustで整理してください。');
  }
  if (matches.length === 1) {
    if (typeof matches[0].id === 'string' && matches[0].id && isManagedPolicy(matches[0], email)) return matches[0];
    throw new Error('既存のcfmon-owner reusable Access policyを安全に再利用できません。Cloudflare Zero Trustで確認してください。');
  }
  const policy = resultOf(command(runCf, [
    'zero-trust', 'access', 'policies', 'create', '--body', JSON.stringify(managedPolicy(email)),
  ], accountId));
  if (typeof policy?.id !== 'string' || !policy.id) throw new Error('reusable Access policyを作成できませんでした。');
  return policy;
}

function managedServicePolicy(serviceTokenId) {
  return {
    name: 'cfmon-agent',
    decision: 'non_identity',
    include: [{ service_token: { token_id: serviceTokenId } }],
    exclude: [],
    require: [],
  };
}

function isManagedServicePolicy(policy, serviceTokenId) {
  return policy.decision === 'non_identity' &&
    Array.isArray(policy.include) && policy.include.length === 1 &&
    policy.include[0]?.service_token?.token_id === serviceTokenId &&
    (!Array.isArray(policy.exclude) || policy.exclude.length === 0) &&
    (!Array.isArray(policy.require) || policy.require.length === 0);
}

function ensureManagedServiceToken({ accountId, existingClientId, existingClientSecret, runCf }) {
  const tokens = listOf(command(runCf, ['zero-trust', 'access', 'service-tokens', 'list', '--per-page', '100'], accountId));
  const matches = tokens.filter((token) => token.name === 'cfmon-agent');
  if (matches.length > 1) {
    throw new Error('複数のcfmon-agent Access Service Tokenがあります。Cloudflare Zero Trustで整理してください。');
  }
  if (matches.length === 1) {
    const existing = matches[0];
    if (typeof existing?.id !== 'string' || !existing.id || typeof existing?.client_id !== 'string' || !existing.client_id) {
      throw new Error('既存のcfmon-agent Access Service Tokenの情報を取得できませんでした。');
    }
    if (
      typeof existingClientId === 'string' && existingClientId &&
      typeof existingClientSecret === 'string' && existingClientSecret &&
      existingClientId !== 'setup-pending' && existingClientSecret !== 'setup-pending' &&
      existing.client_id === existingClientId
    ) {
      return { id: existing.id, clientId: existing.client_id, clientSecret: existingClientSecret };
    }
    const rotated = resultOf(command(runCf, ['zero-trust', 'access', 'service-tokens', 'rotate', existing.id], accountId));
    const clientId = rotated?.client_id ?? existing.client_id;
    const clientSecret = rotated?.client_secret;
    if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret) {
      throw new Error('Access Service Token のシークレットを更新できませんでした。');
    }
    return { id: existing.id, clientId, clientSecret };
  }
  const created = resultOf(command(runCf, [
    'zero-trust', 'access', 'service-tokens', 'create', '--body', JSON.stringify({ name: 'cfmon-agent', duration: 'forever' }),
  ], accountId));
  if (
    typeof created?.id !== 'string' || !created.id ||
    typeof created?.client_id !== 'string' || !created.client_id ||
    typeof created?.client_secret !== 'string' || !created.client_secret
  ) {
    throw new Error('Access Service Token を作成できませんでした。');
  }
  return { id: created.id, clientId: created.client_id, clientSecret: created.client_secret };
}

function ensureManagedServicePolicy({ accountId, serviceTokenId, policies, runCf }) {
  const matches = policies.filter((policy) => policy.name === 'cfmon-agent');
  if (matches.length > 1) {
    throw new Error('複数のcfmon-agent reusable Access policyがあります。Cloudflare Zero Trustで整理してください。');
  }
  if (matches.length === 1) {
    const existing = matches[0];
    if (typeof existing?.id === 'string' && existing.id && isManagedServicePolicy(existing, serviceTokenId)) {
      return existing;
    }
    if (typeof existing?.id === 'string' && existing.id && existing.decision === 'non_identity') {
      const updated = resultOf(command(runCf, [
        'zero-trust', 'access', 'policies', 'update', existing.id, '--body', JSON.stringify(managedServicePolicy(serviceTokenId)),
      ], accountId));
      if (typeof updated?.id === 'string' && updated.id) return updated;
      return existing;
    }
    throw new Error('既存のcfmon-agent reusable Access policyを安全に再利用できません。Cloudflare Zero Trustで確認してください。');
  }
  const policy = resultOf(command(runCf, [
    'zero-trust', 'access', 'policies', 'create', '--body', JSON.stringify(managedServicePolicy(serviceTokenId)),
  ], accountId));
  if (typeof policy?.id !== 'string' || !policy.id) throw new Error('Agent用 reusable Access policy を作成できませんでした。');
  return policy;
}

function appBody(app, { hostname, accountId, idpIds, accessPolicy, servicePolicy }) {
  const body = app ? { ...app } : {};
  const destinations = Array.isArray(body.destinations) ? [...body.destinations] : [];
  const targetIndex = destinations.findIndex((destination) => destination.type === 'public' && destination.uri === hostname);
  const target = {
    type: 'public',
    uri: hostname,
    overrides: [
      { behavior: 'public', path_pattern: '/api/v1/pair' },
    ],
  };
  if (targetIndex === -1) destinations.push(target);
  else destinations[targetIndex] = target;

  const currentPolicies = Array.isArray(body.policies) ? body.policies : [];
  if (!accessPolicy?.id || !servicePolicy?.id) throw new Error('reusable Access policy を取得できませんでした。');
  const existingBroadAllow = currentPolicies.some((policy) =>
    typeof policy === 'object' && policy?.decision === 'allow' &&
    (policy.include ?? []).some((rule) => 'everyone' in rule || 'any_valid_service_token' in rule),
  );
  if (existingBroadAllow) {
    throw new Error('既存のcfmon Access appに全ユーザー許可policyがあります。既存policyを確認してから再実行してください。');
  }
  const policies = [
    { id: accessPolicy.id, account_id: accountId, precedence: 1 },
    { id: servicePolicy.id, account_id: accountId, precedence: 2 },
  ];

  for (const key of ['id', 'aud', 'created_at', 'updated_at', 'uid']) delete body[key];
  return {
    ...body,
    name: 'cfmon',
    type: 'self_hosted',
    domain: hostname,
    destinations,
    allowed_idps: idpIds,
    policies,
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
    const login = runCf(['auth', 'login', '--no-browser'], { env: cliEnv(), interactive: true });
    if (login.status !== 0) throw new Error('Cloudflare OAuth ログインが完了しませんでした。');
    whoami = command(runCf, ['auth', 'whoami']);
    email = findEmail(whoami);
  }
  if (!email) throw new Error('Cloudflare CLIからログイン中のemailを取得できませんでした。cf auth whoami を確認してください。');

  const accounts = listOf(command(runCf, ['accounts', 'list', '--per-page', '100']));
  const envAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const existing = accounts.find((account) => account.id === envAccountId);
  const account = existing ?? await chooseAccount(accounts, selectAccount);
  if (typeof account.id !== 'string' || !account.id) throw new Error('Cloudflare account IDを取得できませんでした。');
  return { accountId: account.id, email };
}

/** Pick an active zone and use a predictable hostname without asking for domain text. */
export async function selectDeploymentDomain({ accountId, runCf = defaultRunCf, selectZone = terminalZoneChoice, selectSubdomain = terminalSubdomainChoice }) {
  if (typeof accountId !== 'string' || !accountId) throw new Error('Cloudflare account IDを取得できませんでした。');
  const zones = listOf(command(runCf, ['zones', 'list', '--account-id', accountId, '--status', 'active', '--per-page', '100'], accountId))
    .filter((zone) => typeof zone.name === 'string' && zone.name && zone.status === 'active');
  if (zones.length === 0) return null;
  const zone = zones.length === 1 ? zones[0] : await selectZone(zones);
  if (!zones.some((item) => item.id === zone?.id)) throw new Error('zone が選択されませんでした。');
  const subdomain = String(await selectSubdomain(zone) ?? '').trim().toLowerCase() || 'cfmon';
  const labels = subdomain.split('.');
  if (labels.some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) || `${subdomain}.${zone.name}`.length > 253) {
    throw new Error('サブドメインは英数字とハイフンで入力してください（各ラベルは英数字で始まり、終わる必要があります）。');
  }
  return `${subdomain}.${zone.name}`;
}

/** Offer reusable Allow policies and retain the current email-only policy as the safe default. */
export async function selectReusablePolicy({ accountId, runCf = defaultRunCf, selectPolicy = terminalPolicyChoice }) {
  if (typeof accountId !== 'string' || !accountId) throw new Error('Cloudflare account IDを取得できませんでした。');
  const policies = listOf(command(runCf, ['zero-trust', 'access', 'policies', 'list', '--per-page', '100'], accountId));
  const safePolicies = policies.filter((policy) =>
    typeof policy.id === 'string' && policy.id && typeof policy.name === 'string' &&
    policy.name !== 'cfmon-owner' &&
    policy.name !== 'cfmon-agent' &&
    policy.decision === 'allow' &&
    Array.isArray(policy.include) && policy.include.length > 0 &&
    !policy.include.some((rule) => 'everyone' in rule || 'any_valid_service_token' in rule || 'service_token' in rule || 'login_method' in rule),
  );
  if (safePolicies.length === 0) return null;
  const choices = [
    { id: null, label: 'ログイン中のメールアドレスだけを許可（推奨）' },
    ...safePolicies.map((policy) => ({ id: policy.id, label: `${policy.name}（Allow）`, policy })),
  ];
  const selected = await selectPolicy(choices);
  const choice = choices.find((item) => item.id === selected?.id || item.id === selected);
  if (!choice) throw new Error('Access policy が選択されませんでした。');
  return choice.policy ?? null;
}

/** Create or reuse cfmon's Access resources, including the shared Agent Service Token. */
export async function configureAccess({
  accountId,
  email,
  hostname,
  accessPolicy = null,
  existingClientId = process.env.CFMON_ACCESS_CLIENT_ID,
  existingClientSecret = process.env.CFMON_ACCESS_CLIENT_SECRET,
  runCf = defaultRunCf,
}) {
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
  const idpIds = [...new Set([...providers.map((provider) => provider.id), idp.id].filter(Boolean))];

  const serviceToken = ensureManagedServiceToken({
    accountId,
    existingClientId,
    existingClientSecret,
    runCf,
  });

  const apps = listOf(call(['zero-trust', 'access', 'applications', 'list', '--domain', hostname, '--exact', '--per-page', '100']));
  const matches = apps.filter((app) => app.domain === hostname || (app.destinations ?? []).some((destination) => destination.uri === hostname));
  if (matches.length > 1) throw new Error('同じhostnameのAccess appが複数あります。Cloudflare Zero Trustで整理してください。');
  let app = matches[0];
  if (app && app.name !== 'cfmon') {
    throw new Error('同じhostnameにcfmon以外のAccess appがあります。既存policyを保持するため自動変更しません。');
  }
  let detail = null;
  if (app) detail = resultOf(call(['zero-trust', 'access', 'applications', 'get', app.id]));
  const policies = listOf(call(['zero-trust', 'access', 'policies', 'list', '--per-page', '100']));
  if (!accessPolicy) accessPolicy = ensureManagedPolicy({ accountId, email, policies, runCf });
  const servicePolicy = ensureManagedServicePolicy({
    accountId,
    serviceTokenId: serviceToken.id,
    policies,
    runCf,
  });

  let response;
  if (!app) {
    response = resultOf(call(['zero-trust', 'access', 'applications', 'create', '--body', JSON.stringify(appBody(null, { hostname, accountId, idpIds, accessPolicy, servicePolicy }))]));
  } else {
    const body = appBody(detail, { hostname, accountId, idpIds, accessPolicy, servicePolicy });
    response = resultOf(call(['zero-trust', 'access', 'applications', 'update', app.id, '--body', JSON.stringify(body)]));
  }
  const aud = response?.aud ?? response?.aud_tag ?? app?.aud;
  if (typeof aud !== 'string' || !aud) throw new Error('Cloudflare Access app の AUD を取得できませんでした。');
  return {
    teamDomain,
    aud,
    serviceTokenId: serviceToken.id,
    clientId: serviceToken.clientId,
    clientSecret: serviceToken.clientSecret,
  };
}
