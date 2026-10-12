import { expect, test } from '@playwright/test';

const instanceCount = 6;
const sessionsPerInstance = 40;

function syntheticFleet(revision) {
  const now = Date.now();
  return {
    mode: 'local',
    serverTime: now,
    instances: Array.from({ length: instanceCount }, (_, instanceIndex) => {
      const instanceId = `perf-${instanceIndex}`;
      const sessions = Array.from({ length: sessionsPerInstance }, (_, sessionIndex) => ({
        id: `agent-${sessionIndex}`,
        ...(sessionIndex ? { parentID: `agent-${sessionIndex - 1}` } : {}),
        title: `Fleet ${instanceIndex} agent ${sessionIndex} revision ${revision}`,
        status: sessionIndex ? 'busy' : 'idle',
        directory: `/synthetic/fleet-${instanceIndex}`,
        activity: `State update ${revision}`,
        agent: sessionIndex ? 'worker' : 'coordinator',
        todos: [],
      }));
      return {
        instanceId,
        host: `host-${instanceIndex}`,
        directory: `/synthetic/fleet-${instanceIndex}`,
        pid: 1000 + instanceIndex,
        online: true,
        lastSeen: now,
        sessions,
      };
    }),
  };
}

test('large nested fleet reuses keyed DOM and preserves interaction state through frequent updates', async ({ page }) => {
  let revision = 0;
  await page.route('**/api/state', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(syntheticFleet(revision++)),
  }));
  await page.goto('/');
  const root = page.locator('[data-agent-key="perf-0:agent-0"]');
  await expect(root).toBeVisible();
  await root.locator(':scope > summary.agent-tree-summary').click();
  await root.locator(':scope > .subagent-group > summary').click();
  const expandedChild = page.locator('details[data-agent-key="perf-0:agent-1"]');
  await expandedChild.locator(':scope > summary.agent-tree-summary').click();

  await page.getByText('Filter agents', { exact: true }).click();
  const search = page.getByLabel('Search');
  await search.fill('State update');
  await search.focus();
  await search.evaluate(input => input.setSelectionRange(6, 12));
  await page.evaluate(() => {
    const fleet = document.querySelector('#fleet');
    window.perfNodes = [...fleet.querySelectorAll('.agent-tree[data-agent-key]')];
    window.perfMutationCounts = [];
    window.perfObserver = new MutationObserver(records => {
      window.perfMutationCounts.push(records.reduce((count, record) => count + record.addedNodes.length + record.removedNodes.length, 0));
    });
    window.perfObserver.observe(fleet, { childList: true, subtree: true });
    window.scrollTo(0, document.body.scrollHeight);
    window.perfScrollY = window.scrollY;
  });

  await expect(page.getByText('Fleet 0 agent 0 revision 1', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.perfNodes.every(node => node.isConnected && document.querySelector(`[data-agent-key="${node.dataset.agentKey}"]`) === node))).toBe(true);
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('State update');
  await expect.poll(() => search.evaluate(input => input.selectionStart === 6 && input.selectionEnd === 12)).toBe(true);
  await expect(root).toHaveAttribute('open', '');
  await expect(expandedChild).toHaveAttribute('open', '');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  const work = await page.evaluate(() => {
    window.perfObserver.disconnect();
    return { keyed: window.perfNodes.length, childListChanges: window.perfMutationCounts.reduce((sum, count) => sum + count, 0) };
  });
  expect(work.keyed).toBe(instanceCount * sessionsPerInstance);
  // Same topology and grouping should require text updates only, with no node insertion/removal.
  expect(work.childListChanges).toBe(0);
});
