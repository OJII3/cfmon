import test from 'node:test';
import assert from 'node:assert/strict';
import { configureAccess, loginAndSelectAccount } from './setup-cloudflare.mjs';

const json = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });

function mockCf(routes) {
  const calls = [];
  const runCf = (args, options) => {
    calls.push({ args: [...args], options });
    const key = args.join(' ');
    const response = routes[key]?.shift();
    if (!response) throw new Error(`Unexpected mocked command: ${key}`);
    return typeof response === 'function' ? response(args, options) : response;
  };
  return { calls, runCf };
}

test('logs in through OAuth and selects one listed account without entering metadata', async () => {
  const { calls, runCf } = mockCf({
    'auth whoami': [
      json({ authenticated: false, error: 'Not logged in' }),
      json({ result: { user: { email: 'owner@example.test' } } }),
    ],
    'auth login --no-browser': [{ status: 0, stdout: '', stderr: '' }],
    'accounts list --per-page 100': [json({ result: [
      { id: 'account-one', name: 'Personal' },
      { id: 'account-two', name: 'Lab' },
    ] })],
  });
  const selected = await loginAndSelectAccount({
    runCf,
    selectAccount: async (accounts) => {
      assert.deepEqual(accounts.map(({ name }) => name), ['Personal', 'Lab']);
      return 'account-two';
    },
  });
  assert.deepEqual(selected, { accountId: 'account-two', email: 'owner@example.test' });
  assert.equal(calls[1].options.interactive, true);
  assert.equal(calls[1].options.env.CLOUDFLARE_API_TOKEN, undefined);
});

test('creates the Access organization, email identity provider, and protected app with only pair and ingest public', async () => {
  const accountId = '0123456789abcdef0123456789abcdef';
  const hostname = 'cfmon.worker-example.workers.dev';
  const calls = [];
  // Match argument sequences where --body contains generated JSON without relying on its exact text.
  const routeAwareRun = (args, options) => {
    calls.push({ args: [...args], options });
    const key = args.slice(0, 4).join(' ');
    if (key.startsWith('zero-trust organization get')) return { status: 1, stdout: '', stderr: '404 Not Found' };
    if (key.startsWith('zero-trust organization create')) return json({ result: { auth_domain: 'cfmon-team.cloudflareaccess.com' } });
    if (key.startsWith('zero-trust identity-providers list')) return json({ result: [] });
    if (key.startsWith('zero-trust identity-providers create')) return json({ result: { id: 'otp-id', type: 'onetimepin' } });
    if (key.startsWith('zero-trust access applications list')) return json({ result: [] });
    if (key.startsWith('zero-trust access applications create')) return json({ result: { id: 'app-id', aud: 'app-audience' } });
    throw new Error(`Unexpected mocked command: ${args.join(' ')}`);
  };
  const result = await configureAccess({ accountId, email: 'owner@example.test', hostname, runCf: routeAwareRun });
  assert.deepEqual(result, { teamDomain: 'cfmon-team.cloudflareaccess.com', aud: 'app-audience' });
  const createApp = calls.find(({ args }) => args.slice(0, 5).join(' ') === 'zero-trust access applications create --body');
  const body = JSON.parse(createApp.args[5]);
  assert.deepEqual(body.destinations[0].overrides, [
    { behavior: 'public', path_pattern: '/api/v1/pair' },
    { behavior: 'public', path_pattern: '/api/v1/ingest' },
  ]);
  assert.deepEqual(body.policies[0].include, [{ email: { email: 'owner@example.test' } }]);
  assert.equal(calls.every(({ options }) => options.env.CLOUDFLARE_ACCOUNT_ID === accountId), true);
  assert.equal(calls.every(({ options }) => options.env.CLOUDFLARE_API_TOKEN === undefined), true);
  assert.equal(calls.some(({ args }) => args.includes('--dry-run')), false);
});

test('repairs the app-owned policy while preserving unrelated restrictive policies', async () => {
  const hostname = 'cfmon.worker-example.workers.dev';
  const calls = [];
  const runCf = (args, options) => {
    calls.push({ args, options });
    const key = args.slice(0, 4).join(' ');
    if (key.startsWith('zero-trust organization get')) return json({ result: { auth_domain: 'existing.cloudflareaccess.com' } });
    if (key.startsWith('zero-trust identity-providers list')) return json({ result: [{ id: 'otp-id', type: 'onetimepin' }] });
    if (key.startsWith('zero-trust access applications list')) return json({ result: [{ id: 'app-id', name: 'cfmon', domain: hostname, aud: 'existing-aud' }] });
    if (key.startsWith('zero-trust access applications get')) return json({ result: {
      id: 'app-id', name: 'cfmon', type: 'self_hosted', domain: hostname, aud: 'existing-aud',
      policies: [
        { name: 'cfmon-owner', decision: 'allow', include: [{ everyone: {} }] },
        { name: 'department-policy', decision: 'allow', include: [{ email: { email: 'other@example.test' } }] },
      ],
    } });
    if (key.startsWith('zero-trust access applications update')) return json({ result: { id: 'app-id', aud: 'existing-aud' } });
    throw new Error(`Unexpected mocked command: ${args.join(' ')}`);
  };
  const result = await configureAccess({ accountId: 'account-id', email: 'owner@example.test', hostname, runCf });
  assert.deepEqual(result, { teamDomain: 'existing.cloudflareaccess.com', aud: 'existing-aud' });
  const update = calls.find(({ args }) => args[3] === 'update');
  const body = JSON.parse(update.args.at(-1));
  assert.deepEqual(body.policies, [
        { name: 'department-policy', decision: 'allow', include: [{ email: { email: 'other@example.test' } }] },
        { name: 'cfmon-owner', decision: 'allow', include: [{ email: { email: 'owner@example.test' } }], exclude: [], require: [] },
  ]);
  assert.equal(body.policies.some((policy) => policy.include.some((rule) => 'everyone' in rule)), false);
});

test('does not modify another app or an unrelated broad allow policy', async () => {
  const hostname = 'cfmon.worker-example.workers.dev';
  for (const app of [
    { id: 'app-id', name: 'personal-dashboard', domain: hostname },
    { id: 'app-id', name: 'cfmon', domain: hostname, policies: [{ name: 'other-policy', decision: 'allow', include: [{ everyone: {} }] }] },
  ]) {
    const runCf = (args) => {
      const key = args.slice(0, 4).join(' ');
      if (key.startsWith('zero-trust organization get')) return json({ result: { auth_domain: 'existing.cloudflareaccess.com' } });
      if (key.startsWith('zero-trust identity-providers list')) return json({ result: [{ id: 'otp-id', type: 'onetimepin' }] });
      if (key.startsWith('zero-trust access applications list')) return json({ result: [app] });
      if (key.startsWith('zero-trust access applications get')) return json({ result: app });
      throw new Error(`Unexpected mocked command: ${args.join(' ')}`);
    };
    await assert.rejects(configureAccess({ accountId: 'account-id', email: 'owner@example.test', hostname, runCf }), /既存/);
  }
});
