import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise dashboard startup against responses from both companion modes.
// Minimal DOM stand-ins keep this test runnable without a browser/socket.
async function dashboard(t, mode) {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  class Element {
    constructor() { this.children = []; this.value = ''; this.hidden = false; this.handlers = {}; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    addEventListener(name, fn) { this.handlers[name] = fn; }
  }
  const nodes = new Map([...html.matchAll(/<[^>]+id="([^"]+)"[^>]*>/g)].map(([tag, id]) => {
    const node = new Element(); node.hidden = /\bhidden\b/.test(tag); return [id, node];
  }));
  const originals = new Map(['document', 'Option', 'fetch', 'setInterval'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
  t.after(() => { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  globalThis.document = { getElementById: id => nodes.get(id), createElement: () => new Element(), querySelectorAll: () => [] };
  globalThis.Option = Element;
  globalThis.setInterval = () => 0;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push(init);
    if (mode === 'network' && !init.headers.authorization) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify({ mode, instances: [] }));
  };
  await import(`../public/app.js?auth-test=${mode}`);
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, requests };
}

test('local dashboard connects automatically without asking for a secret', async t => {
  const { nodes, requests } = await dashboard(t, 'local');
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(nodes.get('login').hidden, true);
  assert.equal(nodes.get('dashboard').hidden, false);
  assert.equal(nodes.get('logout').hidden, true);
  assert.match(nodes.get('connection').textContent, /local only/);
});

test('network dashboard asks for a token and connects after submission', async t => {
  const { nodes, requests } = await dashboard(t, 'network');
  assert.equal(nodes.get('login').hidden, false);
  assert.equal(nodes.get('dashboard').hidden, true);
  nodes.get('token').value = 'example-network-token-for-test';
  nodes.get('login').handlers.submit({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.at(-1).headers.authorization, 'Bearer example-network-token-for-test');
  assert.equal(nodes.get('login').hidden, true);
  assert.equal(nodes.get('dashboard').hidden, false);
  assert.equal(nodes.get('logout').hidden, false);
});
