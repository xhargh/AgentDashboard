import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dependencies = [
  { name: 'session-lifecycle.js', import: "import { createSession, markActivity, markState } from './session-lifecycle.js';" },
  { name: 'activity-events.js', import: "import { createActivityBuffer } from './activity-events.js';" },
];

export async function installPlugin(projectDirectory) {
  const destination = projectDirectory
    ? resolve(projectDirectory, '.opencode/plugins')
    : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode/plugins');
  await mkdir(destination, { recursive: true });
  for (const stale of ['supervisor.js', 'session-lifecycle.js', 'activity-events.js', 'session-lifecycle.mjs', 'activity-events.mjs']) {
    await unlink(join(destination, stale)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }

  let plugin = await readFile(new URL('../src/plugin.js', import.meta.url), 'utf8');
  for (const dependency of dependencies) {
    if (!plugin.includes(dependency.import)) throw new Error(`Expected import not found in src/plugin.js: ${dependency.name}`);
    plugin = plugin.replace(dependency.import, '');
  }
  const helpers = await Promise.all(dependencies.map(async dependency =>
    (await readFile(new URL(`../src/${dependency.name}`, import.meta.url), 'utf8')).replace(/^export /gm, '')));
  await writeFile(join(destination, 'AgentDashboardPlugin.js'), `${helpers.join('\n')}\n${plugin}`);
  console.log(`Installed ${destination}/AgentDashboardPlugin.js`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await installPlugin(process.argv[2]);
