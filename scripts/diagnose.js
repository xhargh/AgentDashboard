// Read-only diagnostics: never print credentials, prompts, titles, or paths.
const pid = Number(process.argv[2]);
if (!Number.isInteger(pid) || pid <= 0) {
  console.error('Usage: npm run diagnose -- <opencode-pid>');
  process.exitCode = 1;
} else {
  const token = process.env.AGENTDASHBOARD_TOKEN;
  const port = process.env.AGENTDASHBOARD_PORT || 4317;
  const url = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(url + '/api/state', {
      headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Companion returned HTTP ${response.status}`);
    const data = await response.json();
    const assets = await Promise.all(['/', '/app.js'].map(async path => {
      const r = await fetch(url + path, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`Dashboard asset returned HTTP ${r.status}`);
      return r.text();
    }));
    console.log(JSON.stringify({
      servedDashboard: { hasHideFinishedCheckbox: assets[0].includes('id="hide-finished"'),
        hasHideFinishedFilter: assets[1].includes("$('hide-finished').checked") },
      instances: data.instances.filter(i => i.pid === pid).map(i => ({ pid: i.pid, online: i.online,
        sessions: i.sessions.map((s, index) => ({ index, status: s.status, hasParent: !!s.parentID,
          wouldHideWithFilterEnabled: !!s.parentID && s.status === 'idle' })) })),
    }, null, 2));
  } catch (error) {
    console.error(`Diagnostic failed: ${error.message}`);
    process.exitCode = 1;
  }
}
