// The repository card highlight, which applies to the accounts named in
// SAREIT_HIGHLIGHT. Starts its own instance with that variable set, since the
// list is configuration rather than something hardcoded in the view.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 11713);
const HIGHLIGHTED = ['cristi'];
const PASSWORD = 'correct horse battery';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://127.0.0.1:${PORT}`);
    const all = { ...headers, Connection: 'close' };
    if (body) all['Content-Length'] = Buffer.byteLength(body);
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: all, agent },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => { agent.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }); });
      }
    );
    req.on('error', (e) => { agent.destroy(); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

async function register(login) {
  const res = await request('POST', '/register', {
    body: new URLSearchParams({ login, password: PASSWORD }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const jar = (res.headers['set-cookie'][0] || '').split(';')[0];
  const page = await request('GET', '/new', { headers: { Cookie: jar } });
  const csrf = (page.body.match(/name="csrf" value="([^"]+)"/) || [])[1];
  for (const name of ['alpha', 'beta']) {
    await request('POST', '/new', {
      body: new URLSearchParams({ name, csrf }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar },
    });
  }
  return jar;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sareit-hl-'));
  const server = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: { ...process.env, SAREIT_DATA: dataDir, SAREIT_PORT: String(PORT), SAREIT_HIGHLIGHT: HIGHLIGHTED.join(',') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));

  if (!(await waitFor(PORT))) {
    console.error(`server did not start:\n${out}`);
    server.kill();
    process.exit(1);
  }

  await register('cristi');
  await register('someoneelse');

  const dash = await request('GET', '/');
  const body = dash.body;

  const cards = [...body.matchAll(/<li class="(repo-card[^"]*)"[^>]*>\s*<div class="repo-card-head">\s*<a class="repo-card-name" href="\/([^/"]+)/g)];
  const byOwner = new Map();
  for (const [, cls, owner] of cards) {
    byOwner.set(owner, { cls, count: (byOwner.get(owner)?.count || 0) + 1 });
  }

  check('every repository appears as a card', cards.length === 4, `${cards.length} cards`);
  check(
    'the highlighted account gets the highlight class',
    byOwner.has('cristi') && byOwner.get('cristi').cls.includes('repo-card-highlight'),
    byOwner.get('cristi') ? byOwner.get('cristi').cls : 'no cards'
  );
  check(
    'all of that account\'s cards are highlighted',
    byOwner.get('cristi')?.count === 2,
    `${byOwner.get('cristi')?.count} of 2`
  );
  check(
    'an account not in the list is left alone',
    byOwner.has('someoneelse') && !byOwner.get('someoneelse').cls.includes('repo-card-highlight'),
    byOwner.get('someoneelse') ? byOwner.get('someoneelse').cls : 'no cards'
  );

  const profile = await request('GET', '/cristi');
  check('the profile page highlights the same account', profile.body.includes('repo-card repo-card-highlight'));

  const css = (await request('GET', '/static/style.css')).body;
  check(
    'the glow sweeps and loops',
    /@keyframes card-glow \{/.test(css) && /animation: card-glow [^;]*infinite/.test(css),
    'keyframe plus an infinite animation'
  );
  check(
    'the glow travels left to right',
    css.includes('background-position: 190% 0') && css.includes('background-position: -90% 0'),
    'starts right, ends left'
  );
  check(
    'a second pass runs along the top edge',
    /@keyframes card-edge[\s\S]*translateX\(-110%\)[\s\S]*translateX\(240%\)/.test(css),
    'off the left edge, off the right edge'
  );
  check(
    'the glow colour is defined for both themes',
    css.includes('--glow: 248, 81, 73') && css.includes('--glow: 207, 34, 46'),
    'dark and light'
  );
  check(
    'the card content sits above the glow',
    /\.repo-card-highlight > \*[\s\S]*z-index: 1/.test(css),
    'text stays readable'
  );
  check(
    'the card clips the glow',
    /\.repo-card-highlight \{[\s\S]*overflow: hidden/.test(css),
    'overflow hidden'
  );
  check(
    'the animation does not eat clicks',
    /\.repo-card-highlight::before \{[\s\S]*pointer-events: none/.test(css),
    'pointer-events none'
  );

  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Windows holds a lock briefly after exit; the directory is uniquely named.
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

function waitFor(port) {
  const deadline = Date.now() + 20000;
  return new Promise((resolve) => {
    const attempt = () => {
      const r = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1000 }, (res) => { res.resume(); resolve(true); });
      r.on('error', () => (Date.now() > deadline ? resolve(false) : setTimeout(attempt, 250)));
      r.on('timeout', () => r.destroy());
    };
    attempt();
  });
}

main();
