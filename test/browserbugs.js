// Reproduces the three reported symptoms against a running server:
//   1. a form POST carrying Origin: null, which is what a browser sends from
//      some privacy and sandbox contexts
//   2. /favicon.ico, which a browser asks for on every page load
//   3. the masthead button being unreadable in light mode
//
//   node test/browserbugs.js

const http = require('http');

const BASE = process.env.BASE || 'http://127.0.0.1:11707';
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function request(method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
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
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  // Unique per run, so a second run against the same instance reports on the
  // Origin handling rather than on a name that is already taken.
  const stamp = String(Date.now()).slice(-6);

  // 1. Origin: null must not lock anyone out of their own site.
  let res = await request('POST', '/register', {
    body: new URLSearchParams({ login: `null${stamp}`, password: 'correct horse battery' }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
  });
  check('a form POST with Origin: null is accepted', res.status === 302, `status ${res.status}`);

  res = await request('POST', '/register', {
    body: new URLSearchParams({ login: `null${stamp}`, password: 'correct horse battery' }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'null' },
  });
  check(
    'and a repeat attempt is reported as taken, not refused',
    res.status === 409,
    `status ${res.status}`
  );

  // A real cross-origin post is still refused.
  res = await request('POST', '/register', {
    body: new URLSearchParams({ login: `x${stamp}`, password: 'correct horse battery' }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' },
  });
  check('a genuine cross-origin post is still refused', res.status === 403, `status ${res.status}`);

  res = await request('POST', '/register', {
    body: new URLSearchParams({ login: `y${stamp}`, password: 'correct horse battery' }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: new URL(BASE).origin },
  });
  check('a same-origin post is accepted', res.status === 302, `status ${res.status}`);

  // 2. The favicon a browser asks for on every page.
  res = await request('GET', '/favicon.ico');
  check(
    '/favicon.ico is answered',
    res.status === 200 && (res.headers['content-type'] || '').includes('image'),
    `status ${res.status}, ${res.headers['content-type']}`
  );

  res = await request('GET', '/not-a-login');
  check('a root path that cannot be an account is a plain 404', res.status === 404, `status ${res.status}`);

  const page = await request('GET', '/');
  check('the page links a favicon', page.body.includes('rel="icon"'));

  // 3. The masthead button has to be readable in both themes.
  const css = (await request('GET', '/static/style.css')).body;
  check(
    'the masthead ghost button is styled against the bar, not the page',
    /\.masthead \.btn-ghost \{[\s\S]*?background: transparent[\s\S]*?color: var\(--head-fg\)/.test(css),
    'transparent background, masthead text colour'
  );

  // The light theme's --subtle must not reach the masthead any more, which is
  // what produced a white box with white text on it.
  const lightSubtle = css.includes('--subtle: #f6f8fa;');
  check('the light theme still defines its own subtle surface', lightSubtle, 'near-white in light mode, as expected');
  check(
    'but the masthead button no longer uses it',
    !/\.masthead \.btn-ghost \{[^}]*var\(--subtle\)/.test(css),
    'no --subtle on the bar'
  );

  const dark = /:root,\s*\[data-theme='dark'\] \{[\s\S]*?--fg: #e6edf3/.test(css);
  const light = /\[data-theme='light'\] \{[\s\S]*?--fg: #1f2328/.test(css);
  check('dark is the default palette', dark, 'root and dark share a block');
  check('light is a separate palette', light);

  // TEMPORARY deliberate failures to prove the runner counts them.
  check('deliberate temporary failure A', false, 'on purpose');
  check('deliberate temporary failure B', false, 'on purpose');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
})();
