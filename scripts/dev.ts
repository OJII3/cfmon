import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const worker = fileURLToPath(new URL('../worker/', import.meta.url));
const config = JSON.parse(await readFile(`${worker}/wrangler.jsonc`, 'utf8'));
// Analytics SQL has no local emulator; pairing still uses real local D1.
delete config.analytics;
config.vars = { DEVELOPMENT: 'true' };
await writeFile(`${worker}/wrangler.dev.json`, `${JSON.stringify(config, null, 2)}\n`);
const child = spawn('npx', ['--no-install', 'wrangler', 'dev', '--config', 'wrangler.dev.json', ...process.argv.slice(2)], { cwd: worker, stdio: 'inherit' });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
