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
        git: { root: '/work/alpha/app', status: 'clean', log: 'abc123 Initial commit', worktrees: '' },
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

async function installStateFixture(page, handler) {
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

  await expect(page.getByText('● Connected · local only')).toBeVisible();
  await expect(page.locator('.tree-title').filter({ hasText: 'Build dashboard' })).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Needs attention · 1' })).toBeVisible();
  await expect(page.getByText('Approve deployment', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Working · 1' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting for input · 1' })).toBeVisible();
  const root = page.locator('details[data-agent-key="instance-alpha:root-alpha"]');
  await expect(root.locator(':scope > summary')).toContainText('2 children');
  await root.locator(':scope > summary').click();
  await expect(page.getByText('Finished review', { exact: true })).toBeVisible();
  await expect(page.getByText('Unknown-age review', { exact: true })).toBeVisible();

  await page.getByText('Filter agents').click();
  await page.getByLabel('Computer').selectOption('beta');
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

test('renders status-only instances with optional metadata omitted', async ({ page }) => {
  const now = Date.now();
  await installStateFixture(page, () => ({ mode: 'local', serverTime: now, instances: [{
    instanceId: 'status-only', machineId: 'machine', host: 'private-host', pid: 42, online: true, lastSeen: now,
    sessions: [{ id: 'session', status: 'busy' }],
  }] }));
  await page.goto('/');

  await expect(page.locator('#host option').filter({ hasText: 'private-host' })).toHaveCount(1);
  await expect(page.getByText('Session', { exact: true })).toBeVisible();
  await expect(page.locator('#fleet .badge').getByText('busy', { exact: true })).toBeVisible();
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
  const child = page.locator('details[data-agent-key="instance-alpha:child-alpha"]');
  await child.locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Deep agent', { exact: true })).toBeVisible();
  await expect(page.getByText('Orphan agent', { exact: true })).toBeVisible();
  const cycle = page.locator('details[data-agent-key="instance-alpha:cycle-a"]');
  await expect(cycle.locator(':scope > summary')).toContainText('Cycle A');
  await cycle.locator(':scope > summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Cycle B', { exact: true })).toBeVisible();
  await expect(page.locator('.tree-title').filter({ hasText: 'Build dashboard updated' })).toBeVisible();
  await expect(root).toHaveAttribute('open', '');
  await expect(child).toHaveAttribute('open', '');
});
