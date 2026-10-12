// Measures where the CPU goes: time and processor time to start, then the
// cost of each kind of request. Starts its own instance.
//
//   node test/usage.js [accounts]

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 11714);
const ACCOUNTS = Number(process.argv[2] || 20);
const PASSWORD = 'correct horse battery';

function cpuSeconds(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[11]) + Number(fields[12]);
    return ticks / 100;
  } catch {
    return null;
  }
}

function rssMb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /VmRSS:\s+(\d+) kB/.exec(status);
    return match ? Number(match[1]) / 1024 : null;
  } catch {
    return null;
  }
}

function idleSeconds() {
  try {
    return Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  } catch {
    return null;
  }
}

function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://127.0.0.1:${PORT}`);
    const all = { ...headers, Connection: 'close' };
    if (body) all['Content-Length'] = Buffer.byteLength(body);
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    const started = process.hrtime.bigint();
    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: all, agent },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => {
          agent.destroy();
          resolve({
            status: res.statusCode,
            body: Buffer.concat(c).toString('utf8'),
            ms: Number(process.hrtime.bigint() - started) / 1e6,
          });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function git(args, cwd) {
  return new Promise((resolve) => {
    const c = spawn('git', args, { cwd, stdio: 'ignore' });
    c.on('close', resolve);
  });
}

async function waitFor(port) {
  const deadline = Date.now() + 30000;
  return new Promise((resolve) => {
    const attempt = () => {
      const r = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1000 }, (res) => { res.resume(); resolve(true); });
      r.on('error', () => (Date.now() > deadline ? resolve(false) : setTimeout(attempt, 200)));
      r.on('timeout', () => r.destroy());
    };
    attempt();
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sareit-usage-'));

  // Populate the data directory before starting, so startup cost is measured
  // against a realistic number of accounts rather than an empty one.
  const seeder = spawn(process.execPath, ['-e', `
    process.env.SAREIT_DATA = ${JSON.stringify(dataDir)};
    const accounts = require(${JSON.stringify(path.join(ROOT, 'src', 'accounts.js'))});
    const repo = require(${JSON.stringify(path.join(ROOT, 'src', 'git', 'repo.js'))});
    const fs = require('fs');
    const path = require('path');
    for (let i = 0; i < ${ACCOUNTS}; i++) {
      const login = 'acct' + i;
      accounts.createUser({ login, email: login + '@example.com', salt: 'ab'.repeat(16), passwordHash: 'cd'.repeat(64) });
      for (let r = 0; r < 3; r++) {
        const name = 'repo' + r;
        accounts.createRepo(login, { name, description: 'repository ' + r, isPrivate: false });
        const dir = path.join(${JSON.stringify(dataDir)}, 'repos', login, name + '.git');
        fs.mkdirSync(dir, { recursive: true });
        repo.init(dir);
      }
    }
  `], { cwd: ROOT, stdio: 'inherit' });
  await new Promise((r) => seeder.on('close', r));
  console.log(`seeded ${ACCOUNTS} accounts with 3 repositories each\n`);

  const before = { cpu: cpuSeconds(process.pid), idle: idleSeconds() };

  const started = Date.now();
  const server = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: { ...process.env, SAREIT_DATA: dataDir, SAREIT_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));

  if (!(await waitFor(PORT))) {
    console.error(`server did not start:\n${log}`);
    server.kill();
    process.exit(1);
  }
  const wallMs = Date.now() - started;
  const startCpu = cpuSeconds(server.pid);
  const rss = rssMb(server.pid);

  console.log(`startup            ${wallMs}ms wall, ${startCpu === null ? 'n/a' : startCpu.toFixed(2) + 's'} cpu, ${rss === null ? 'n/a' : rss.toFixed(0) + 'MB'} rss`);

  // Let it settle, then measure what a quiet process costs on its own. A busy
  // loop would show up here as cpu climbing while nothing is requested.
  await new Promise((r) => setTimeout(r, 2000));
  const settledCpu = cpuSeconds(server.pid);
  await new Promise((r) => setTimeout(r, 2000));
  const laterCpu = cpuSeconds(server.pid);
  const idleCpu = settledCpu !== null && laterCpu !== null ? laterCpu - settledCpu : null;
  console.log(`idle for 2s        ${idleCpu === null ? 'n/a' : idleCpu.toFixed(3) + 's cpu'}${idleCpu !== null && idleCpu > 0.2 ? '   <-- SPINNING' : ''}`);

  async function sample(label, fn, runs) {
    const cpuA = cpuSeconds(server.pid);
    const t0 = Date.now();
    const times = [];
    for (let i = 0; i < runs; i++) times.push((await fn()).ms);
    const wall = Date.now() - t0;
    const cpuB = cpuSeconds(server.pid);
    times.sort((a, b) => a - b);
    const perCall = cpuA !== null && cpuB !== null ? (cpuB - cpuA) / runs : null;
    console.log(
      `${label.padEnd(22)} median ${times[Math.floor(times.length / 2)].toFixed(1).padStart(7)}ms` +
        (perCall !== null ? `   ${(perCall * 1000).toFixed(0).padStart(5)}ms cpu/call` : '')
    );
  }

  console.log('');
  await sample('dashboard', () => request('GET', '/'), 10);
  await sample('search', () => request('GET', '/?q=repo1'), 10);
  await sample('profile page', () => request('GET', '/acct0'), 10);
  await sample('repo code page', () => request('GET', '/acct0/repo0'), 10);
  await sample('empty commits', () => request('GET', '/acct0/repo0/commits/main'), 10);
  await sample('healthz', () => request('GET', '/healthz'), 10);
  const basic = 'Basic ' + Buffer.from(`acct0:${PASSWORD}`).toString('base64');
  await sample('git ls-remote', () => request('GET', `/acct0/repo0.git/info/refs?service=git-upload-pack`, { headers: { Authorization: basic } }), 10);

  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Windows holds a lock briefly after exit.
  }
  void before;
}

main();
