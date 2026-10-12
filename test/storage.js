// Storage budget and large-repository checks. Separate from e2e.js because the
// repo built here is tens of megabytes and the clone through HTTP is slow.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const BASE = process.env.BASE || 'http://127.0.0.1:11707';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'sareit-big-'));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function run(args, cwd, env) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function gitEnv(login, password) {
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`,
  };
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
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { agent.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
      }
    );
    req.on('error', (e) => { agent.destroy(); reject(e); });
    if (body) req.write(body);
    req.end();
  });
}

async function postWithCsrf(pagePath, jar, fields) {
  const page = await request('GET', pagePath, { headers: { Cookie: jar } });
  const match = page.body.toString('utf8').match(/name="csrf" value="([^"]+)"/);
  return request('POST', pagePath, {
    body: new URLSearchParams({ ...fields, csrf: match ? match[1] : '' }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar },
  });
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else total += fs.statSync(full).size;
    }
  }
  return total;
}

async function main() {
  const login = 'big' + String(Date.now()).slice(-6);
  const password = 'correct horse battery';
  let res = await request('POST', '/register', {
    body: new URLSearchParams({ login, password }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  check('register', res.status === 302, `status ${res.status}`);
  const jar = (res.headers['set-cookie'][0] || '').split(';')[0];

  res = await postWithCsrf('/new', jar, { name: 'bulk' });
  check('create repo', res.status === 302, `status ${res.status}`);

  // 60MB of incompressible content across several commits, so the repository
  // lands well past the 50MB mark that matters here while staying under the
  // 100MB ceiling.
  const work = path.join(SCRATCH, 'big');
  fs.mkdirSync(path.join(work, 'assets'), { recursive: true });
  run(['init', '-q', '-b', 'main'], work);
  run(['config', 'user.email', 'bulk@example.com'], work);
  run(['config', 'user.name', 'Bulk Loader'], work);

  const targetMB = 60;
  const writtenMB = 0;
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };

  for (let file = 0; file < 6; file++) {
    const buf = Buffer.alloc(10 * 1024 * 1024);
    for (let i = 0; i < buf.length; i += 4) buf.writeUInt32LE(random(), i);
    fs.writeFileSync(path.join(work, 'assets', `blob${file}.bin`), buf);
    run(['add', '-A'], work);
    run(['commit', '-q', '-m', `Add incompressible blob ${file} of 6`], work);
  }

  fs.writeFileSync(path.join(work, 'README.md'), `# Bulk\n\n${targetMB}MB of test data.\n`);
  run(['add', '-A'], work);
  run(['commit', '-q', '-m', 'Add README'], work);
  const commitCount = Number(run(['rev-list', '--count', 'HEAD'], work).out);
  void writtenMB;

  const url = `${BASE}/${login}/bulk.git`;
  const push = run(['push', url, 'main'], work, gitEnv(login, password));
  check('push 60MB repository', push.code === 0, push.err.split('\n').slice(-1)[0] || 'exit 0');

  const serverDir = path.join(process.env.SAREIT_DATA, 'repos', login, 'bulk.git');
  const stored = dirSize(serverDir);
  check(
    'repository stored past 50MB',
    stored > 50 * 1024 * 1024,
    `${(stored / 1048576).toFixed(1)}MB on disk, ${commitCount} commits`
  );
  check(
    'repository under the 100MB ceiling',
    stored < 100 * 1024 * 1024,
    `${(stored / 1048576).toFixed(1)}MB`
  );

  // Clone it back over HTTP and confirm every object made the round trip.
  const cloneDir = path.join(SCRATCH, 'clone');
  const clone = run(['clone', url, cloneDir], SCRATCH, gitEnv(login, password));
  check('clone 60MB over HTTP', clone.code === 0, clone.err.split('\n').slice(-1)[0] || 'exit 0');

  const clonedCount = Number(run(['rev-list', '--count', 'HEAD'], cloneDir).out);
  check('every commit survived the round trip', clonedCount === commitCount, `${clonedCount} of ${commitCount}`);

  const fsck = run(['fsck', '--no-progress'], cloneDir);
  check('large clone passes git fsck', fsck.code === 0, fsck.err.split('\n')[0] || 'clean');

  const originalSize = fs.statSync(path.join(work, 'assets', 'blob3.bin')).size;
  const clonedSize = fs.statSync(path.join(cloneDir, 'assets', 'blob3.bin')).size;
  check('large blob is byte complete', originalSize === clonedSize, `${clonedSize} bytes`);

  // The web UI must still render a repository this size.
  res = await request('GET', `/${login}/bulk`, { headers: { Cookie: jar } });
  check('web code page renders a 60MB repository', res.status === 200 && res.body.includes('README.md'), `status ${res.status}`);

  res = await request('GET', `/${login}/bulk/commits/main`, { headers: { Cookie: jar } });
  check(
    'web commit list renders a 60MB repository',
    res.status === 200 && res.body.includes('Add README'),
    `status ${res.status}`
  );

  // A push that would take the repository past the ceiling must be refused.
  fs.writeFileSync(path.join(work, 'assets', 'overflow.bin'), Buffer.alloc(60 * 1024 * 1024, 3));
  run(['add', '-A'], work);
  run(['commit', '-q', '-m', 'Overflow the repository ceiling'], work);
  const overflow = run(['push', url, 'main'], work, gitEnv(login, password));
  const rejected = overflow.code !== 0;
  check('push past the 100MB ceiling is rejected', rejected, rejected ? overflow.err.split('\n')[0] : 'push was accepted');

  const afterReject = dirSize(serverDir);
  check(
    'refused push left the repository under the ceiling',
    afterReject < 100 * 1024 * 1024,
    `${(afterReject / 1048576).toFixed(1)}MB after the rejected push`
  );

  const stillValid = run(['fsck', '--no-progress'], serverDir);
  check('repository still passes git fsck after a refused push', stillValid.code === 0, stillValid.err.split('\n')[0] || 'clean');

  // The per-repository ceiling is 100MB and the per-account ceiling is also
  // 100MB, so a second large repository on the same account has to be refused
  // even though neither of them is individually over the repository limit.
  res = await postWithCsrf('/new', jar, { name: 'bulk2' });
  check('create second repository', res.status === 302, `status ${res.status}`);

  const work2 = path.join(SCRATCH, 'big2');
  fs.mkdirSync(path.join(work2, 'assets'), { recursive: true });
  run(['init', '-q', '-b', 'main'], work2);
  run(['config', 'user.email', 'bulk@example.com'], work2);
  run(['config', 'user.name', 'Bulk Loader'], work2);
  for (let file = 0; file < 6; file++) {
    const buf = Buffer.alloc(10 * 1024 * 1024);
    for (let i = 0; i < buf.length; i += 4) buf.writeUInt32LE(random(), i);
    fs.writeFileSync(path.join(work2, 'assets', `blob${file}.bin`), buf);
    run(['add', '-A'], work2);
    run(['commit', '-q', '-m', `Second repo blob ${file}`], work2);
  }

  const secondUrl = `${BASE}/${login}/bulk2.git`;
  const secondPush = run(['push', secondUrl, 'main'], work2, gitEnv(login, password));
  check(
    'push refused once the account total passes 100MB',
    secondPush.code !== 0,
    secondPush.err.split('\n')[0] || 'push was accepted'
  );

  const secondDir = path.join(process.env.SAREIT_DATA, 'repos', login, 'bulk2.git');
  check(
    'account total stayed under 100MB',
    dirSize(serverDir) + dirSize(secondDir) < 100 * 1024 * 1024,
    `${((dirSize(serverDir) + dirSize(secondDir)) / 1048576).toFixed(1)}MB across both repositories`
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);
    console.log(`scratch: ${SCRATCH}`);
    process.exitCode = 1;
  } else {
    // Kept on failure so it can be inspected, removed otherwise. This suite
    // writes a few hundred megabytes, so leaving it behind on every green run
    // fills the disk over a handful of runs.
    try {
      fs.rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Best effort. A file the running server still holds open on Windows is
      // not a test failure.
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
