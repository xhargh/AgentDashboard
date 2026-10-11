import { mkdir, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
const destination = process.argv[2] ? resolve(process.argv[2], '.opencode/plugins') : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode/plugins');
await mkdir(destination, { recursive: true });
for (const [source, target] of [['plugin.js', 'supervisor.js'], ['session-lifecycle.js', 'session-lifecycle.js'], ['activity-events.js', 'activity-events.js']]) {
  await copyFile(new URL(`../src/${source}`, import.meta.url), join(destination, target));
}
console.log(`Installed ${destination}/supervisor.js`);
