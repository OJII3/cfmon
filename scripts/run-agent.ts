import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
try {
  const { url } = JSON.parse(await readFile(new URL('../.cfmon/deployment.json', import.meta.url), 'utf8'));
  const endpoint = new URL('/api/v1/ingest', url);
  if (endpoint.protocol !== 'https:') throw new Error('Invalid deployment URL');
  const child = spawn('moon', ['run', 'src', '--target', 'native', '--', ...process.argv.slice(2)], {
    cwd: `${root}/agent`, stdio: 'inherit', env: { ...process.env, CFMON_URL: endpoint.href },
  });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(error.code === 'ENOENT' ? '先に npm run setup でデプロイしてください' : error.message);
  process.exitCode = 1;
}
