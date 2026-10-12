// A repository whose objects are all inside a packfile, which is the shape a
// real `git clone --bare` or `git gc` produces. The object reader has to parse
// the pack index and resolve deltas out of the pack, not just read loose files.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const BASE = process.env.BASE || 'http://127.0.0.1:11707';
const STAGING = process.env.SAREIT_IMPORT_DIR || path.join(os.tmpdir(), 'sareit-import-staging');
fs.mkdirSync(STAGING, { recursive: true });
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'sareit-pack-'));
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

// The import runs as a job the server owns, so the POST returns while the clone
// is still going. This waits for it, which the pack reading below needs.
async function awaitImport(res, jar) {
  const page = res.headers.location;
  for (let poll = 0; poll < 1200; poll++) {
    const answer = await request('GET', `${page}/status`, { headers: { Cookie: jar } });
    if (answer.status !== 200) throw new Error(`import status unavailable: ${answer.status}`);
    const status = JSON.parse(answer.body.toString('utf8'));
    if (status.state !== 'running') {
      if (status.state !== 'done') throw new Error(`import ended as ${status.state}: ${status.error || status.phase}`);
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('import did not finish within the poll budget');
}

async function main() {
  const login = 'pack' + String(Date.now()).slice(-6);
  const password = 'correct horse battery';
  let res = await request('POST', '/register', {
    body: new URLSearchParams({ login, password }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const jar = (res.headers['set-cookie'][0] || '').split(';')[0];
  check('register', res.status === 302, `status ${res.status}`);

  // Build a repo with many commits and repeated content so the pack that git
  // writes has plenty of ofs-delta and ref-delta objects in it.
  // The packed repository is staged under SAREIT_IMPORT_DIR, the only place
  // the import form is allowed to read from.
  const origin = path.join(STAGING, `packed${login}`);
  fs.mkdirSync(origin, { recursive: true });
  run(['init', '-q', '-b', 'main'], origin);
  run(['config', 'user.email', 'pack@example.com'], origin);
  run(['config', 'user.name', 'Pack Person'], origin);

  let seed = 99;
  const randomLine = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return `line ${seed} with some repeated filler text to make deltas pay off`;
  };

  const lines = Array.from({ length: 200 }, randomLine);
  for (let commit = 1; commit <= 12; commit++) {
    lines.splice(commit * 7, 3, randomLine(), randomLine(), randomLine());
    fs.writeFileSync(path.join(origin, 'data.txt'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(origin, `file${commit % 3}.txt`), Array.from({ length: 40 }, randomLine).join('\n'));
    run(['add', '-A'], origin);
    run(['commit', '-q', '-m', `Packed commit ${commit} of 12`], origin);
  }
  const expected = Number(run(['rev-list', '--count', 'HEAD'], origin).out);
  run(['tag', '-a', 'v2.0', '-m', 'annotated tag on a packed repo'], origin);

  // This is the step that turns loose objects into a packfile.
  run(['gc', '-q', '--aggressive', '--prune=now'], origin);
  const packDir = path.join(origin, '.git', 'objects', 'pack');
  const packs = fs.readdirSync(packDir).filter((f) => f.endsWith('.pack'));
  check('origin has a packfile after gc', packs.length > 0, packs.join(', '));

  const looseLeft = fs
    .readdirSync(path.join(origin, '.git', 'objects'))
    .filter((d) => /^[0-9a-f]{2}$/.test(d)).length;
  check('origin has few or no loose objects left', looseLeft <= 2, `${looseLeft} fanout directories`);

  res = await postWithCsrf('/new', jar, { name: 'packed', import: `packed${login}` });
  check('import the packed repository', res.status === 302, `status ${res.status}`);
  await awaitImport(res, jar);

  const url = `${BASE}/${login}/packed.git`;
  const cloneDir = path.join(SCRATCH, 'clone');
  const clone = run(['clone', url, cloneDir], SCRATCH, gitEnv(login, password));
  check('clone the packed repository', clone.code === 0, clone.err.split('\n').slice(-1)[0] || 'exit 0');

  const cloned = Number(run(['rev-list', '--count', 'HEAD'], cloneDir).out);
  check('every commit survived', cloned === expected, `${cloned} of ${expected}`);

  const fsck = run(['fsck', '--no-progress'], cloneDir);
  check('packed clone passes git fsck', fsck.code === 0, fsck.err.split('\n')[0] || 'clean');

  const tag = run(['cat-file', '-p', 'v2.0'], cloneDir).out;
  check('annotated tag on a packed repo intact', tag.includes('annotated tag on a packed repo'));

  const contents = run(['show', 'HEAD:data.txt'], cloneDir).out;
  const originalContents = run(['show', 'HEAD:data.txt'], origin).out;
  check('packed blob content matches byte for byte', contents === originalContents, `${contents.length} chars`);

  res = await request('GET', `/${login}/packed/commits/main`, { headers: { Cookie: jar } });
  check(
    'web renders a packed repository history',
    res.status === 200 && res.body.includes('Packed commit 12 of 12') && res.body.includes('Pack Person'),
    `status ${res.status}`
  );

  // Push on top of a packed repository, so the delta chain spans a pack the
  // server wrote and objects the server wrote loose.
  fs.appendFileSync(path.join(cloneDir, 'data.txt'), 'one more line\n');
  run(['add', '-A'], cloneDir);
  run(['commit', '-q', '-m', 'Commit on top of the packed history'], cloneDir);
  const push = run(['push', url, 'main'], cloneDir, gitEnv(login, password));
  check('push on top of a packed repository', push.code === 0, push.err.split('\n').slice(-1)[0] || 'exit 0');

  const recheck = path.join(SCRATCH, 'recheck');
  const reclone = run(['clone', url, recheck], SCRATCH, gitEnv(login, password));
  check('reclone after the push', reclone.code === 0, reclone.err.split('\n').slice(-1)[0] || 'exit 0');
  const finalCount = Number(run(['rev-list', '--count', 'HEAD'], recheck).out);
  check('history intact after push and reclone', finalCount === expected + 1, `${finalCount} of ${expected + 1}`);

  const failed = results.filter((r) => !r.ok);
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
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
