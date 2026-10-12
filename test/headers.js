// Catches a response whose Content-Length does not match its body. A length
// larger than the body leaves the client waiting on a socket that never
// closes, which looks exactly like a hung request and is easy to misread as a
// bug somewhere else.
//
// Run it against a live server: node test/headers.js

const http = require('http');

const BASE = process.env.BASE || 'http://127.0.0.1:11707';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const url = new URL(urlPath, BASE);
    const all = { ...headers, Connection: 'close' };
    if (body) all['Content-Length'] = Buffer.byteLength(body);
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    const started = Date.now();
    const timer = setTimeout(() => {
      agent.destroy();
      resolve({ status: 0, headers: {}, body: '', ms: Date.now() - started, timedOut: true });
    }, 8000);
    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: all, agent },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          agent.destroy();
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            ms: Date.now() - started,
          });
        });
      }
    );
    req.on('error', (e) => {
      clearTimeout(timer);
      agent.destroy();
      resolve({ status: 0, headers: {}, body: '', ms: Date.now() - started, error: e.message });
    });
    if (body) req.write(body);
    req.end();
  });
}

function lengthMatches(res) {
  const declared = res.headers['content-length'];
  if (declared === undefined) return null;
  return Number(declared) === Buffer.byteLength(res.body, 'utf8');
}

(async () => {
  const password = 'correct horse battery';

  const stamp = String(Date.now()).slice(-6);
  const login = `hdr${stamp}`;
  const reg = await request('POST', '/register', {
    body: new URLSearchParams({ login, password }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const jar = reg.headers['set-cookie'][0].split(';')[0];
  check('register returns a complete response', lengthMatches(reg) === true && !reg.timedOut, `status ${reg.status}`);

  const page = await request('GET', '/new', { headers: { Cookie: jar } });
  const csrf = (page.body.match(/name="csrf" value="([^"]+)"/) || [])[1];
  const created = await request('POST', '/new', {
    body: new URLSearchParams({ name: 'headers', csrf }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar },
  });
  check('creating a repository returns a complete response', lengthMatches(created) === true && !created.timedOut, `status ${created.status}`);

  // Every one of these must answer rather than hang, and must not claim more
  // bytes than it sends.
  const cases = [
    ['dashboard', () => request('GET', '/', { headers: { Cookie: jar } })],
    ['repository page', () => request('GET', `/${login}/headers`, { headers: { Cookie: jar } })],
    ['404 page', () => request('GET', '/no/such/repo/at/all/deep')],
    ['malformed path', () => request('GET', '/%ZZ')],
    ['unknown static file', () => request('GET', '/static/nope.css')],
    ['health check', () => request('GET', '/healthz')],
    ['unknown route', () => request('GET', '/some/deep/unknown/route')],
    ['method not allowed on login', () => request('DELETE', '/login')],
    ['settings without a CSRF token', () => request('POST', `/${login}/headers/settings`, {
      body: new URLSearchParams({ description: 'x' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar },
    })],
    ['settings as a stranger', () => request('POST', `/${login}/headers/settings`, {
      body: new URLSearchParams({ description: 'x' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })],
    ['dumb git protocol', () => request('GET', `/${login}/headers.git/info/refs`)],
    ['git-upload-pack by GET', () => request('GET', `/${login}/headers.git/git-upload-pack`)],
    ['git-receive-pack by GET', () => request('GET', `/${login}/headers.git/git-receive-pack`)],
    ['sign in with a wrong password', () => request('POST', '/login', {
      body: new URLSearchParams({ login, password: 'wrong' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })],
    ['sign up with a taken name', () => request('POST', '/register', {
      body: new URLSearchParams({ login, password }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })],
    ['sign up with a bad name', () => request('POST', '/register', {
      body: new URLSearchParams({ login: 'not a valid name', password }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })],
    ['create a repository with a bad name', () => request('POST', '/new', {
      body: new URLSearchParams({ name: 'bad name', csrf }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar },
    })],
    ['create a repository that already exists', () => request('POST', '/new', {
      body: new URLSearchParams({ name: 'headers', csrf }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar },
    })],
  ];

  for (const [name, call] of cases) {
    const res = await call();
    const timedOut = !!res.timedOut;
    const mismatched = lengthMatches(res) === false;
    check(
      `answers completely: ${name}`,
      !timedOut && !mismatched,
      timedOut
        ? 'hung, no response'
        : mismatched
          ? `declared ${res.headers['content-length']}, sent ${Buffer.byteLength(res.body, 'utf8')}`
          : `status ${res.status}`
    );
  }

  // Rate limiting has to answer too, which is the path that was hanging.
  let limited = null;
  for (let i = 0; i < 30 && !limited; i++) {
    const res = await request('POST', '/login', {
      body: new URLSearchParams({ login: `ghost${stamp}`, password: `guess${i}` }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (res.status === 429) limited = res;
  }
  check(
    'the rate limit response arrives complete',
    !!limited && !limited.timedOut && lengthMatches(limited) === true,
    limited ? `status 429 after ${limited.ms}ms` : 'never rate limited'
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
})();
