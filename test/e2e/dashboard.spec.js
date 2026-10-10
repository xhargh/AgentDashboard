import { expect, test } from '@playwright/test';

const token = 'e2e-network-token-with-at-least-24-characters';

function report(title = 'Build dashboard', status = 'busy') {
  const now = Date.now();
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
  await installStateFixture(page, () => report());
  await page.goto('/');

  await expect(page.getByText('● Connected · local only')).toBeVisible();
  await expect(page.getByText('Build dashboard', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Needs attention · 1' })).toBeVisible();
  await expect(page.getByText('Approve deployment', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Working · 1' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waiting for input · 1' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recently finished · 1' })).toHaveCount(0);
  await expect(page.getByText('Finished review')).toHaveCount(0);

  await page.getByText('Filter agents').click();
  await page.getByLabel('Computer').selectOption('beta');
  await expect(page.getByText('Fix API', { exact: true })).toBeVisible();
  await expect(page.getByText('Build dashboard', { exact: true })).toHaveCount(0);

  await page.getByLabel('Computer').selectOption('');
  await page.getByLabel('Search').fill('Editing app.js');
  await expect(page.getByText('Build dashboard', { exact: true })).toBeVisible();
  await expect(page.getByText('Approve deployment', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Fix API', { exact: true })).toHaveCount(0);

  await page.getByLabel('Search').fill('');
  await page.locator('#active').check();
  await expect(page.getByText('Build dashboard', { exact: true })).toBeVisible();
  await expect(page.getByText('Fix API', { exact: true })).toHaveCount(0);
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
  await expect(page.getByText('Build dashboard', { exact: true })).toBeVisible();

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
  await expect(page.getByText('Build dashboard', { exact: true })).toBeVisible();

  const details = page.locator('details[data-instance="instance-alpha"]');
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');

  await expect(page.getByText('Deploy dashboard', { exact: true })).toBeVisible();
  await expect(details).toHaveAttribute('open', '');
  await expect(details.getByRole('heading', { name: 'Recent commits' })).toBeVisible();
});

test('renders status-only instances without optional metadata', async ({ page }) => {
  const now = Date.now();
  await installStateFixture(page, () => ({ mode: 'local', serverTime: now, instances: [{
    instanceId: 'status-only', machineId: 'machine', host: 'private-host', pid: 42, online: true, lastSeen: now,
    sessions: [{ id: 'session', status: 'busy' }],
  }] }));
  await page.goto('/');

  await expect(page.getByText('private-host', { exact: true })).toBeVisible();
  await expect(page.getByText('Session', { exact: true })).toBeVisible();
  await expect(page.getByText('busy', { exact: true })).toBeVisible();
  await expect(page.getByText('undefined', { exact: true })).toHaveCount(0);
});

test('updates keyed session nodes across rapid state changes and removes deleted sessions', async ({ page }) => {
  let polls = 0;
  await installStateFixture(page, () => {
    polls++;
    const state = report(polls === 1 ? 'Build dashboard' : polls === 2 ? 'Deploy dashboard' : 'Ship dashboard', polls < 3 ? 'busy' : 'error');
    if (polls >= 4) state.instances[0].sessions = state.instances[0].sessions.filter(session => session.id !== 'root-alpha');
    return state;
  });
  await page.goto('/');
  const root = page.locator('[data-agent-key="instance-alpha:root-alpha"]');
  await expect(root).toBeVisible();
  await page.evaluate(() => { window.stableSessionNode = document.querySelector('[data-agent-key="instance-alpha:root-alpha"]'); });
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
  await expect(root.locator('summary')).toContainText('Attention in this branch');
  await root.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('details[data-agent-key="instance-alpha:child-alpha"]')).toBeVisible();
  const child = page.locator('details[data-agent-key="instance-alpha:child-alpha"]');
  await child.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Deep agent', { exact: true })).toBeVisible();
  await expect(page.getByText('Orphan agent', { exact: true })).toBeVisible();
  await expect(page.getByText('Cycle A', { exact: true })).toBeVisible();
  const cycle = page.locator('details[data-agent-key="instance-alpha:cycle-a"]');
  await cycle.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Cycle B', { exact: true })).toBeVisible();
  await expect(page.getByText('Build dashboard updated', { exact: true })).toBeVisible();
  await expect(root).toHaveAttribute('open', '');
  await expect(child).toHaveAttribute('open', '');
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
  await page.getByLabel('Computer').selectOption('alpha');
  await page.locator('#active').check();
  await page.getByLabel('Search').fill('distinctive nested task text');

  const root = page.locator('details[data-agent-key="instance-alpha:root-alpha"]');
  await expect(root).toBeVisible();
  await expect(page.getByText('Build dashboard', { exact: true })).toBeVisible();
  await expect(page.getByText('Implement details', { exact: true })).toHaveCount(0);
  await root.locator('summary').click();
  await expect(page.getByText('Implement details', { exact: true })).toBeVisible();
  await expect(page.getByText('Distinctive nested task text')).toBeVisible();

  await expect(page.getByText('Build dashboard updated', { exact: true })).toBeVisible();
  await expect(page.locator('#host')).toHaveValue('alpha');
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
  const card = page.locator('.session-card').filter({ hasText: 'Build dashboard' }).first();
  const timeline = card.locator('details.activity-timeline');
  await expect(timeline).toContainText('Recent activity · 3');
  await timeline.locator('summary').click();
  await expect(timeline.locator('.activity-kind')).toHaveText(['Working', 'Permission requested', 'Error']);
  await expect(timeline.locator('time')).toHaveCount(3);
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
  const card = page.locator('.session-card').filter({ hasText: 'Fix API' }).first();
  const timeline = card.locator('details.activity-timeline');
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
  await expect(page.getByText('Build dashboard', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.notificationCalls.length)).toBe(0);
  await page.locator('#notifications').check();
  await expect.poll(() => page.evaluate(() => window.notificationCalls.length)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.notificationCalls.length)).toBe(1);
  await expect(page.evaluate(() => window.permissionRequests || 0)).resolves.toBe(0);
  await page.locator('#tab-count').check();
  await expect(page).toHaveTitle('(2) OpenCode Supervisor');
  await page.locator('#tab-count').uncheck();
  await expect(page).toHaveTitle('OpenCode Supervisor');
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
  await page.locator('#notifications').check();
  await expect.poll(() => page.evaluate(() => window.notificationCalls.length)).toBe(0);
});
