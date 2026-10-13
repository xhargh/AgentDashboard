import { expect, test } from '@playwright/test';

const token = 'e2e-network-token-with-at-least-24-characters';

function report(title = 'Build dashboard', status = 'busy', now = Date.now()) {
  return {
    mode: 'local',
    serverTime: now,
    instances: [
      {
        instanceId: 'instance-alpha',
        host: 'alpha',
        directory: '/work/alpha/app',
        pid: 2101,
        online: true,
        lastSeen: now,
        sessions: [
          {
            id: 'root-alpha',
            title,
            status,
            directory: '/work/alpha/app',
            activity: 'Editing app.js',
            agent: 'build',
            todos: [],
          },
          {
            id: 'child-alpha',
            parentID: 'root-alpha',
            title: 'Finished review',
            status: 'idle',
            stateChangedAt: new Date(now - 30_000).toISOString(),
            directory: '/work/alpha/app',
            activity: 'Review complete',
            agent: 'review',
            todos: [],
          },
          {
            id: 'child-unknown-time',
            parentID: 'root-alpha',
            title: 'Unknown-age review',
            status: 'idle',
            directory: '/work/alpha/app',
            activity: 'Review complete',
            agent: 'review',
            todos: [],
          },
          {
            id: 'permission-alpha',
            title: 'Approve deployment',
            status: 'waiting',
            directory: '/work/alpha/app',
            activity: 'Waiting for permission',
            agent: 'build',
            todos: [],
          },
        ],
        git: {
          root: '/work/alpha/app', status: '## main\n M app.js\n?? scratch.txt',
          log: 'abc123 2026-01-02T03:04:05+00:00 Initial commit',
          worktrees: 'worktree /work/alpha/app\nHEAD abc123\nbranch refs/heads/main\n\nworktree /work/alpha/linked\nHEAD def456\nbranch refs/heads/linked',
        },
      },
      {
        instanceId: 'instance-beta',
        host: 'beta',
        directory: '/work/beta/api',
        pid: 2102,
        online: true,
        lastSeen: now,
        sessions: [
          {
            id: 'root-beta',
            title: 'Fix API',
            status: 'idle',
            directory: '/work/beta/api',
            activity: 'Ready',
            agent: 'plan',
            todos: [],
          },
        ],
        git: null,
      },
    ],
  };
}

async function installStateFixture(page, handler, { legacyExpandedDefaults = true } = {}) {
  if (legacyExpandedDefaults) await page.addInitScript(() => {
    const expanded = new WeakSet();
    const restoreDefaults = () => {
      for (const group of document.querySelectorAll('details.session-group')) if (!expanded.has(group)) {
        expanded.add(group); group.open = true;
      }
      for (const agent of document.querySelectorAll('details.agent-tree:not(.subagent-row)')) {
        if (expanded.has(agent) || agent.querySelector(':scope > article.session-card > .subagent-group')) continue;
        expanded.add(agent); agent.open = true;
      }
    };
    document.addEventListener('DOMContentLoaded', () => {
      const observer = new MutationObserver(restoreDefaults);
      observer.observe(document, { childList: true, subtree: true });
      restoreDefaults();
    }, { once: true });
  });
  await page.route('**/api/state', async route => {
    const authorization = route.request().headers().authorization;
    const response = handler(authorization);
    await route.fulfill({
      status: response.status || 200,
      contentType: 'application/json',
      body: JSON.stringify(response.body || response),
    });
  });
}

