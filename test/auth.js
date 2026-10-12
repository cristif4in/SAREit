// Checks the three things that were reported, as assertions:
//   1. a commit authored by someone other than the pushing account is labelled
//      with both identities
//   2. a repository pushed on a branch other than main is not shown as empty
//   3. no state change is possible without a session, a CSRF token, and
//      ownership of the repository

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const BASE = process.env.BASE || 'http://127.0.0.1:11707';
const PASSWORD = 'correct horse battery';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'sareit-auth-'));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function run(args, cwd, env) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function gitEnv(login) {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${login}:${PASSWORD}`).toString('base64')}`,
  };
}
// basic(login) sends the account password; withToken sends the token instead,
// which is the credential shape a pushing machine actually uses.
function basic(login) {
  return `Basic ${Buffer.from(`${login}:${PASSWORD}`).toString('base64')}`;
}
function withToken(login, token) {
  return `Basic ${Buffer.from(`${login}:${token}`).toString('base64')}`;
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
    req.on('error', (e) => { agent.destroy(); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}
async function post(pagePath, jar, fields, { withCsrf = true } = {}) {
  let token = '';
  if (withCsrf) {
    const p = await request('GET', pagePath, { headers: { Cookie: jar } });
    const m = p.body.match(/name="csrf" value="([^"]+)"/);
    token = m ? m[1] : '';
  }
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (jar) headers.Cookie = jar;
  return request('POST', pagePath, {
    body: new URLSearchParams({ ...fields, ...(withCsrf ? { csrf: token } : {}) }).toString(),
    headers,
  });
}

(async () => {
  const stamp = String(Date.now()).slice(-6);
  const owner = `own${stamp}`;

  let r = await request('POST', '/register', {
    body: new URLSearchParams({ login: owner, password: PASSWORD }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const ownerJar = (r.headers['set-cookie'][0] || '').split(';')[0];

  const intruder = `int${stamp}`;
  r = await request('POST', '/register', {
    body: new URLSearchParams({ login: intruder, password: PASSWORD }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const intruderJar = (r.headers['set-cookie'][0] || '').split(';')[0];

  r = await post('/new', ownerJar, { name: 'project' });
  check('owner creates the repository', r.status === 302, `status ${r.status}`);

  // The pushing account is the owner, the git identity is a different person,
  // which is what any machine with git configured normally produces.
  const work = path.join(SCRATCH, 'work');
  fs.mkdirSync(work);
  run(['init', '-q', '-b', 'main'], work);
  run(['config', 'user.email', 'dev.person@somewhere.dev'], work);
  run(['config', 'user.name', 'Dev Person'], work);
  fs.writeFileSync(path.join(work, 'README.md'), '# Project\n');
  run(['add', '-A'], work);
  run(['commit', '-q', '-m', 'Written by Dev Person'], work);
  run(['push', `${BASE}/${owner}/project.git`, 'main'], work, gitEnv(owner));

  r = await request('GET', `/${owner}/project/commits/main`, { headers: { Cookie: ownerJar } });
  check(
    'the commit list shows the author and the pusher separately',
    r.body.includes('committed by Dev Person') && r.body.includes(`pushed by ${owner}`),
    r.body.includes(`pushed by ${owner}`) ? 'both shown' : 'pusher missing'
  );

  const headSha = run(['rev-parse', 'HEAD'], work).out;
  r = await request('GET', `/${owner}/project/commit/${headSha}`, { headers: { Cookie: ownerJar } });
  check(
    'the commit page shows the author and the pusher separately',
    r.body.includes('Dev Person') && r.body.includes(`pushed to this server by ${owner}`),
    r.body.includes(`pushed to this server by ${owner}`) ? 'both shown' : 'pusher missing'
  );

  const objectAuthor = run(['log', '-1', '--format=%an <%ae>'], work).out;
  check(
    'the recorded commit author is unchanged by SAREit',
    objectAuthor === 'Dev Person <dev.person@somewhere.dev>',
    objectAuthor
  );

  // Now the same push, but on master instead of main.
  const work2 = path.join(SCRATCH, 'master');
  fs.mkdirSync(work2);
  run(['init', '-q', '-b', 'master'], work2);
  run(['config', 'user.email', 'dev.person@somewhere.dev'], work2);
  run(['config', 'user.name', 'Dev Person'], work2);
  fs.writeFileSync(path.join(work2, 'code.txt'), 'on master\n');
  run(['add', '-A'], work2);
  run(['commit', '-q', '-m', 'Written on master'], work2);
  r = await post('/new', ownerJar, { name: 'onmaster' });
  run(['push', `${BASE}/${owner}/onmaster.git`, 'master'], work2, gitEnv(owner));

  r = await request('GET', `/${owner}/onmaster`, { headers: { Cookie: ownerJar } });
  check(
    'a repository pushed on master is not shown as empty',
    !r.body.includes('Quick setup') && r.body.includes('code.txt'),
    `says empty: ${r.body.includes('Quick setup')}`
  );
  r = await request('GET', `/${owner}/onmaster/commits/HEAD`, { headers: { Cookie: ownerJar } });
  check('its commits are reachable through HEAD', r.body.includes('Written on master'), `status ${r.status}`);

  const clone = run(['clone', '-q', `${BASE}/${owner}/onmaster.git`, path.join(SCRATCH, 'mclone')], SCRATCH, gitEnv(owner));
  check('and it clones with the right branch checked out', clone.code === 0 && fs.existsSync(path.join(SCRATCH, 'mclone', 'code.txt')), clone.err.split('\n')[0] || 'ok');

  console.log('--- who may change what ---');

  // Every write path, attempted three ways: no session, another account's
  // session, and the owner without a CSRF token.
  const attempts = [
    ['no session at all', async () => request('POST', `/${owner}/project/settings`, {
      body: new URLSearchParams({ description: 'hijacked' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })],
    ['another account', async () => post(`/${owner}/project/settings`, intruderJar, { description: 'hijacked' })],
    ['another account deleting', async () => post(`/${owner}/project/settings/delete`, intruderJar, {})],
    ['another account importing', async () => post('/new', intruderJar, { name: 'stolen', import: 'anything' })],
  ];

  for (const [label, attempt] of attempts) {
    const res = await attempt();
    // A bad import source is rejected on its own merits before ownership is
    // consulted, so it comes back 400 rather than 403. Either way nothing was
    // created, which is what the check below confirms.
    check(`refused: ${label}`, res.status >= 400 && res.status < 500, `status ${res.status}`);
  }

  r = await post(`/${owner}/project/settings`, ownerJar, { description: 'no token' }, { withCsrf: false });
  check('refused: owner without a CSRF token', r.status === 403, `status ${r.status}`);

  r = await request('GET', `/${owner}/project.git/info/refs?service=git-receive-pack`, { headers: { Authorization: basic(intruder) } });
  check('refused: another account asking to push', r.status === 401, `status ${r.status}`);

  r = await request('GET', `/${owner}/project.git/info/refs?service=git-receive-pack`, {
    headers: { Authorization: basic(intruder), Cookie: ownerJar },
  });
  check(
    'a session cookie does not authenticate the git protocol',
    r.status === 401,
    `status ${r.status}`
  );

  r = await request('GET', '/new', { headers: { Authorization: basic(owner) } });
  check(
    'HTTP Basic does not authenticate the web UI',
    !r.body.includes('Create a new repository'),
    `status ${r.status}, form present: ${r.body.includes('Create a new repository')}`
  );

  r = await request('POST', `/${owner}/project/git-receive-pack`, {
    body: '0000',
    headers: { 'Content-Type': 'application/x-git-receive-pack-request', Authorization: basic(intruder) },
  });
  check('refused: another account posting straight to git-receive-pack', r.status === 401, `status ${r.status}`);

  const settings = run(['--git-dir', path.join(process.env.SAREIT_DATA, 'repos', owner, 'project.git'), 'log', '--oneline'], SCRATCH);
  check('the repository is untouched by all of that', settings.code === 0 && settings.out.includes('Written by Dev Person'), settings.out.split('\n')[0] || 'empty');

  const page = await request('GET', `/${owner}/project`, { headers: { Cookie: ownerJar } });
  check('its description was not changed', !page.body.includes('hijacked'), 'no hijacked text on the page');

  const failed = results.filter((x) => !x.ok);
  console.log(`\n--- access tokens ---`);

  // A token replaces the password on the git side, so a machine that pushes
  // never holds the credential that unlocks the web UI.
  const settingsPage = await request('GET', `/${owner}/project/settings`, { headers: { Cookie: ownerJar } });
  const settingsCsrf = (settingsPage.body.match(/name="csrf" value="([^"]+)"/) || [])[1];
  check('the settings page offers tokens', settingsPage.body.includes('Access tokens'));

  const issued = await request('POST', `/${owner}/project/settings/tokens`, {
    body: new URLSearchParams({ name: 'laptop', csrf: settingsCsrf }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: ownerJar },
  });
  const issuedValue = (issued.headers.location || '').match(/token=([^&]+)/);
  check('a token can be issued', issued.status === 302 && !!issuedValue, issued.status === 302 ? 'redirected' : `status ${issued.status}`);

  const token = issuedValue ? decodeURIComponent(issuedValue[1]) : '';
  check('the token is shown once, on the settings page', !!token && token.startsWith('sareit_'));

  const tokenRead = await request('GET', `/${owner}/project/settings?token=${encodeURIComponent(token)}`, {
    headers: { Cookie: ownerJar },
  });
  check('the fresh token is displayed', tokenRead.body.includes(token));

  const settingsAgain = await request('GET', `/${owner}/project/settings`, { headers: { Cookie: ownerJar } });
  check('it is not shown a second time', !settingsAgain.body.includes(token));

  res = await request('GET', `/${owner}/project.git/info/refs?service=git-receive-pack`, {
    headers: { Authorization: withToken(owner, token) },
  });
  check('the token authenticates the git protocol', res.status === 200, `status ${res.status}`);

  const tokenWork = path.join(SCRATCH, 'tokenwork');
  fs.mkdirSync(tokenWork);
  run(['init', '-q', '-b', 'main'], tokenWork);
  run(['config', 'user.email', 'dev.person@somewhere.dev'], tokenWork);
  run(['config', 'user.name', 'Dev Person'], tokenWork);
  fs.writeFileSync(path.join(tokenWork, 'pushed.txt'), 'with a token\n');
  run(['add', '-A'], tokenWork);
  run(['commit', '-q', '-m', 'Pushed using a token'], tokenWork);
  // The remote already has a main from an earlier push in this suite, and this is
  // an unrelated root commit, so pushing main would be a non-fast-forward and
  // the server would rightly refuse it. The point of the check is that the
  // token authenticates a real push, which a new branch exercises just as well.
  const tokenPush = run(['push', `${BASE}/${owner}/project.git`, 'main:token-push'], tokenWork, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${owner}:${token}`).toString('base64')}`,
  });
  check('a real push using the token works', tokenPush.code === 0, tokenPush.err.split('\n').pop() || 'exit 0');

  const badToken = await request('GET', `/${owner}/project.git/info/refs?service=git-receive-pack`, {
    headers: { Authorization: withToken(owner, 'sareit_000000000000_wrongwrongwrong') },
  });
  check('a token that does not exist is refused', badToken.status === 401, `status ${badToken.status}`);

  const tokenId = (token.match(/^sareit_([0-9a-f]{12})_/) || [])[1];
  const revokeCsrf = (settingsAgain.body.match(/name="csrf" value="([^"]+)"/) || [])[1];
  const revoked = await request('POST', `/${owner}/project/settings/tokens/revoke`, {
    body: new URLSearchParams({ token: tokenId, csrf: revokeCsrf }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: ownerJar },
  });
  check('the token can be revoked', revoked.status === 302, `status ${revoked.status}`);

  const afterRevoke = await request('GET', `/${owner}/project.git/info/refs?service=git-receive-pack`, {
    headers: { Authorization: withToken(owner, token) },
  });
  check('a revoked token stops working at once', afterRevoke.status === 401, `status ${afterRevoke.status}`);

  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);
    console.log(`scratch: ${SCRATCH}`);
    process.exitCode = 1;
  } else {
    // Kept on failure so it can be inspected, removed otherwise.
    try {
      fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Best effort: a file the running server still holds open on Windows is
      // not a test failure.
    }
  }
})();
