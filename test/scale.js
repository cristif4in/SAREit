// Measures how request latency grows with the number of accounts. It starts
// its own instance on a scratch data directory, because creating hundreds of
// accounts is exactly what the registration rate limit is there to stop.
//
//   node test/scale.js [accounts] [port]

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[3] || 11708);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'correct horse battery';

function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const all = { ...headers, Connection: 'close' };
    if (body) all['Content-Length'] = Buffer.byteLength(body);
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    const started = process.hrtime.bigint();
    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: all, agent },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          agent.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), ms });
        });
      }
    );
    req.on('error', (e) => { agent.destroy(); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const run = process.argv[2] || '30';
  const total = Number(run);
  const prefix = `scale${String(Date.now()).slice(-5)}`;
  const created = [];

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sareit-scale-'));
  const server = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: { ...process.env, SAREIT_DATA: dataDir, SAREIT_PORT: String(PORT), SAREIT_SIGNUP_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOut = '';
  server.stdout.on('data', (d) => (serverOut += d));
  server.stderr.on('data', (d) => (serverOut += d));

  const ready = await waitForServer();
  if (!ready) {
    console.error(`server did not start:\n${serverOut}`);
    server.kill();
    process.exit(1);
  }
  console.log(`instance on port ${PORT}, data ${dataDir}\n`);

  const t0 = Date.now();

  async function postWithCsrf(pagePath, jar, fields) {
    const page = await request('GET', pagePath, { headers: { Cookie: jar } });
    const match = page.body.toString('utf8').match(/name="csrf" value="([^"]+)"/);
    return request('POST', pagePath, {
      body: new URLSearchParams({ ...fields, csrf: match ? match[1] : '' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar },
    });
  }

  for (let i = 0; i < total; i++) {
    const login = `${prefix}${i}`;
    let res = await request('POST', '/register', {
      body: new URLSearchParams({ login, email: `${login}@example.com`, password: PASSWORD }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const jar = (res.headers['set-cookie'] || [''])[0].split(';')[0];
    for (let r = 0; r < 3; r++) {
      await postWithCsrf('/new', jar, { name: `repo${r}` });
    }
    created.push({ login, jar });
  }
  console.log(`created ${total} accounts with 3 repositories each in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  async function sample(label, fn, runs = 12) {
    const times = [];
    for (let i = 0; i < runs; i++) times.push((await fn()).ms);
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    console.log(`${label.padEnd(34)} median ${median.toFixed(1)}ms   max ${times[times.length - 1].toFixed(1)}ms`);
    return median;
  }

  const last = created[created.length - 1];
  await sample(`dashboard, ${total} accounts`, () => request('GET', '/', { headers: { Cookie: last.jar } }));
  await sample(`search, ${total} accounts`, () => request('GET', '/?q=repo1', { headers: { Cookie: last.jar } }));
  await sample('profile page', () => request('GET', `/${last.login}`, { headers: { Cookie: last.jar } }));
  await sample('repository code page', () => request('GET', `/${last.login}/repo0`, { headers: { Cookie: last.jar } }));
  await sample('empty commits page', () => request('GET', `/${last.login}/repo0/commits/main`, { headers: { Cookie: last.jar } }));
  await sample('git ls-remote', () => request('GET', `/${last.login}/repo0.git/info/refs?service=git-upload-pack`, {
    headers: { Authorization: `Basic ${Buffer.from(`${last.login}:${PASSWORD}`).toString('base64')}` },
  }));

  console.log('\nconcurrent readers');
  const concurrent = 24;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: concurrent }, (_, i) =>
      request('GET', `/${created[i % created.length].login}/repo${i % 3}`, {
        headers: { Cookie: created[i % created.length].jar },
      })
    )
  );
  const elapsed = Date.now() - started;
  console.log(`${concurrent} parallel page loads         ${elapsed}ms total, ${Math.round(elapsed / concurrent)}ms each`);

  const gitStarted = Date.now();
  await Promise.all(
    Array.from({ length: 12 }, () =>
      request('GET', `/${created[0].login}/repo0.git/info/refs?service=git-upload-pack`, {
        headers: { Authorization: `Basic ${Buffer.from(`${created[0].login}:${PASSWORD}`).toString('base64')}` },
      })
    )
  );
  const gitElapsed = Date.now() - gitStarted;
  console.log(`12 parallel git requests          ${gitElapsed}ms total, ${Math.round(gitElapsed / 12)}ms each`);

  server.kill();
  await new Promise((r) => server.on('exit', r));
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log('\ninstance stopped, scratch data removed');
}

function waitForServer() {
  const deadline = Date.now() + 20000;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/healthz', timeout: 1000 }, (res) => {
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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