test('local mode connects automatically and filters fleet activity', async ({ page }) => {
  await page.clock.install({ time: new Date(120_000) });
  await installStateFixture(page, () => report('Build dashboard', 'busy', 120_000));
  await page.goto('/');
  await page.locator('#session-sort').selectOption('status');

  await expect(page.getByText('● Connected · local only')).toBeVisible();
  await expect(page.locator('.tree-title').filter({ hasText: 'Build dashboard' })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Needs attention · 1' })).toBeVisible();
  await expect(page.getByText('Approve deployment', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Working · 1' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting for input · 1' })).toBeVisible();
  await expect(page.getByText('Idle top-level sessions ready for your next message · count is sessions across all computers and instances')).toBeVisible();
  await expect(page.locator('.metric').filter({ has: page.getByText('Computers online', { exact: true }) })).toHaveCount(0);
  const instancesMetric = page.locator('.metric').filter({ has: page.getByText('OpenCode instances', { exact: true }) });
  await expect(instancesMetric.locator('.metric-tooltip')).toHaveText('Online instance reports; one computer may run several');
  await expect(instancesMetric.locator('.metric-help')).toHaveAttribute('aria-describedby', await instancesMetric.locator('.metric-tooltip').getAttribute('id'));
  await expect(page.getByRole('button', { name: 'Metric description' })).toHaveCount(3);
  await instancesMetric.locator('.metric-help').focus();
  await expect(instancesMetric.locator('.metric-tooltip')).toBeVisible();
  await expect(instancesMetric.locator('small')).toHaveCount(0);
  const root = page.locator('details[data-agent-key="instance-alpha:root-alpha"]');
  await expect(root.locator(':scope > summary')).toContainText('2 children');
  await expect(root.locator(':scope > summary .tree-title')).toHaveText('Build dashboard');
  await expect(root.locator(':scope > summary .badge')).toHaveText('busy');
  await root.locator(':scope > summary').click();
  await root.locator(':scope > article.session-card > .subagent-group > summary').click();
  await expect(root.locator('.session-info > p.muted').first()).toHaveText('Computer alpha · OpenCode instance PID 2101');
  await expect(root.locator(':scope > summary .tree-directory')).toHaveAttribute('aria-label', 'Working directory: /work/alpha/app');
  await expect(page.getByText('Finished review', { exact: true })).toBeVisible();
  await expect(page.getByText('Unknown-age review', { exact: true })).toBeVisible();

  await page.getByText('Filter agents').click();
  await page.getByLabel('Computer').selectOption('legacy:beta');
  await expect(page.getByText('Fix API', { exact: true })).toBeVisible();
  await expect(page.locator('.tree-title').filter({ hasText: 'Build dashboard' })).toHaveCount(0);

  await page.getByLabel('Computer').selectOption('');
  await page.getByLabel('Search').fill('Editing app.js');
  await expect(page.getByText('Build dashboard', { exact: true })).toBeVisible();
  await expect(page.getByText('Approve deployment', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Fix API', { exact: true })).toHaveCount(0);

  await page.getByLabel('Search').fill('');
  await page.locator('#active').check();
  await expect(page.getByText('Build dashboard', { exact: true })).toBeVisible();
  await expect(page.locator('.tree-title').filter({ hasText: 'Fix API' })).toHaveCount(0);
});

test('hides the needs-attention group when no sessions need attention', async ({ page }) => {
  await installStateFixture(page, () => {
    const state = report();
    for (const instance of state.instances) instance.sessions = instance.sessions.filter(session => session.status !== 'waiting' && session.status !== 'error');
    return state;
  });
  await page.goto('/');
  await page.locator('#session-sort').selectOption('status');

  await expect(page.getByRole('heading', { name: /^Needs attention/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Working · 1' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting for input · 1' })).toBeVisible();
});

test('all agent status groups can be folded and unfolded', async ({ page }) => {
  await installStateFixture(page, () => report());
  await page.goto('/');
  await page.locator('#session-sort').selectOption('status');
  const working = page.locator('details.session-group.group-working');
  await working.locator(':scope > summary').click();
  await expect(working).not.toHaveAttribute('open', '');
  await expect(working.locator('[data-agent-key="instance-alpha:root-alpha"]')).toBeHidden();
  await working.locator(':scope > summary').click();
  await expect(working.locator('[data-agent-key="instance-alpha:root-alpha"]')).toBeVisible();

  const waiting = page.locator('details.session-group.group-waiting-for-input');
  await waiting.locator(':scope > summary').click();
  await expect(waiting).not.toHaveAttribute('open', '');
  await expect(waiting.locator('[data-agent-key="instance-beta:root-beta"]')).toBeHidden();
});

test('starts every collapsible dashboard panel folded and preserves deliberate expansion', async ({ page }) => {
  await installStateFixture(page, () => report(), { legacyExpandedDefaults: false });
  await page.goto('/');
  await expect(page.locator('details[open]')).toHaveCount(0);
  const group = page.locator('details.session-group').first();
  await group.locator(':scope > summary').click();
  await expect(group).toHaveAttribute('open', '');
  const root = group.locator('[data-agent-key="instance-alpha:root-alpha"]');
  await expect(root).not.toHaveAttribute('open', '');
  await root.locator(':scope > summary').click();
  await expect(root).toHaveAttribute('open', '');
  const timeline = root.locator('.execution-timeline');
  await expect(timeline).not.toHaveAttribute('open', '');
  await page.waitForTimeout(2200);
  await expect(group).toHaveAttribute('open', '');
  await expect(root).toHaveAttribute('open', '');
});

test('leaf subagents can be folded and unfolded like parent sessions', async ({ page }) => {
  await installStateFixture(page, () => report());
  await page.goto('/');
  const root = page.locator('details[data-agent-key="instance-alpha:root-alpha"]');
  await root.locator(':scope > summary').click();
  await root.locator(':scope > article.session-card > .subagent-group > summary').click();
  const child = page.locator('details[data-agent-key="instance-alpha:child-alpha"]');
  await child.locator(':scope > summary').click();
  await expect(child).toHaveAttribute('open', '');
  await expect(child.locator(':scope > article.session-card')).toBeVisible();

  await child.locator(':scope > summary').click();
  await expect(child).not.toHaveAttribute('open', '');
  await expect(child.locator(':scope > article.session-card')).toBeHidden();
  await child.locator(':scope > summary').click();
  await expect(child.locator(':scope > article.session-card')).toBeVisible();
});

test('folded Git workspace summarizes changes, worktrees, and last commit', async ({ page }) => {
  await installStateFixture(page, () => report());
  await page.goto('/');
  const workspace = page.locator('details[data-instance="instance-alpha"]').first();
  await expect(workspace.locator(':scope > summary')).toHaveText('Git workspace · 2 changes · 2 worktrees · last commit 2026-01-02 03:04');
  await expect(workspace).not.toHaveAttribute('open', '');
});

test('clean single-worktree summary omits zero changes and worktree count', async ({ page }) => {
  const state = report();
  state.instances[0].git.status = '## main';
  state.instances[0].git.worktrees = 'worktree /work/alpha/app\nHEAD abc123\nbranch refs/heads/main';
  await installStateFixture(page, () => state);
  await page.goto('/');
  const workspace = page.locator('details[data-instance="instance-alpha"]').first();
  await expect(workspace.locator(':scope > summary')).toHaveText('Git workspace · clean · last commit 2026-01-02 03:04');
});

test('local mode hides the computer filter when only one computer is reported', async ({ page }) => {
  const state = report();
  state.instances = [state.instances[0]];
  await installStateFixture(page, () => state);
  await page.goto('/');

  await expect(page.getByText('● Connected · local only')).toBeVisible();
  await expect(page.getByLabel('Computer')).toBeHidden();
});

test('search and expanded agent controls fit mobile, tablet, and desktop widths', async ({ page }) => {
  const state = report();
  state.instances[0].machineId = 'machine-alpha';
  state.instances[0].sessions[0].model = { providerID: 'provider', modelID: 'model', contextLimit: 200000 };
  state.instances[0].sessions[0].usage = { input: 14000, output: 1000, contextEstimate: 15000 };
  await installStateFixture(page, () => state);
  await page.goto('/');
  await expect(page.getByLabel('Search')).toBeVisible();
  await page.locator('details[data-agent-key="instance-alpha:root-alpha"] > summary').click();
  await page.getByText('Filter agents', { exact: true }).click();

  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByLabel('Search')).toBeVisible();
    await expect(page.getByLabel('Computer')).toBeVisible();
    await expect(page.getByText('Build dashboard', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('network mode requires a token, rejects a bad token, and connects with a valid token', async ({ page }) => {
  await installStateFixture(page, authorization => {
    if (authorization !== `Bearer ${token}`) {
      return { status: 401, body: { error: 'Invalid access token' } };
    }
    return { ...report(), mode: 'network' };
  });
  await page.goto('/');

  const login = page.locator('#login');
  await expect(login).toBeVisible();
  await page.getByLabel('Companion access token').fill('incorrect-token');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid access token');

  await page.getByLabel('Companion access token').fill(token);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByText('● Connected · network mode')).toBeVisible();
  await expect(page.locator('.tree-title').filter({ hasText: 'Build dashboard' })).toBeVisible();
  await expect(page.locator('.metric').filter({ has: page.getByText('Computers online', { exact: true }) })).toHaveCount(1);

  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(login).toBeVisible();
  await expect(page.locator('#dashboard')).toBeHidden();
});

test('keeps expanded Git details open when polled state updates', async ({ page }) => {
  let polls = 0;
  await installStateFixture(page, () => {
    polls += 1;
    return report(polls > 1 ? 'Deploy dashboard' : 'Build dashboard');
  });
  await page.goto('/');
  await page.locator('#session-sort').selectOption('status');
  await expect(page.locator('.tree-title').filter({ hasText: 'Build dashboard' })).toBeVisible();

  const tree = page.locator('.group-working details[data-agent-key="instance-alpha:root-alpha"]');
  await tree.locator(':scope > summary').click();
  const details = tree.locator('article details[data-instance="instance-alpha"]');
  await details.locator(':scope > summary').click();
  await expect(details).toHaveAttribute('open', '');

  await expect(page.locator('.tree-title').filter({ hasText: 'Deploy dashboard' })).toBeVisible();
  await expect(details).toHaveAttribute('open', '');
  await expect(details.getByRole('heading', { name: 'Recent commits' })).toBeVisible();
});

test('agent summary status badge follows the latest base-agent status', async ({ page }) => {
  let polls = 0;
  await installStateFixture(page, () => {
    polls++;
    return report('Build dashboard', polls > 1 ? 'idle' : 'busy');
  });
  await page.goto('/');
  const summary = page.locator('[data-agent-key="instance-alpha:root-alpha"] > summary');
  await expect(summary.locator('.tree-title')).toHaveText('Build dashboard');
  await expect(summary.locator('.badge')).toHaveText('busy');
  await expect(summary.locator('.badge')).toHaveText('Waiting for input');
  await expect(summary.locator('.tree-activity')).toHaveText('Editing app.js');
});

test('agent summary keeps status and activity visible when expanded without repeating the title', async ({ page }) => {
  await installStateFixture(page, () => report());
  await page.goto('/');
  const tree = page.locator('[data-agent-key="instance-alpha:root-alpha"]');
  const summary = tree.locator(':scope > summary');
  await expect(summary.locator('.tree-title')).toHaveText('Build dashboard');
  await expect(summary.locator('.badge')).toHaveText('busy');
  await expect(summary.locator('.tree-activity')).toHaveText('Editing app.js');

  await summary.click();
  await expect(tree).toHaveAttribute('open', '');
  await expect(summary.locator('.badge')).toHaveText('busy');
  await expect(tree.locator(':scope > summary .badge')).toHaveCount(1);
  await expect(tree.locator(':scope > article.session-card > .session > .session-state .badge')).toHaveCount(0);
  await expect(tree.locator(':scope > article.session-card > .activity-timeline')).toHaveCount(1);
  await expect(tree.locator(':scope > article.session-card > .session .session-info > strong')).toHaveCount(0);
});

test('session sorting supports name, context, cumulative usage, direction, and survives refreshes', async ({ page }) => {
  const state = report();
  const root = state.instances[0].sessions[0];
  root.usage = { contextEstimate: 100, input: 5, output: 5 };
  state.instances[0].sessions.push({ id: 'alpha-task', title: 'Alpha task', status: 'busy', directory: '/work/alpha/app', activity: 'Working', lastActivityAt: '2026-01-02T00:00:00Z', usage: { contextEstimate: 50, input: 50, output: 50 } });
  await installStateFixture(page, () => state);
  await page.goto('/');

  const names = () => page.locator('.group-sorted-sessions > details.agent-tree > summary .tree-title').allTextContents();
  await page.locator('#session-sort').selectOption('name');
  await page.locator('#sort-direction').click();
  await expect.poll(names).toEqual(['Alpha task', 'Approve deployment', 'Build dashboard', 'Fix API']);
  await page.locator('#sort-direction').click();
  await expect.poll(names).toEqual(['Fix API', 'Build dashboard', 'Approve deployment', 'Alpha task']);

  await page.locator('#session-sort').selectOption('context');
  await expect.poll(names).toEqual(['Build dashboard', 'Alpha task', 'Approve deployment', 'Fix API']);
  await page.locator('#session-sort').selectOption('tokens');
  await expect.poll(names).toEqual(['Alpha task', 'Build dashboard', 'Approve deployment', 'Fix API']);

  await page.locator('#session-sort').selectOption('status');
  await expect(page.locator('.group-needs-attention')).toBeVisible();
  await expect(page.locator('.group-working')).toBeVisible();
  await page.locator('#session-sort').selectOption('tokens');

  await page.reload();
  await expect(page.locator('#session-sort')).toHaveValue('tokens');
  await expect.poll(names).toEqual(['Alpha task', 'Build dashboard', 'Approve deployment', 'Fix API']);
});

test('offline agents show one consistent summary status with or without children', async ({ page }) => {
  const state = report();
  state.instances = [{ ...state.instances[0], online: false, sessions: [
    { id: 'offline-leaf', title: 'Offline leaf', status: 'busy' },
    { id: 'offline-parent', title: 'Offline parent', status: 'busy' },
    { id: 'offline-child', parentID: 'offline-parent', title: 'Offline child', status: 'busy' },
  ] }];
  await installStateFixture(page, () => state);
  await page.goto('/');
  await page.getByText('Filter agents').click();
  await page.locator('#hide-offline').uncheck();

  for (const id of ['offline-leaf', 'offline-parent']) {
    const summary = page.locator(`[data-agent-key="instance-alpha:${id}"] > summary`);
    await expect(summary.locator('.badge')).toHaveText('Offline');
  }
});

test('renders status-only instances without optional metadata', async ({ page }) => {
  const now = Date.now();
  await installStateFixture(page, () => ({ mode: 'local', serverTime: now, instances: [{
    instanceId: 'status-only', machineId: 'machine', host: 'private-host', pid: 42, online: true, lastSeen: now,
    sessions: [{ id: 'session', status: 'busy' }],
  }] }));
  await page.goto('/');

  await expect(page.locator('#fleet').getByText('Computer private-host · OpenCode instance PID 42', { exact: true })).toBeVisible();
  await expect(page.locator('[data-agent-key="status-only:session"] > summary .tree-directory')).toHaveCount(0);
  await expect(page.getByText('Session', { exact: true })).toBeVisible();
  await expect(page.locator('[data-agent-key="status-only:session"] > summary .badge')).toHaveText('busy');
  await expect(page.getByText('undefined', { exact: true })).toHaveCount(0);
});

test('shows independent model, context, and token metrics and updates after compaction', async ({ page }) => {
  let polls = 0;
  await installStateFixture(page, () => {
    polls++;
    const state = report();
    const root = state.instances[0].sessions[0];
    root.model = { providerID: 'provider-a', modelID: 'model-a', providerName: 'Provider A', name: 'Friendly A', variant: 'high', contextLimit: 200000 };
    root.usage = { input: 140000, output: 10000, reasoning: 1200, cacheRead: 0, cacheWrite: 30, contextEstimate: polls < 3 ? 150000 : 25000, partial: false };
    const child = state.instances[0].sessions.find(session => session.id === 'child-alpha');
    child.model = { providerID: 'provider-b', modelID: 'model-b', providerName: 'Provider B', contextLimit: 200000 };
    child.usage = { input: 7, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, contextEstimate: 180000, partial: false };
    return state;
  });
  await page.goto('/');
  await page.getByText('Filter agents', { exact: true }).click();
  await page.locator('#hide-finished').uncheck();
  const root = page.locator('[data-agent-key="instance-alpha:root-alpha"]');
  await root.locator(':scope > summary').click();
  const rootCard = root.locator(':scope > article.session-card');
  const rootInfo = rootCard.locator(':scope > .session > .session-info');
  await expect(rootInfo.locator('.model-label')).toHaveText('Provider A / Friendly A');
  await expect(rootInfo.locator('.variant-label')).toHaveText('high variant');
  await expect(rootInfo.locator('.context-metric')).toContainText('150,000 / 200,000 (75%)');
  await expect(rootInfo.locator('.context-warning-text')).toHaveText('Context estimate is at least 75%');
  await expect(rootInfo.locator('progress')).toHaveAttribute('aria-valuetext', '75 percent estimated');
  await expect(rootInfo.locator('.usage-metric')).toContainText('Own · 150,000 input + output tokens');
  await expect(rootInfo.locator('.aggregate-usage')).toHaveText('Total with subagents · 150,012 input + output tokens · some usage pending');
  await rootInfo.locator('.usage-breakdown summary').click();
  await expect(rootInfo.locator('.usage-breakdown')).toContainText('Reasoning');
  await expect(rootInfo.locator('.usage-breakdown')).toContainText('1,200');

  const child = page.locator('[data-agent-key="instance-alpha:child-alpha"]');
  const childCard = child.locator(':scope > article.session-card');
  const childInfo = childCard.locator(':scope > .session > .session-info');
  await expect(childInfo.locator('.model-label')).toHaveText('Provider B / model-b');
  await expect(childInfo.locator('.variant-label')).toHaveCount(0);
  await expect(child.locator(':scope > summary .badge')).toHaveCount(1);
  await expect(childCard.locator('.badge')).toHaveCount(0);
  await expect(childInfo.locator('.context-warning-text')).toHaveText('Context estimate is at least 90%');
  await expect(childInfo.locator('.usage-metric')).toContainText('Own · 12 input + output tokens');

  await expect(rootInfo.locator('.context-metric')).toContainText('25,000 / 200,000 (13%)');
  await expect(rootInfo.locator('.context-warning-text')).toHaveCount(0);
  await expect(rootInfo.locator('.usage-breakdown')).toHaveAttribute('open', '');
});

test('unknown and privacy-limited metrics render placeholders without fabricated zeros', async ({ page }) => {
  const now = Date.now();
  await installStateFixture(page, () => ({ mode: 'local', serverTime: now, instances: [{
    instanceId: 'status-only', machineId: 'machine', host: 'private-host', pid: 42, online: true, lastSeen: now,
    sessions: [{ id: 'session', status: 'busy' }],
  }] }));
  await page.goto('/');
  const card = page.locator('[data-agent-key="status-only:session"] .session-card');
  await expect(card.locator('.model-label')).toHaveText('Model unavailable');
  await expect(card.locator('.variant-label')).toHaveCount(0);
  await expect(card.locator('.context-unavailable')).toHaveText('Context unavailable');
  await expect(card.locator('.usage-pending')).toHaveText('Usage pending');
  await expect(card.locator('progress')).toHaveCount(0);
  await expect(card).not.toContainText('0%');
});

test('shows one accessible working directory and status, without idle activity duplication', async ({ page }) => {
  const state = report();
  const root = state.instances[0].sessions[0];
  root.status = 'idle';
  root.activity = 'Ready';
  root.directory = '/work/projects/a-very-long-directory-name/dashboard';
  const child = state.instances[0].sessions.find(session => session.id === 'child-alpha');
  child.directory = '/work/projects/child';
  child.activity = 'Idle';
  await installStateFixture(page, () => state);
  await page.goto('/');

  const rootTree = page.locator('[data-agent-key="instance-alpha:root-alpha"]');
  await expect(rootTree.locator(':scope > summary .badge')).toHaveCount(1);
  await expect(rootTree.locator(':scope > summary .tree-activity')).toHaveCount(0);
  const rootPath = rootTree.locator(':scope > summary .tree-directory');
  await expect(rootPath).toHaveAttribute('title', root.directory);
  await expect(rootPath).toHaveAttribute('aria-label', `Working directory: ${root.directory}`);
  await rootTree.locator(':scope > summary').click();
  await expect(rootTree.locator(':scope > article.session-card > .session .tree-directory, :scope > article.session-card > .session code')).toHaveCount(0);
  await expect(rootTree.locator(':scope > article.session-card > .activity-timeline')).toHaveCount(1);

  const childTree = page.locator('[data-agent-key="instance-alpha:child-alpha"]');
  await expect(childTree.locator(':scope > summary .badge')).toHaveCount(1);
  await expect(childTree.locator(':scope > summary .tree-activity')).toHaveCount(0);
  await expect(childTree.locator(':scope > summary .tree-directory')).toHaveText('/work/projects/child');
});

test('shows safe retry deadline and elapsed state plus a categorized error', async ({ page }) => {
  const now = Date.now();
  await installStateFixture(page, () => {
    const state = report('Retry safely', 'retry', now);
    state.instances[0].sessions[0].stateChangedAt = new Date(now - 45000).toISOString();
    state.instances[0].sessions[0].retry = { attempt: 3, nextRetryAt: new Date(now + 30000).toISOString(), message: 'private retry details' };
    state.instances[0].sessions[1].status = 'error';
    state.instances[0].sessions[1].errorCategory = 'timeout';
    return state;
  });
  await page.goto('/');
  const root = page.locator('[data-agent-key="instance-alpha:root-alpha"]');
  await root.locator(':scope > summary').click();
  await expect(root.locator('.retry-context')).toContainText('Retrying · attempt 3');
  await expect(root.locator('.retry-context')).toContainText('in retry state');
  await expect(root.locator('.retry-context')).toContainText('next retry in');
  await expect(root).not.toContainText('private retry details');
  await root.locator(':scope > article.session-card > .subagent-group > summary').click();
  const child = page.locator('[data-agent-key="instance-alpha:child-alpha"]');
  await child.locator(':scope > summary').click();
  await expect(child.locator('.error-context')).toHaveText('Last safe error category · timeout');
});

test('shows multiple safe permission requests and correlated outcomes on descendant cards', async ({ page }) => {
  const now = Date.now();
  await installStateFixture(page, () => {
    const state = report('Permission review', 'idle', now);
    const child = state.instances[0].sessions.find(session => session.id === 'child-alpha');
    child.status = 'waiting';
    child.permissions = [
      { id: 'opaque-permission-1', type: 'bash', title: 'Run command', requestedAt: new Date(now - 60000).toISOString(), timestampSource: 'observed', status: 'pending' },
      { id: 'opaque-permission-2', type: 'read', title: 'Read files', requestedAt: new Date(now - 120000).toISOString(), timestampSource: 'source', status: 'responded', resolution: 'rejected' },
    ];
    state.instances[0].events = [
      { schemaVersion: 1, id: 'permission-ask', instanceId: 'instance-alpha', sessionId: 'child-alpha', timestamp: new Date(now - 60000).toISOString(), timestampSource: 'observed', kind: 'waiting', phase: 'permission', source: 'observed', summary: 'Permission requested', parentSessionId: 'root-alpha', attributes: { permissionId: 'opaque-permission-1', permissionType: 'bash', permissionTitle: 'Run command' } },
      { schemaVersion: 1, id: 'permission-answer', instanceId: 'instance-alpha', sessionId: 'child-alpha', timestamp: new Date(now - 30000).toISOString(), timestampSource: 'observed', kind: 'permissionAnswered', phase: 'permission', source: 'observed', summary: 'Permission answered', parentSessionId: 'root-alpha', attributes: { permissionId: 'opaque-permission-2', permissionType: 'read', permissionTitle: 'Read files' } },
    ];
    return state;
  });
  await page.goto('/');
  const root = page.locator('[data-agent-key="instance-alpha:root-alpha"]');
  await expect(root.locator(':scope > summary')).toContainText('Attention in this branch');
  await root.locator(':scope > summary').click();
  await root.locator(':scope > article.session-card > .subagent-group > summary').click();
  const child = page.locator('[data-agent-key="instance-alpha:child-alpha"]');
  await child.locator(':scope > summary').click();
  const permissionDetails = child.locator('.permission-details');
  await expect(permissionDetails.locator('> summary')).toHaveText('Permissions · 1 waiting');
  await permissionDetails.locator('> summary').click();
  await expect(permissionDetails.locator('li').first()).toContainText('Run command · bash');
  await expect(permissionDetails.locator('li').first()).toContainText('Waiting · 1.0 min · request time observed locally');
  await expect(permissionDetails.locator('li').nth(1)).toContainText('Responded · rejected');
  await expect(child).not.toContainText('opaque-permission-1');
});

test('shows latest attributed file-change snapshot and unassigned workspace changes separately', async ({ page }) => {
  await installStateFixture(page, () => {
    const state = report('File changes', 'busy');
    const instance = state.instances[0];
    instance.unassignedFileCount = 2;
    instance.events = [
      { id: 'snapshot-1', sessionId: 'root-alpha', kind: 'fileChange', timestamp: '2026-10-12T10:00:00Z', attributes: { fileKey: '__snapshot__', changeType: 'snapshot', snapshotId: 'snapshot-a' } },
      { id: 'file-a', sessionId: 'root-alpha', kind: 'fileChange', timestamp: '2026-10-12T10:00:01Z', attributes: { fileKey: 'hash-a', path: '/work/alpha/app/a.ts', changeType: 'snapshot', snapshotId: 'snapshot-a', additions: 4, deletions: 2 } },
      { id: 'file-b', sessionId: 'root-alpha', kind: 'fileChange', timestamp: '2026-10-12T10:00:02Z', attributes: { fileKey: 'hash-b', path: '/work/alpha/app/b.ts', changeType: 'snapshot', snapshotId: 'snapshot-a', additions: 1, deletions: 0 } },
      { id: 'snapshot-2', sessionId: 'root-alpha', kind: 'fileChange', timestamp: '2026-10-12T10:01:00Z', attributes: { fileKey: '__snapshot__', changeType: 'snapshot', snapshotId: 'snapshot-b' } },
      { id: 'file-c', sessionId: 'root-alpha', kind: 'fileChange', timestamp: '2026-10-12T10:01:01Z', attributes: { fileKey: 'hash-c', path: '/work/alpha/app/c.ts', changeType: 'snapshot', snapshotId: 'snapshot-b', additions: 2, deletions: 1 } },
    ];
    return state;
  });
  await page.goto('/');
  const root = page.locator('[data-agent-key="instance-alpha:root-alpha"]');
  await root.locator(':scope > summary').click();
  await expect(root.locator('.unassigned-changes')).toHaveText('Workspace changes not attributed to a session · 2 files');
  const details = root.locator('article.session-card > details.file-changes');
  await expect(details.locator('> summary')).toHaveText('File changes · 1 · +2 / −1');
  await details.locator('> summary').click();
  await expect(details.locator('.file-change-list')).toHaveText('/work/alpha/app/c.ts · +2 / −1');
  await expect(details).not.toContainText('a.ts');
});

test('shows deduplicated provider and model changes in source timestamp order', async ({ page }) => {
  await installStateFixture(page, () => {
    const state = report('Model transitions', 'busy');
    const event = (id, modelId, timestamp) => ({
      schemaVersion: 1, id, messageId: id, instanceId: 'instance-alpha', sessionId: 'root-alpha', timestamp,
      timestampSource: 'source', kind: 'modelSnapshot', phase: 'model', source: 'observed', summary: 'Model observation',
      attributes: { providerId: modelId === 'model-b' ? 'provider-b' : 'provider-a', modelId },
    });
    state.instances[0].events = [
      event('message-a', 'model-a', '2026-10-12T10:00:00Z'),
      event('message-c', 'model-a', '2026-10-12T10:00:02Z'),
      event('message-b', 'model-b', '2026-10-12T10:00:01Z'),
      event('message-b', 'model-b', '2026-10-12T10:00:01Z'),
    ];
    return state;
  });
  await page.goto('/');
  const root = page.locator('[data-agent-key="instance-alpha:root-alpha"]');
  await root.locator(':scope > summary').click();
  const modelHistory = root.locator('article.session-card > details.model-history');
  await expect(modelHistory.locator('> summary')).toHaveText('Model changes · 2');
  await modelHistory.locator('> summary').click();
  await expect(modelHistory.locator('li')).toHaveText([
    'provider-a/model-a → provider-b/model-b · 2026-10-12 10:00',
    'provider-b/model-b → provider-a/model-a · 2026-10-12 10:00',
  ]);
});

test('shows workspace-level MCP health without exposing endpoints or credentials', async ({ page }) => {
  await installStateFixture(page, () => {
    const state = report('MCP workspace', 'busy');
    state.instances[0].mcpHealth = { available: true, status: 'available', observedAt: '2026-10-12T10:00:00Z', servers: [
      { name: 'local-build', state: 'connected', lastTransitionAt: '2026-10-12T09:59:00Z' },
      { name: 'auth-required', state: 'auth-required' },
      { name: 'failing-server', state: 'failed' },
    ] };
    state.instances[0].lspHealth = {
      observedAt: '2026-10-12T10:00:00Z',
      lsp: { status: 'available', servers: [{ name: 'tsserver', state: 'connected' }, { name: 'pyright', state: 'failed' }] },
      formatter: { status: 'available', formatters: [{ name: 'prettier', state: 'available' }] },
      diagnostics: { available: true, observedAt: '2026-10-12T09:59:00Z', errors: 1, warnings: 2, information: 0, hints: 0, partial: false },
    };
    return state;
  });
  await page.goto('/');
  const root = page.locator('[data-agent-key="instance-alpha:root-alpha"]');
  const group = root.locator('xpath=ancestor::details[contains(@class,"session-group")]').last();
  if (await group.getAttribute('open') === null) await group.locator(':scope > summary').click();
  await root.locator(':scope > summary').click();
  const details = root.locator('article.session-card > details.mcp-health');
  await expect(details.locator('> summary')).toContainText('Workspace MCP servers · 1 connected · 1 failed · 1 auth required');
  await details.locator('> summary').click();
  await expect(details.locator('li').nth(0)).toContainText('local-build · connected');
  await expect(details.locator('li').nth(1)).toHaveText('auth-required · auth-required');
  await expect(details.locator('li').nth(2)).toHaveText('failing-server · failed');
  await expect(details).not.toContainText(/https?:|token|secret|credential/i);
  const lsp = root.locator('article.session-card > details.lsp-health');
  await expect(lsp.locator('> summary')).toContainText('LSP · 1 connected · 1 failed · 1 formatters available · 3 diagnostics');
  await lsp.locator('> summary').click();
  await expect(lsp.locator('li').nth(0)).toContainText('LSP tsserver · connected');
  await expect(lsp.locator('li').nth(2)).toContainText('Formatter prettier · available');
  await expect(lsp.locator('li').nth(3)).toContainText('Diagnostics · 1 errors · 2 warnings');
});

test('shows observed delegation lifecycle, explicit task link, concurrent child and restored unknowns', async ({ page }) => {
  const start = Date.parse('2026-10-12T10:00:00Z');
  const stamp = seconds => new Date(start + seconds * 1000).toISOString();
  const event = (id, sessionId, kind, timestamp, attributes = {}, parentSessionId) => ({
    schemaVersion: 1, id, instanceId: 'instance-alpha', sessionId, timestamp, timestampSource: 'source', kind,
    phase: kind === 'toolActivity' ? 'tool' : kind === 'busy' ? 'working' : 'lifecycle', source: 'observed',
    summary: kind === 'toolActivity' ? 'Tool activity' : kind === 'created' ? 'Session created' : kind === 'deleted' ? 'Session ended' : 'Agent started working',
    ...(parentSessionId ? { parentSessionId } : {}), ...(Object.keys(attributes).length ? { attributes } : {}),
  });
  await installStateFixture(page, () => {
    const state = report('Delegate task', 'busy', start + 12000);
    state.instances[0].sessions.push(
      { id: 'child-one', parentID: 'root-alpha', title: 'Linked child', status: 'idle', stateChangedAt: stamp(7) },
      { id: 'child-two', parentID: 'root-alpha', title: 'Concurrent child', status: 'busy' },
      { id: 'child-restored', parentID: 'root-alpha', title: 'Restored child', status: 'busy', restored: true },
    );
    state.instances[0].timeline = { partial: true, intervals: [
      { sessionId: 'root-alpha', startAt: stamp(0), endAt: null, status: 'busy' },
      { sessionId: 'child-one', startAt: stamp(1), endAt: stamp(7), status: 'busy' },
      { sessionId: 'child-two', startAt: stamp(2), endAt: null, status: 'busy' },
    ] };
    state.instances[0].events = [
      event('task-start', 'root-alpha', 'toolActivity', stamp(0), { toolName: 'task', toolStatus: 'running' }, undefined),
      { ...event('task-call-start', 'root-alpha', 'toolActivity', stamp(0), { toolName: 'task', toolStatus: 'running' }), messageId: 'parent-message', toolCallId: 'task-call-1', outcome: 'started' },
      { ...event('task-call-end', 'root-alpha', 'toolActivity', stamp(2), { toolName: 'task', toolStatus: 'completed' }), messageId: 'parent-message', toolCallId: 'task-call-1', outcome: 'completed' },
      event('child-one-created', 'child-one', 'created', stamp(1), { delegationId: 'task-call-1' }, 'root-alpha'),
      event('child-one-ended', 'child-one', 'deleted', stamp(7), {}, 'root-alpha'),
      event('child-two-created', 'child-two', 'created', stamp(2), {}, 'root-alpha'),
      event('parent-working-again', 'root-alpha', 'busy', stamp(9)),
    ];
    return state;
  });
  await page.goto('/');
  await page.getByText('Filter agents', { exact: true }).click();
  await page.locator('#hide-finished').uncheck();
  const root = page.locator('[data-agent-key="instance-alpha:root-alpha"]');
  await root.locator(':scope > summary').click();
  const group = root.locator(':scope > article.session-card > .subagent-group');
  await group.locator('> summary').click();
  const linked = page.locator('[data-agent-key="instance-alpha:child-one"]');
  await linked.locator(':scope > summary').click();
  await expect(linked.locator('.delegation-lifecycle')).toContainText('Explicitly linked to task call task-call-1');
  await expect(linked.locator('.delegation-lifecycle')).toContainText('dispatch-to-start 1.0 s');
  await expect(linked.locator('.delegation-lifecycle')).toContainText('source-timed interval 6.0 s');
  const concurrent = page.locator('[data-agent-key="instance-alpha:child-two"]');
  await concurrent.locator(':scope > summary').click();
  await expect(concurrent.locator('.delegation-lifecycle')).toContainText('Task-call correlation unavailable');
  const restored = page.locator('[data-agent-key="instance-alpha:child-restored"]');
  await restored.locator(':scope > summary').click();
  await expect(restored.locator('.delegation-lifecycle')).toContainText('Start time unavailable');
  const timeline = root.locator('.execution-timeline');
  await timeline.locator(':scope > summary').click();
  await expect(timeline.locator('.timeline-lifecycle-marker')).toHaveCount(4);
});

test('warns per instance when reports use legacy host-based identity', async ({ page }) => {
  const now = Date.now();
  await installStateFixture(page, () => ({ mode: 'local', serverTime: now, instances: [
    { instanceId: 'legacy-instance', host: 'shared-host', online: true, lastSeen: now, sessions: [{ id: 'legacy-session', title: 'Legacy report', status: 'busy' }] },
    { instanceId: 'current-instance', machineId: 'machine-current', host: 'current-host', online: true, lastSeen: now, sessions: [{ id: 'current-session', title: 'Current report', status: 'busy' }] },
  ] }));
  await page.goto('/');

  const legacy = page.locator('[data-agent-key="legacy-instance:legacy-session"] .instance-warning');
  await expect(legacy).toContainText('legacy host-based identity');
  await expect(legacy).toContainText('Update or reinstall');
  await expect(page.locator('[data-agent-key="current-instance:current-session"] .instance-warning')).toHaveCount(0);
});

test('updates keyed session nodes across rapid state changes and removes deleted sessions', async ({ page }) => {
  let polls = 0;
  await installStateFixture(page, () => {
    polls++;
    const state = report(polls === 1 ? 'Build dashboard' : polls === 2 ? 'Deploy dashboard' : 'Ship dashboard', 'busy');
    if (polls >= 4) state.instances[0].sessions = state.instances[0].sessions.filter(session => session.id !== 'root-alpha');
    return state;
  });
  await page.goto('/');
  const root = page.locator('[data-agent-key="instance-alpha:root-alpha"]');
  await expect(root).toBeVisible();
  await page.evaluate(() => { window.stableSessionNode = document.querySelector('[data-agent-key="instance-alpha:root-alpha"]'); });
  await root.locator(':scope > summary').click();
  await page.getByText('Filter agents', { exact: true }).click();
  const search = page.getByLabel('Search');
  await search.fill('dashboard');
  await search.evaluate(input => { input.focus(); input.setSelectionRange(3, 6); });
  await expect(page.getByText('Deploy dashboard', { exact: true })).toBeVisible();
  await expect(page.getByText('Ship dashboard', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.querySelector('[data-agent-key="instance-alpha:root-alpha"]') === window.stableSessionNode)).toBe(true);
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('dashboard');
  await expect.poll(() => search.evaluate(input => input.selectionStart === 3 && input.selectionEnd === 6)).toBe(true);
  await expect(page.getByText('Ship dashboard', { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-agent-key="instance-alpha:root-alpha"]')).toHaveCount(0);
});

test('renders status-only instances with optional metadata omitted', async ({ page }) => {
  const now = Date.now();
  await installStateFixture(page, () => ({ mode: 'local', serverTime: now, instances: [{
    instanceId: 'status-only', machineId: 'machine', host: 'private-host', pid: 42, online: true, lastSeen: now,
    sessions: [{ id: 'session', status: 'busy' }],
  }] }));
  await page.goto('/');

  await expect(page.locator('#host option').filter({ hasText: 'private-host' })).toHaveCount(1);
  await expect(page.getByText('Session', { exact: true })).toBeVisible();
  await expect(page.locator('[data-agent-key="status-only:session"] > summary .badge')).toHaveText('busy');
});

test('distinguishes replaced instances from instances that are merely offline', async ({ page }) => {
  const now = Date.now();
  await installStateFixture(page, () => ({ mode: 'local', serverTime: now, instances: [
    { instanceId: 'replaced', host: 'alpha', pid: 42, online: false, replaced: true, lastSeen: now, sessions: [] },
    { instanceId: 'offline', host: 'beta', pid: 43, online: false, lastSeen: now, sessions: [] },
  ] }));
  await page.goto('/');
  await page.getByText('Filter agents', { exact: true }).click();
  await page.locator('#hide-offline').uncheck();

  await expect(page.locator('#fleet').getByText(/alpha · ↻ Replaced · PID 42/)).toBeVisible();
  await expect(page.locator('#fleet').getByText(/beta · ○ Offline · PID 43/)).toBeVisible();
});

test('renders nested agents, preserves expansion, surfaces descendant attention, and keeps orphans and cycles accessible', async ({ page }) => {
  let polls = 0;
  await installStateFixture(page, () => {
    polls += 1;
    const state = report(polls > 1 ? 'Build dashboard updated' : 'Build dashboard');
    state.instances[0].sessions.push(
      { id: 'deep-agent', parentID: 'child-alpha', title: 'Deep agent', status: 'waiting', directory: '/work/alpha/app', activity: 'Needs approval' },
      { id: 'orphan-agent', parentID: 'missing-parent', title: 'Orphan agent', status: 'busy', directory: '/work/alpha/app', activity: 'Working' },
      { id: 'cycle-a', parentID: 'cycle-b', title: 'Cycle A', status: 'busy', directory: '/work/alpha/app', activity: 'Working' },
      { id: 'cycle-b', parentID: 'cycle-a', title: 'Cycle B', status: 'busy', directory: '/work/alpha/app', activity: 'Working' },
    );
    return state;
  });
  await page.goto('/');
  const root = page.locator('details[data-agent-key="instance-alpha:root-alpha"]');
  await expect(root).toBeVisible();
  await expect(root.locator(':scope > summary')).toContainText('Attention in this branch');
  await root.locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  await root.locator(':scope > article.session-card > .subagent-group > summary').click();
  const child = page.locator('details[data-agent-key="instance-alpha:child-alpha"]');
  await child.locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Deep agent', { exact: true })).toBeVisible();
  await expect(page.getByText('Orphan agent', { exact: true })).toBeVisible();
  const cycle = page.locator('details[data-agent-key="instance-alpha:cycle-a"]');
  await expect(cycle.locator(':scope > summary')).toContainText('Cycle A');
  await expect(page.getByText('Cycle B', { exact: true })).toHaveCount(1);
  await expect(page.locator('.tree-title').filter({ hasText: 'Build dashboard updated' })).toBeVisible();
  await expect(root).toHaveAttribute('open', '');
  await expect(child).toHaveAttribute('open', '');
});

test('groups eligible descendants once, preserves child expansion through polls and filtering, and exposes attention while collapsed', async ({ page }) => {
  let polls = 0;
  await installStateFixture(page, () => {
    polls++;
    const state = report();
    state.instances[0].sessions.push(
      { id: 'grandchild', parentID: 'child-alpha', title: 'Nested worker', status: 'waiting', activity: 'Needs approval' },
      { id: 'working-child', parentID: 'root-alpha', title: 'Working child', status: 'busy' },
      { id: 'old-child', parentID: 'root-alpha', title: 'Old finished child', status: 'idle', stateChangedAt: '2020-01-01T00:00:00.000Z' },
    );
    return state;
  });
  await page.goto('/');
  const root = page.locator('details[data-agent-key="instance-alpha:root-alpha"]');
  await root.locator(':scope > summary').click();
  const group = root.locator(':scope > article.session-card > .subagent-group');
  await expect(group.locator(':scope > summary')).toContainText('Subagents · 4');
  await expect(group.locator(':scope > summary')).toContainText('need attention');
  await expect(group.locator('details.subagent-row')).toHaveCount(4);
  await expect(group.getByText('Old finished child', { exact: true })).toHaveCount(0);

  await group.locator(':scope > summary').click();
  const child = group.locator('[data-agent-key="instance-alpha:working-child"]');
  await child.locator(':scope > summary').click();
  await expect(child.locator(':scope > article.session-card')).toBeVisible();
  await expect.poll(() => polls).toBeGreaterThan(1);
  await expect(group).toHaveAttribute('open', '');
  await expect(child).toHaveAttribute('open', '');

  await page.getByText('Filter agents', { exact: true }).click();
  await page.locator('#hide-finished').uncheck();
  await expect(group.locator(':scope > summary')).toContainText('Subagents · 5');
  await expect(group.getByText('Old finished child', { exact: true })).toBeVisible();
  await expect(child).toHaveAttribute('open', '');
  await group.locator(':scope > summary').click();
  await expect(group.locator(':scope > summary')).toContainText('need attention');
});

test('searches todo content through nested sessions while preserving ancestor context and filters across polls', async ({ page }) => {
  let polls = 0;
  await installStateFixture(page, () => {
    polls++;
    const state = report(polls > 1 ? 'Build dashboard updated' : 'Build dashboard');
    state.instances[0].sessions.push(
      { id: 'task-child', parentID: 'root-alpha', title: 'Implement details', status: 'busy', directory: '/work/alpha/app', activity: 'Working', todos: [{ status: 'in_progress', content: 'Distinctive nested task text' }] },
    );
    return state;
  });
  await page.goto('/');
  await page.getByText('Filter agents').click();
  await page.getByLabel('Computer').selectOption('legacy:alpha');
  await page.locator('#active').check();
  await page.getByLabel('Search').fill('distinctive nested task text');

  const root = page.locator('details[data-agent-key="instance-alpha:root-alpha"]');
  await expect(root).toBeVisible();
  await expect(root.locator(':scope > summary')).toContainText('Build dashboard');
  await expect(page.getByText('Implement details', { exact: true })).toBeHidden();
  await root.locator(':scope > summary').click();
  await root.locator(':scope > article.session-card > .subagent-group > summary').click();
  const task = page.locator('[data-agent-key="instance-alpha:task-child"]');
  await task.locator(':scope > summary').click();
  await expect(page.getByText('Implement details', { exact: true })).toBeVisible();
  await expect(page.getByText('Distinctive nested task text')).toBeVisible();

  await expect(page.getByText('Build dashboard updated', { exact: true })).toBeVisible();
  await expect(page.locator('#host')).toHaveValue('legacy:alpha');
  await expect(page.locator('#active')).toBeChecked();
  await expect(page.locator('#search')).toHaveValue('distinctive nested task text');
  await expect(root).toHaveAttribute('open', '');
});

test('shows sanitized chronological per-agent activity and preserves expansion across polls', async ({ page }) => {
  let polls = 0;
  await installStateFixture(page, () => {
    polls++;
    const state = report(polls > 1 ? 'Build dashboard updated' : 'Build dashboard');
    state.instances[0].events = [
      { sessionId: 'root-alpha', timestamp: '2026-01-01T10:02:00.000Z', kind: 'waiting', summary: 'private permission payload' },
      { sessionId: 'root-alpha', timestamp: '2026-01-01T10:01:00.000Z', kind: 'busy', summary: '<script>secret</script>' },
      { sessionId: 'root-alpha', timestamp: 'invalid', kind: 'error', summary: 'ignored' },
      { sessionId: 'root-alpha', timestamp: '2026-01-01T10:03:00.000Z', kind: 'error', summary: 'raw error detail' },
    ];
    return state;
  });
  await page.goto('/');
  const root = page.locator('details.agent-tree[data-agent-key="instance-alpha:root-alpha"]');
  await root.locator(':scope > summary.agent-tree-summary').click();
  await root.locator(':scope > article.session-card > .subagent-group > summary').click();
  const timeline = root.locator(':scope > article.session-card > details.activity-timeline');
  await expect(timeline).toContainText('Recent activity · 3');
  await timeline.locator('summary').click();
  await expect(timeline.locator('.activity-kind')).toHaveText(['Working', 'Permission requested', 'Error']);
  await expect(timeline.locator('time')).toHaveCount(3);
  await expect(timeline.locator('time').first()).toHaveText('2026-01-01 10:01');
  await expect(timeline.locator('time').first()).not.toContainText(/seconds|AM|PM/);
  await expect(timeline).not.toContainText('private permission payload');
  await expect(timeline).not.toContainText('raw error detail');
  await expect(timeline).not.toContainText('<script>');
  await expect(page.getByText('Build dashboard updated', { exact: true })).toBeVisible();
  await expect(timeline).toHaveAttribute('open', '');
  await expect(timeline.locator('.activity-kind')).toHaveText(['Working', 'Permission requested', 'Error']);
});

test('shows a compact empty activity state for agents without event history', async ({ page }) => {
  await installStateFixture(page, () => report());
  await page.goto('/');
  const root = page.locator('details.agent-tree[data-agent-key="instance-alpha:root-alpha"]');
  await root.locator(':scope > summary.agent-tree-summary').click();
  await root.locator(':scope > article.session-card > .subagent-group > summary').click();
  const child = root.locator('[data-agent-key="instance-alpha:child-alpha"]');
  await child.locator(':scope > summary').click();
  const timeline = child.locator(':scope > article.session-card > details.activity-timeline');
  await timeline.locator('summary').click();
  await expect(timeline).toContainText('No recent activity reported.');
});

test('attention notifications are opt-in, fire once on live transitions, and tab count is optional', async ({ page }) => {
  let polls = 0;
  await page.addInitScript(() => {
    window.notificationCalls = [];
    window.Notification = class {
      static permission = 'granted';
      static requestPermission() { window.permissionRequests = (window.permissionRequests || 0) + 1; return Promise.resolve('granted'); }
      constructor(title, options) { window.notificationCalls.push({ title, options }); }
    };
  });
  await installStateFixture(page, () => {
    polls++;
    const state = report();
    const session = state.instances[0].sessions.find(item => item.id === 'root-alpha');
    session.status = polls < 3 ? 'busy' : 'waiting';
    session.stateChangedAt = polls < 3 ? '2026-01-01T00:00:00.000Z' : '2026-01-01T00:00:02.000Z';
    return state;
  });
  await page.goto('/');
  await expect(page.locator('.tree-title').filter({ hasText: 'Build dashboard' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.notificationCalls.length)).toBe(0);
  await page.getByText('Filter agents', { exact: true }).click();
  await page.locator('#notifications').check();
  await expect.poll(() => page.evaluate(() => window.notificationCalls.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.notificationCalls.length)).toBe(1);
  await expect(page.evaluate(() => window.permissionRequests || 0)).resolves.toBe(0);
  await page.locator('#tab-count').check();
  await expect(page).toHaveTitle('(2) AgentDashboard');
  await page.locator('#tab-count').uncheck();
  await expect(page).toHaveTitle('AgentDashboard');
  await page.locator('#notifications').uncheck();
});

test('existing attention states do not notify on initial load or after reconnect', async ({ page }) => {
  let polls = 0;
  await page.addInitScript(() => {
    window.notificationCalls = [];
    window.Notification = class { static permission = 'granted'; constructor(title) { window.notificationCalls.push(title); } };
  });
  await installStateFixture(page, () => {
    polls++;
    const state = report();
    state.instances[0].sessions[0].status = 'error';
    if (polls === 2) return { status: 503, body: { error: 'offline' } };
    return state;
  });
  await page.goto('/');
  await expect(page.getByText('● Connected · local only')).toBeVisible();
  await page.getByText('Filter agents', { exact: true }).click();
  await page.locator('#notifications').check();
  await expect.poll(() => page.evaluate(() => window.notificationCalls.length)).toBe(0);
});

test('groups hidden descendant notifications under one privacy-safe root alert', async ({ page }) => {
  let polls = 0;
  await page.addInitScript(() => {
    window.notificationCalls = [];
    window.Notification = class {
      static permission = 'granted';
      constructor(title, options) { window.notificationCalls.push({ title, options }); }
    };
  });
  await installStateFixture(page, () => {
    polls++;
    const state = report('Build safely', 'busy');
    const permissionChild = state.instances[0].sessions.find(session => session.id === 'child-alpha');
    const errorChild = { id: 'error-child', parentID: 'root-alpha', title: 'Helper', status: 'busy' };
    if (polls >= 2) {
      permissionChild.status = 'waiting';
      permissionChild.permissions = [{ id: 'private-id', type: 'bash', title: 'Run command', requestedAt: new Date().toISOString(), status: 'pending' }];
      errorChild.status = 'error'; errorChild.errorCategory = 'timeout';
    }
    state.instances[0].sessions.push(errorChild);
    return state;
  });
  await page.goto('/');
  await expect(page.locator('.tree-title').filter({ hasText: 'Build safely' })).toBeVisible();
  await page.getByText('Filter agents', { exact: true }).click();
  await page.locator('#notifications').check();
  await expect.poll(() => page.evaluate(() => window.notificationCalls.length)).toBe(1);
  const notification = await page.evaluate(() => window.notificationCalls[0]);
  expect(notification.title).toBe('Build safely needs attention');
  expect(notification.options.body).toContain('Run command');
  expect(notification.options.body).toContain('timeout');
  expect(notification.options.body).not.toMatch(/private-id|\/|PRIVATE/);
  await page.waitForTimeout(2200);
  await expect.poll(() => page.evaluate(() => window.notificationCalls.length)).toBe(1);
});

test('uses Tauri native notifications when available and focuses the dashboard on action', async ({ page }) => {
  let polls = 0;
  await page.addInitScript(() => {
    window.nativeNotifications = [];
    window.nativeInvocations = [];
    window.__TAURI__ = {
      notification: {
        isPermissionGranted: async () => true,
        requestPermission: async () => 'granted',
        sendNotification: notification => window.nativeNotifications.push(notification),
        onAction: async callback => { window.nativeNotificationAction = callback; return () => {}; },
      },
      core: { invoke: async command => { window.nativeInvocations.push(command); } },
    };
  });
  await installStateFixture(page, () => {
    polls++;
    const state = report();
    const child = state.instances[0].sessions.find(session => session.id === 'child-alpha');
    child.status = polls < 2 ? 'busy' : 'error';
    child.errorCategory = polls < 2 ? undefined : 'provider';
    return state;
  });
  await page.goto('/');
  await page.getByText('Filter agents', { exact: true }).click();
  await page.locator('#notifications').check();
  await expect.poll(() => page.evaluate(() => window.nativeNotifications.length)).toBe(1);
  const notification = await page.evaluate(() => window.nativeNotifications[0]);
  expect(notification.title).toBe('Build dashboard needs attention');
  expect(notification.body).toContain('Error · provider');
  await page.evaluate(() => window.nativeNotificationAction());
  await expect.poll(() => page.evaluate(() => window.nativeInvocations.includes('focus_dashboard'))).toBe(true);
});

test('execution timeline is collapsed, accessible, and retains state across polling', async ({ page }) => {
  await installStateFixture(page, () => {
    const state = report();
    state.instances[0].sessions[0].lastCompactedAt = '2026-10-12T10:00:03Z';
    state.instances[0].sessions[0].contextEstimateAt = '2026-10-12T09:58:00Z';
    state.instances[0].sessions[0].compactionCount = 1;
    state.instances[0].events = [
      { schemaVersion: 1, id: 'call-start', instanceId: 'instance-alpha', sessionId: 'root-alpha', messageId: 'message-1', toolCallId: 'call-1', timestamp: '2026-10-12T10:00:01Z', timestampSource: 'source', kind: 'toolActivity', phase: 'tool', outcome: 'started', source: 'observed', summary: 'Tool activity', attributes: { toolName: 'bash' } },
      { schemaVersion: 1, id: 'call-finish', instanceId: 'instance-alpha', sessionId: 'root-alpha', messageId: 'message-1', toolCallId: 'call-1', timestamp: '2026-10-12T10:00:04Z', timestampSource: 'source', kind: 'toolActivity', phase: 'tool', outcome: 'completed', source: 'observed', summary: 'Tool activity', attributes: { toolName: 'bash' } },
      { schemaVersion: 1, id: 'call-running', instanceId: 'instance-alpha', sessionId: 'root-alpha', messageId: 'message-2', toolCallId: 'call-2', timestamp: '2026-10-12T10:00:05Z', timestampSource: 'observed', kind: 'toolActivity', phase: 'tool', outcome: 'started', source: 'observed', summary: 'Tool activity', attributes: { toolName: 'read' } },
      { schemaVersion: 1, id: 'call-error', instanceId: 'instance-alpha', sessionId: 'root-alpha', messageId: 'message-3', toolCallId: 'call-3', timestamp: '2026-10-12T10:00:06Z', timestampSource: 'source', kind: 'toolActivity', phase: 'tool', outcome: 'failure', source: 'observed', summary: 'Tool activity', attributes: { toolName: 'edit' } },
      { schemaVersion: 1, id: 'compaction-1', instanceId: 'instance-alpha', sessionId: 'root-alpha', timestamp: '2026-10-12T10:00:03Z', timestampSource: 'source', kind: 'compaction', phase: 'model', source: 'observed', summary: 'Context compacted' },
    ];
    state.instances[0].timeline = { partial: true, intervals: [
      { sessionId: 'root-alpha', startAt: '2026-10-12T10:00:00Z', endAt: '2026-10-12T10:00:05Z', status: 'busy' },
      { sessionId: 'root-alpha', startAt: '2026-10-12T10:00:05Z', endAt: null, status: 'idle' },
      { sessionId: 'child-alpha', startAt: '2026-10-12T10:00:02Z', endAt: null, status: 'waiting' },
      { sessionId: 'archived-child', startAt: '2026-10-12T10:00:01Z', endAt: '2026-10-12T10:00:04Z', status: 'busy' },
    ] };
    state.instances[0].sessions.push({ id: 'unknown-child', parentID: 'root-alpha', title: 'Unknown child', status: 'idle' });
    state.instances[0].sessions.push({ id: 'archived-child', parentID: 'root-alpha', title: 'Archived child', status: 'idle', archived: true, ended: true });
    return state;
  });
  await page.goto('/');
  await page.setViewportSize({ width: 375, height: 800 });
  const root = page.locator('.agent-tree').filter({ has: page.getByText('Build dashboard', { exact: true }) }).first();
  await root.locator('> summary').click();
  await expect(root.locator('.compaction-context')).toContainText('post-compaction usage is pending');
  const toolDetails = root.locator('article.session-card > details.tool-spans');
  await expect(toolDetails.locator('> summary')).toContainText('Tool calls · 3 · 1 failed · 1 active · recorded 3.0 s · partial');
  await toolDetails.locator('> summary').click();
  await expect(toolDetails.locator('.tool-span-list > li')).toHaveText([
    'bash · Completed · 3.0 sstarted 2026-10-12 10:00 · ended 2026-10-12 10:00',
    'read · Runningstart time unavailable · first observed 2026-10-12 10:00 · end time unavailable',
    'edit · Failedstart time unavailable · ended 2026-10-12 10:00',
  ]);
  await expect(toolDetails.locator('.tool-category-summary')).toContainText('bash · 1 call · recorded 3.0 s');
  await expect(toolDetails.locator('ol')).toContainText('start time unavailable');
  const timeline = root.locator('.execution-timeline');
  await expect(timeline).toBeVisible();
  await expect(timeline.locator('> summary')).toHaveText('Execution timeline');
  await expect(timeline).not.toHaveAttribute('open', '');
  await timeline.locator('> summary').click();
  await expect(timeline).toHaveAttribute('open', '');
  await expect(timeline.locator('.timeline-details')).not.toHaveAttribute('open', '');
  await expect(timeline.locator('ol')).toContainText('busy');
  await expect(timeline.locator('ol')).toContainText('waiting');
  await expect(timeline.locator('.timeline-legend-item')).toHaveCount(9);
  await expect(timeline.locator('.timeline-compaction-marker')).toHaveCount(1);
  await expect(timeline.locator('.timeline-row').first().locator('.timeline-interval')).toHaveCount(1);
  await expect(timeline.locator('.timeline-session').filter({ hasText: 'Archived child · ended' })).toHaveCount(1);
  await expect(timeline.locator('.timeline-unknown').first()).toHaveText('Unknown · partial history');
  await expect(timeline).toContainText('Partial history');
  await expect(timeline.locator('.timeline-chart')).toHaveAttribute('role', 'img');
  expect(await timeline.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await timeline.evaluate(node => node.parentElement.classList.contains('session-card'))).toBe(true);
  await expect(timeline.getByRole('slider', { name: 'Timeline range start' })).toHaveCount(1);
  const rangeStart = timeline.locator('input[aria-label="Timeline range start"]');
  await rangeStart.focus();
  await page.keyboard.press('End');
  await expect(rangeStart).toHaveValue('999');
  await expect(timeline.locator('.timeline-axis span').first()).not.toHaveText('2026-10-12 10:00');
  await timeline.locator('.timeline-details > summary').click();
  await expect(timeline.locator('.timeline-details')).toHaveAttribute('open', '');
  await timeline.locator('> summary').click();
  await expect(timeline).not.toHaveAttribute('open', '');
  await page.waitForTimeout(2500);
  await expect(timeline.locator('> summary')).toBeVisible();
  await expect(timeline).not.toHaveAttribute('open', '');
  await expect(rangeStart).toHaveValue('999');
});
