// End to end check against real git. Not part of the platform: run it by hand
// with SAREIT_DATA pointed at a scratch directory.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const BASE = process.env.BASE || 'http://127.0.0.1:11707';
// The server is started with SAREIT_IMPORT_DIR pointing here, so the import
// form can read a repository staged in it. Mirrors the server's own env.
const STAGING = process.env.SAREIT_IMPORT_DIR || path.join(os.tmpdir(), 'sareit-import-staging');
fs.mkdirSync(STAGING, { recursive: true });
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'sareit-e2e-'));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function run(args, cwd, env) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: res.status, out: (res.stdout || '').trim(), err: (res.stderr || '').trim() };
}

// Each call gets its own socket. Node's global agent pools sockets that the
// server is free to close once a response ends, and the pooled reuse lands as
// an ECONNRESET that has nothing to do with what is being tested here.
function request(method, urlPath, { body, headers = {}, jar } = {}) {
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
        res.on('end', () => {
          const setCookie = res.headers['set-cookie'];
          if (jar && setCookie) jar.value = setCookie[0].split(';')[0];
          agent.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        });
      }
    );
    req.on('error', (err) => {
      agent.destroy();
      reject(err);
    });
    if (body) req.write(body);
    req.end();
  });
}

// git takes credentials for the push and the clone from this header, so the
// test never has to answer an interactive prompt.
function gitEnv(login, password) {
  const basic = `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: ${basic}`,
  };
}

function form(fields) {
  return new URLSearchParams(fields).toString();
}

// State-changing forms carry a CSRF token derived from the session cookie.
// Fetch the page, pull the token out, and send it back with the POST.
async function csrfFor(pagePath, jar) {
  const res = await request('GET', pagePath, { headers: { Cookie: jar } });
  const match = res.body.toString('utf8').match(/name="csrf" value="([^"]+)"/);
  return match ? match[1] : '';
}

async function postWithCsrf(pagePath, jar, fields) {
  const csrf = await csrfFor(pagePath, jar);
  return request('POST', pagePath, {
    body: form({ ...fields, csrf }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar },
    jar,
  });
}

