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
  await expect(page.getByText('Build dashboard', { exact: true })).toBeVisible();
  await expect(page.getByText('Finished review')).toBeVisible();
  await expect(page.getByText('Unknown-age review')).toBeVisible();

  await page.getByText('Filter agents').click();
  await page.getByLabel('Computer').selectOption('beta');
  await expect(page.getByText('Fix API', { exact: true })).toBeVisible();
  await expect(page.getByText('Build dashboard', { exact: true })).toHaveCount(0);

  await page.getByLabel('Computer').selectOption('');
  await page.getByLabel('Search').fill('Editing app.js');
  await expect(page.getByText('Build dashboard', { exact: true })).toBeVisible();
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

test('renders status-only instances with optional metadata omitted', async ({ page }) => {
  const now = Date.now();
  await installStateFixture(page, () => ({ mode: 'local', serverTime: now, instances: [{
    instanceId: 'status-only', machineId: 'machine', host: 'private-host', pid: 42, online: true, lastSeen: now,
    sessions: [{ id: 'session', status: 'busy' }],
  }] }));
  await page.goto('/');

  await expect(page.locator('#fleet article.instance').getByText('private-host', { exact: true })).toBeVisible();
  await expect(page.getByText('Monitored instance', { exact: true })).toBeVisible();
  await expect(page.getByText('Session', { exact: true })).toBeVisible();
  await expect(page.locator('#fleet .badge').getByText('busy', { exact: true })).toBeVisible();
});
