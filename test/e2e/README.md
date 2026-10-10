# Browser E2E tests

The Playwright suite runs Chromium against the real dashboard and serves deterministic API fixtures in the browser. It does not need a running OpenCode process, a companion token, or external network services.

From the repository root:

```sh
npm install
npx playwright install chromium
npm run test:e2e
```

On a fresh Linux machine, Playwright may also need its OS libraries; install them with `npx playwright install --with-deps chromium`. The suite starts `npm start` on `127.0.0.1:4317` automatically. Set `CI=1` in CI to disable reuse of an already-running server.

Fixtures are defined in `dashboard.spec.js` and intercept `/api/state` at the browser boundary. The local-mode scenario returns a token-free state response. The network-mode scenario returns HTTP 401 until the test submits its fixed test token, then returns a network-mode response. The update scenario changes the fixture on a later poll to check that an expanded Git section stays open during refreshes. No production fixture endpoint or browser-test runtime dependency is added.

## Dashboard performance regression scenario

`performance.spec.js` generates six instances with forty sessions each (240 keyed agent nodes) in a nested chain. The fixture changes visible text on every poll while preserving topology and lifecycle groups. The test asserts keyed node identity is retained and that updates produce no child insertion/removal, alongside filter value/caret, focus, expansion, and scroll stability. These work-count assertions avoid machine-dependent wall-clock limits.

For a reproducible local run, use `npm run test:e2e -- --grep "large nested fleet"`. To profile manually, run `npm start`, open Chromium DevTools Performance, reload the dashboard with the API replaced by the same synthetic fixture, record several polling intervals, and compare scripting/rendering work and DOM node counts before and after updates. Avoid interpreting one machine's elapsed time as a pass/fail threshold; use traces and repeatable work counts to investigate regressions.

Issue #4, the earlier dashboard performance issue, is closed; this suite tracks ongoing regression coverage for #21.
