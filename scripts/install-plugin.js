import { mkdir, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
const destination = process.argv[2] ? resolve(process.argv[2], '.opencode/plugins') : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode/plugins');
await mkdir(destination, { recursive: true });
await copyFile(new URL('../src/plugin.js', import.meta.url), join(destination, 'supervisor.js'));
console.log(`Installed ${destination}/supervisor.js`);