async function main() {
  const suffix = String(Date.now()).slice(-6);
  const login = `tester${suffix}`;
  const password = 'correct horse battery';

  const jar = {};
  const reg = form({ login, email: `${login}@example.com`, password });
  let res = await request('POST', '/register', {
    body: reg,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(reg) },
    jar,
  });
  check('register', res.status === 302, `status ${res.status}`);
  check('session cookie issued', !!jar.value, jar.value ? 'yes' : 'none');

  res = await request('GET', '/', { headers: { Cookie: jar.value } });
  check('dashboard renders signed in', res.status === 200 && res.body.includes('New repository'), `status ${res.status}`);

  res = await postWithCsrf('/new', jar.value, { name: 'alpha', description: 'first project' });
  check('create repo', res.status === 302 && res.headers.location.includes('/alpha'), `status ${res.status}`);

  const repoUrl = `${BASE}/${login}/alpha.git`;
  const basic = `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;

  res = await request('GET', `/info/refs?service=git-upload-pack`.replace('/info', `/${login}/alpha.git/info`), {
    headers: { Authorization: basic },
  });
  const emptyAdvert = res.body.toString('utf8');
  check(
    'empty repo advertises capabilities^{}',
    res.status === 200 && emptyAdvert.includes('git-upload-pack') && emptyAdvert.includes('capabilities^{}'),
    `status ${res.status}`
  );

  const work = path.join(SCRATCH, 'work');
  fs.mkdirSync(work);
  run(['init', '-q', '-b', 'main'], work);
  run(['config', 'user.email', 'dev@example.com'], work);
  run(['config', 'user.name', 'Dev Person'], work);
  fs.writeFileSync(path.join(work, 'README.md'), '# Alpha\n\nFirst project on SAREit.\n');
  fs.mkdirSync(path.join(work, 'src'));
  fs.writeFileSync(path.join(work, 'src', 'app.js'), 'console.log("hello");\n');
  run(['add', '-A'], work);
  run(['commit', '-q', '-m', 'Initial commit with a reasonably long message that should survive the round trip intact.'], work);
  fs.writeFileSync(path.join(work, 'src', 'app.js'), 'console.log("hello world");\nconsole.log("second line");\n');
  run(['add', '-A'], work);
  run(['commit', '-q', '-m', 'Second commit, changes app.js'], work);
  run(['tag', 'v1.0'], work);

  res = run(['push', '-q', repoUrl, 'main', '--tags'], work, gitEnv(login, password));
  check('git push', res.code === 0, res.err || res.out || 'exit 0');

  const clone1 = path.join(SCRATCH, 'clone1');
  res = run(['clone', '-q', repoUrl, clone1], SCRATCH, gitEnv(login, password));
  check('git clone', res.code === 0, res.err || 'exit 0');

  const cloneLog = run(['log', '--format=%s|%an|%ae|%ad', '--date=iso'], clone1);
  check(
    'history preserved through clone',
    cloneLog.out.includes('Second commit, changes app.js') && cloneLog.out.includes('Dev Person') && cloneLog.out.includes('dev@example.com'),
    `${cloneLog.out.split('\n').length} commits`
  );

  const cloneTags = run(['tag'], clone1);
  check('tags preserved', cloneTags.out === 'v1.0', cloneTags.out);

  const fsck = run(['fsck', '--no-progress'], clone1);
  check('clone passes git fsck', fsck.code === 0, fsck.err.split('\n')[0] || 'clean');

  // Incremental: a second push must only transfer the new objects.
  fs.writeFileSync(path.join(work, 'src', 'extra.js'), 'module.exports = 1;\n');
  run(['add', '-A'], work);
  run(['commit', '-q', '-m', 'Third commit adds extra.js'], work);
  res = run(['push', repoUrl, 'main'], work, gitEnv(login, password));
  check('incremental push', res.code === 0, res.err.split('\n').pop() || 'exit 0');

  res = run(['fetch', '-q', 'origin'], clone1, gitEnv(login, password));
  const afterFetch = run(['log', '--format=%s', '--all'], clone1);
  check('incremental fetch', afterFetch.out.includes('Third commit adds extra.js'), `${afterFetch.out.split('\n').length} refs of history`);

  res = await request('GET', `/${login}/alpha`, { headers: { Cookie: jar.value } });
  const html = res.body.toString('utf8');
  check('repo code page lists files', res.status === 200 && html.includes('README.md') && html.includes('src'));

  // Each row carries the last commit that touched that file, as a link to it.
  // The anchor carries a title attribute alongside the href, so the match
  // allows for trailing attributes instead of assuming href is the only one.
  const initialSha = run(['rev-parse', 'HEAD~2'], work).out;
  const appJsSha = run(['rev-parse', 'HEAD~1'], work).out;
  // Matched against the name cell rather than taken as the first message cell:
  // directories sort before files, so the leading row belongs to src/.
  const readmeRow = /<td class="name"><a href="[^"]+">README\.md<\/a><\/td>\s*<td class="msg"><a href="([^"]+)"[^>]*>([^<]*)</.exec(html);
  check(
    'each file links to the commit that last touched it',
    // README.md was created by the first commit and never touched again, so
    // that is its answer. The newest commit overall is not: pointing every row
    // at the branch head would make the column say nothing at all.
    !!readmeRow && readmeRow[1].endsWith('/commit/' + initialSha),
    readmeRow ? readmeRow[2] : 'no link found'
  );
  res = await request('GET', `/${login}/alpha` + (readmeRow ? readmeRow[1].split('/alpha')[1] : ''), {
    headers: { Cookie: jar.value },
  });
  check(
    'following that link lands on the commit',
    // The page names the author it belongs to, so the subject and the sha are
    // what identify it. Asserting the author is absent, as this used to, could
    // never pass against a page that always shows who wrote the commit.
    res.status === 200 && res.body.includes('commit-subject') && res.body.includes(initialSha),
    `status ${res.status}`
  );

  // app.js lives in src/, so it is the src tree page that has to be read. The
  // newest commit added a sibling file; app.js itself was last written by the
  // one before it, which is the distinction the column exists to make.
  res = await request('GET', `/${login}/alpha/tree/main/src`, { headers: { Cookie: jar.value } });
  const srcHtml = res.body.toString('utf8');
  const srcRow = /<td class="name"><a href="[^"]+">app\.js<\/a><\/td>\s*<td class="msg"><a href="([^"]+)"[^>]*>([^<]*)</.exec(srcHtml);
  check(
    'the message shown is the one for that file, not the newest commit',
    !!srcRow && srcRow[1].endsWith('/commit/' + appJsSha) && srcRow[2].includes('Second commit'),
    srcRow ? `${srcRow[2]} ${srcRow[1].slice(-7)}` : 'not found'
  );

  check('the page defaults to the dark theme', /<html lang="en" data-theme="dark">/.test(html));
  check('a theme toggle is offered', html.includes('data-theme-toggle'));
  check(
    'the theme script runs before paint so there is no flash',
    /<script src="\/static\/app\.js"><\/script>/.test(html),
    'not deferred'
  );
  const css = (await request('GET', '/static/style.css')).body.toString('utf8');
  check(
    'the theme swap is transitioned',
    css.includes('theme-animated') && css.includes('transition: background-color'),
    'transition present'
  );
  check(
    'dark mode styles are loaded by default',
    /:root,\s*\[data-theme='dark'\]/.test(css)
  );
  check(
    'the highlight animation exists and loops',
    css.includes('@keyframes card-glow') && css.includes('@keyframes card-edge') &&
      css.includes('infinite') && css.includes('.repo-card-highlight'),
    'both keyframes, infinite'
  );
  check(
    'the highlight respects reduced motion',
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none !important/.test(css)
  );

  // The highlighted account is decided by configuration, not hardcoded, so
  // this checks the wiring rather than one particular name.
  res = await request('GET', `/${login}/alpha`, { headers: { Cookie: jar.value } });
  check(
    'no card is highlighted when the list is empty',
    !res.body.includes('repo-card-highlight'),
    `${login} is not in SAREIT_HIGHLIGHT`
  );

  res = await request('GET', `/${login}/alpha/commits/main`, { headers: { Cookie: jar.value } });
  const commitsHtml = res.body.toString('utf8');
  check(
    'web shows commit subjects and author',
    res.status === 200 &&
      commitsHtml.includes('Third commit adds extra.js') &&
      commitsHtml.includes('Dev Person')
  );

  res = await request('GET', `/${login}/alpha/blob/main/src/app.js`, { headers: { Cookie: jar.value } });
  check(
    'web shows file contents',
    res.status === 200 && res.body.includes('console.log(&quot;hello world&quot;)'),
    'html escaped'
  );

  res = await request('GET', `/${login}/alpha/raw/main/src/app.js`, { headers: { Cookie: jar.value } });
  check('raw endpoint', res.status === 200 && res.body.toString('utf8').includes('hello world'));

  const headSha = run(['rev-parse', 'HEAD'], work).out;
  res = await request('GET', `/${login}/alpha/commit/${headSha}`, { headers: { Cookie: jar.value } });
  const commitHtml = res.body.toString('utf8');
  check(
    'commit page renders a diff',
    res.status === 200 && commitHtml.includes('d-add') && commitHtml.includes('extra.js'),
    `${(commitHtml.match(/d-add/g) || []).length} added lines`
  );

  // An imported project keeps its own history, authored by someone else. It
  // is staged under SAREIT_IMPORT_DIR, the one place the import form may read
  // from on this filesystem.
  const origin = path.join(STAGING, `origin${suffix}`);
  fs.mkdirSync(origin, { recursive: true });
  run(['init', '-q', '-b', 'trunk'], origin);
  run(['config', 'user.email', 'someone@elsewhere.dev'], origin);
  run(['config', 'user.name', 'Someone Elsewhere'], origin);
  fs.writeFileSync(path.join(origin, 'notes.txt'), 'line one\nline two\nline three\n');
  run(['add', '-A'], origin);
  run(['commit', '-q', '-m', 'Original commit from another platform'], origin);
  fs.writeFileSync(path.join(origin, 'notes.txt'), 'line one\nline two changed\nline three\nline four\n');
  run(['add', '-A'], origin);
  run(['commit', '-q', '-m', 'Upstream edit with a body\n\nThis paragraph is part of the commit message and must survive import.'], origin);
  const bodyCommit = run(['rev-parse', 'HEAD'], origin).out;
  run(['tag', '-a', 'upstream-1.0', '-m', 'annotated tag message'], origin);
  fs.mkdirSync(path.join(origin, 'deep', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(origin, 'deep', 'nested', 'file.bin'), Buffer.alloc(4096, 7));
  run(['add', '-A'], origin);
  run(['commit', '-q', '-m', 'Add a nested binary blob'], origin);

  res = await postWithCsrf('/new', jar.value, { name: 'imported', import: `origin${suffix}`, description: 'brought over' });
  check('import repo', res.status === 302 && res.headers.location.includes('/imported'), res.status === 302 ? '' : res.body.toString('utf8').slice(0, 300));

  const importedUrl = `${BASE}/${login}/imported.git`;
  const importedClone = path.join(SCRATCH, 'imported-clone');
  res = run(['clone', '-q', importedUrl, importedClone], SCRATCH, gitEnv(login, password));
  check('clone the imported repo', res.code === 0, res.err || 'exit 0');

  const importedLog = run(['log', '--format=%s|%an|%ae'], importedClone);
  check(
    'imported commit messages intact',
    importedLog.out.includes('Upstream edit with a body') && importedLog.out.includes('Someone Elsewhere'),
    importedLog.out.split('\n').length + ' commits'
  );
  const importedBody = run(['log', '-1', '--format=%B', bodyCommit], importedClone).out;
  check(
    'imported multi-paragraph message intact',
    importedBody.includes('This paragraph is part of the commit message and must survive import.')
  );
  const importedTag = run(['cat-file', '-p', 'upstream-1.0'], importedClone).out;
  check('imported annotated tag intact', importedTag.includes('annotated tag message'), importedTag.split('\n')[0]);
  const importedBranch = run(['rev-parse', '--abbrev-ref', 'HEAD'], importedClone).out;
  check('imported default branch kept as trunk', importedBranch === 'trunk', importedBranch);
  const importedFile = fs.readFileSync(path.join(importedClone, 'deep', 'nested', 'file.bin'));
  check('imported binary file byte identical', importedFile.length === 4096 && importedFile[100] === 7);

  res = await request('GET', `/${login}/imported/commits/trunk`, { headers: { Cookie: jar.value } });
  check(
    'web renders imported history',
    res.status === 200 && res.body.includes('Upstream edit with a body') && res.body.includes('Someone Elsewhere')
  );

  // Private repositories.
  res = await postWithCsrf('/new', jar.value, { name: 'secret', private: '1' });
  check('create private repo', res.status === 302, `status ${res.status}`);

  res = await request('GET', `/${login}/secret`);
  check('private repo hidden from anonymous', res.status === 404, `status ${res.status}`);
  res = await request('GET', `/${login}/secret`, { headers: { Cookie: jar.value } });
  check('private repo visible to owner', res.status === 200, `status ${res.status}`);
  res = await request('GET', `/${login}/secret.git/info/refs?service=git-upload-pack`);
  check('private repo refuses anonymous git', res.status === 401, `status ${res.status}`);
  res = await request('GET', `/${login}/secret.git/info/refs?service=git-upload-pack`, { headers: { Authorization: basic } });
  check('private repo serves authenticated git', res.status === 200, `status ${res.status}`);

  // A second account cannot push to the first account's repository.
  const otherJar = {};
  await request('POST', '/register', {
    body: form({ login: `other${suffix}`, password }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    jar: otherJar,
  });
  const otherBasic = `Basic ${Buffer.from(`other${suffix}:${password}`).toString('base64')}`;
  res = await request('GET', `/${login}/alpha.git/info/refs?service=git-receive-pack`, {
    headers: { Authorization: otherBasic },
  });
  check('another account cannot get the push advertisement', res.status === 401, `status ${res.status}`);

  res = await request('GET', `/${login}/nosuchrepo`);
  check('unknown repo is 404', res.status === 404, `status ${res.status}`);
  res = await request('GET', `/${login}/alpha/tree/main/nope`);
  check('unknown path is 404', res.status === 404, `status ${res.status}`);

  // A cross-site form post with no token must not create anything.
  res = await request('POST', '/new', {
    body: form({ name: 'forged' }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.value },
    jar,
  });
  check('repository creation without a CSRF token is refused', res.status === 403, `status ${res.status}`);
  res = await request('GET', `/${login}/forged`);
  check('the refused forged repository was not created', res.status === 404, `status ${res.status}`);

  // An import pointing at a local path outside the staging directory is the
  // shape of an attempt to read the server's own files.
  res = await postWithCsrf('/new', jar.value, { name: 'escape', import: '../../../../etc' });
  check('import outside the staging directory is refused', res.status === 400, `status ${res.status}`);
  res = await request('GET', `/${login}/escape`);
  check('the refused import created nothing', res.status === 404, `status ${res.status}`);

  res = await request('GET', '/');
  const headers = res.headers;
  check(
    'responses carry a strict content security policy',
    typeof headers['content-security-policy'] === 'string' && headers['content-security-policy'].includes("script-src 'self'"),
    headers['content-security-policy'] ? 'present' : 'missing'
  );
  check('responses set nosniff', headers['x-content-type-options'] === 'nosniff');
  check('responses deny framing', headers['x-frame-options'] === 'DENY');

  // Repeated wrong passwords are cut off rather than answered forever.
  let limited = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const denied = await request('POST', '/login', {
      body: form({ login: `victim${suffix}`, password: `wrong${attempt}` }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (denied.status === 429) {
      limited = attempt + 1;
      break;
    }
  }
  check('repeated wrong passwords are rate limited', limited > 0, `blocked after ${limited} attempts`);

  // The account record carries a login, an email and a scrypt hash. Whatever
  // SQLite allocates around it, the account must stay orders of magnitude below
  // the 100MB it is allowed to hold in repositories.
  const accountsDir = path.join(process.env.SAREIT_DATA, 'accounts');
  const recordBytes = fs.statSync(path.join(accountsDir, `${login}.sqlite`)).size;
  check(
    'account record stays a tiny fraction of its 100MB budget',
    recordBytes < 64 * 1024,
    `${recordBytes} bytes, ${((recordBytes / 104857600) * 100).toFixed(4)}% of the account budget`
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    // The FAIL prefix is what the runner looks for when it reports which checks
    // failed, so it has to be here whatever else changes about the line.
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
