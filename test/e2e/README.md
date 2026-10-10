# Browser E2E tests

The Playwright suite runs Chromium against the real dashboard and serves deterministic API fixtures in the browser. It does not need a running OpenCode process, a companion token, or external network services.

The recommended host-independent setup is the Docker workflow documented in the root [README](../../README.md#run-all-ci-checks-in-docker). It installs dependencies and runs unit, syntax, and browser checks inside the container.

For direct host execution from the repository root:

```sh
npm ci
npx playwright install chromium
npm run test:e2e
```

On a fresh Linux machine, Playwright may also need its OS libraries; install them with `npx playwright install --with-deps chromium`. The suite starts `npm start` on `127.0.0.1:4317` automatically. Set `CI=1` in CI to disable reuse of an already-running server.

Fixtures are defined in `dashboard.spec.js` and intercept `/api/state` at the browser boundary. The local-mode scenario returns a token-free state response. The network-mode scenario returns HTTP 401 until the test submits its fixed test token, then returns a network-mode response. The update scenario changes the fixture on a later poll to check that an expanded Git section stays open during refreshes. No production fixture endpoint or browser-test runtime dependency is added.
