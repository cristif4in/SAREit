// Boots a SAREit instance against a throwaway data directory, runs the suites
// against it, and shuts it down. Tests never touch the project's own ./data.
//
//   node test/run.js            every suite
//   node test/run.js e2e auth   just those

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

const SUITES = [
  ['headers', 'response bodies match their declared length, nothing hangs'],
  ['migrate', 'an account file from any earlier version still opens'],
  ['browserbugs', 'favicon, Origin handling, the masthead button in both themes'],
  ['e2e', 'push, clone, fetch, tags, imports, private repos, the web UI'],
  ['auth', 'who may change what, and who wrote a commit versus who pushed it'],
  ['packed', 'a gc-ed repository whose objects are all inside a packfile'],
  ['highlight', 'the card highlight for the accounts configured for it'],
  ['resilience', 'a damaged account file, an orphaned directory'],
  ['storage', 'a 60MB repository and both storage ceilings'],
];

async function main() {
  const requested = process.argv.slice(2);
  const chosen = requested.length
    ? SUITES.filter(([name]) => requested.includes(name))
    : SUITES;

  if (!chosen.length) {
    console.error(`no such suite. available: ${SUITES.map(([n]) => n).join(', ')}`);
    process.exit(1);
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sareit-test-'));
  const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sareit-import-'));

  // A recorded message on stderr is the signal that a test ran somewhere it
  // should not have.
  const realData = path.join(ROOT, 'data');
  const realDataBefore = snapshot(realData);

  console.log(`test data     ${dataDir}`);
  console.log(`test imports  ${importDir}`);
  console.log(`real data     ${realData} (must be untouched)\n`);

  const server = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: { ...process.env, SAREIT_DATA: dataDir, SAREIT_IMPORT_DIR: importDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  server.stdout.on('data', (d) => (serverOutput += d));
  server.stderr.on('data', (d) => (serverOutput += d));

  const stopped = await waitForServer();
  if (!stopped) {
    console.error(`the test server did not come up:\n${serverOutput}`);
    server.kill();
    process.exit(1);
  }

  let failures = 0;
  for (const [name, description] of chosen) {
    console.log(`${name}  ${description}`);
    const result = spawnSync(process.execPath, [path.join(__dirname, `${name}.js`)], {
      cwd: ROOT,
      env: { ...process.env, SAREIT_DATA: dataDir, SAREIT_IMPORT_DIR: importDir },
      encoding: 'utf8',
      timeout: 15 * 60 * 1000,
    });
    const out = `${result.stdout || ''}${result.stderr || ''}`;
    // Failures are counted from two independent places and the larger is taken,
    // because either one alone can be wrong:
    //
    //   - the FAIL lines in the output are ground truth, but only if the suite
    //     printed them, and suites indent them, so they are matched trimmed;
    //   - the suite's own tally is a summary line, and it goes stale the moment
    //     anything records a result after it is computed, which silently
    //     reports a green count beside real failures.
    //
    // A suite that exits non-zero counts as at least one failure regardless.
    const counts = out.match(/(\d+)\/(\d+) checks passed/);
    const summary = counts ? counts[0] : 'no summary';
    const tally = counts ? Number(counts[2]) - Number(counts[1]) : 0;
    const failedLines = out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('FAIL'));
    const crashed = result.status !== 0 && !tally && !failedLines.length;
    const failedCount = Math.max(tally, failedLines.length, crashed ? 1 : 0);
    if (failedCount) failures += failedCount;
    console.log(`  ${summary}${failedCount ? `, ${failedCount} failing` : ''}`);
    for (const line of failedLines) console.log(`    ${line}`);
    if (crashed) {
      console.log(`    exited with code ${result.status}`);
      console.log(out.split('\n').slice(-12).map((l) => `    ${l}`).join('\n'));
  }

  server.kill();
  await new Promise((r) => server.on('exit', r));

  const realDataAfter = snapshot(realData);
  const touched = JSON.stringify(realDataBefore) !== JSON.stringify(realDataAfter);
  console.log(`\n${failures === 0 && !touched ? 'all suites passed' : `${failures} failure(s)`}`);
  if (touched) {
    console.log(`FAIL the suites wrote to ${realData}, which is the live data directory`);
    failures++;
  } else {
    console.log(`live data directory untouched`);
  }

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(importDir, { recursive: true, force: true });
  process.exitCode = failures ? 1 : 0;
}

function snapshot(dir) {
  const out = [];
  const walk = (current, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}:${fs.statSync(full).size}`);
    }
  };
  walk(dir, '');
  return out.sort();
}

function waitForServer() {
  const http = require('http');
  const deadline = Date.now() + 20000;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port: 11707, path: '/healthz', timeout: 1000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 250);
      });
      req.on('timeout', () => req.destroy());
    };
    attempt();
  });
}

main();
