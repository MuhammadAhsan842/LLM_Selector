import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './icons.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(`${root}/extension/manifest.json`, 'utf8'));
mkdirSync(`${root}/dist`, { recursive: true });
const output = `${root}/dist/orbit-chrome-${manifest.version}.zip`;
rmSync(output, { force: true });
execFileSync('zip', ['-q', '-r', output, ...readdirSync(`${root}/extension`)], { cwd: `${root}/extension` });
console.log(`Chrome extension packaged: ${output}`);
