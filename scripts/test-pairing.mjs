import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'cfmon-pairing-'));
const base = 'http://127.0.0.1:18887';
let server;
function command(bin, args, cwd, env = process.env) {
  const result = spawnSync(bin, args, { cwd, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}
async function admin(path, body) {
  return fetch(`${base}${path}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
try {
  const migration = command('npx', ['--no-install', 'wrangler', 'd1', 'migrations', 'apply', 'REGISTRY', '--local', '--persist-to', temporary], `${root}/worker`);
  assert.equal(migration.status, 0, migration.stderr);
  server = spawn(process.execPath, ['scripts/dev.mjs', '--ip', '127.0.0.1', '--port', '18887', '--persist-to', temporary], { cwd: root, detached: true, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${base}/api/v1/agents`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch {}
    if (server.exitCode !== null) throw new Error('Local Worker exited before becoming ready');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Local Worker did not become ready');
  const state = join(temporary, 'agent');
  const env = { ...process.env, CFMON_STATE_DIR: state, CFMON_HOST: 'cfmon-e2e', CFMON_URL: `${base}/api/v1/ingest` };
  const agent = () => command('moon', ['run', 'src', '--target', 'native', '--', '--once'], `${root}/agent`, env);
  const pending = agent();
  assert.equal(pending.status, 2, pending.stderr);
  const { agents } = await (await fetch(`${base}/api/v1/agents`)).json();
  assert.equal(agents.length, 1);
  const registered = agents[0];
  assert.ok(pending.stderr.includes(registered.fingerprint), 'Native and Worker fingerprints differ');
  assert.equal((await stat(join(state, 'agent.ed25519'))).mode & 0o777, 0o600);
  assert.equal((await admin(`/api/v1/agents/${registered.public_key}/approve`, { fingerprint: '0'.repeat(64) })).status, 404);
  assert.equal((await admin(`/api/v1/agents/${registered.public_key}/approve`, { fingerprint: registered.fingerprint })).status, 200);
  const approved = agent();
  assert.equal(approved.status, 0, approved.stderr);
  const rawPrivate = await readFile(join(state, 'agent.ed25519'));
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), rawPrivate]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  assert.equal(createHash('sha256').update(publicKey).digest('hex'), registered.fingerprint);
  const body = JSON.stringify({ host: 'cfmon-e2e', os: 'linux', cpu: 0.3, memory: 0.7, load1: 1, disk: 0.5, rx_bps: 10, tx_bps: 20, uptime: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const signature = sign(null, Buffer.from(`POST\n/api/v1/ingest\n${timestamp}\n${nonce}\n${body}`), privateKey).toString('hex');
  const init = { method: 'POST', body, headers: { 'X-Cfmon-Key': registered.public_key, 'X-Cfmon-Timestamp': timestamp, 'X-Cfmon-Nonce': nonce, 'X-Cfmon-Signature': signature } };
  assert.equal((await fetch(`${base}/api/v1/ingest`, { ...init, body: body.replace('0.3', '0.4') })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/ingest`, init)).status, 202);
  assert.equal((await fetch(`${base}/api/v1/ingest`, init)).status, 401);
  assert.equal((await admin(`/api/v1/agents/${registered.public_key}/revoke`, {})).status, 200);
  const revoked = agent();
  assert.equal(revoked.status, 2, revoked.stderr);
  console.log('Native Agent → local Worker/D1: pairing, approval, signature, replay and revocation passed');
} finally {
  if (server && server.exitCode === null) {
    process.kill(-server.pid, 'SIGTERM');
    await once(server, 'exit');
  }
  await rm(temporary, { recursive: true, force: true });
}
