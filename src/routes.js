// Web routes. The git protocol lives in src/git/http.js; everything here
// renders HTML except the raw blob endpoint and the import job status.

const fs = require('fs');
const path = require('path');
const accounts = require('./accounts');
const catalog = require('./catalog');
const storage = require('./storage');
const auth = require('./auth');
const security = require('./security');
const imports = require('./imports');
const debug = require('./debug');
const log = require('./log');
const repo = require('./git/repo');
const objects = require('./git/objects');
const views = require('./views');
const pages = require('./repoPages');
const { PORT } = require('./config');

const COMMIT_PAGE_SIZE = 60;
const MAX_HISTORY = 400;

function html(res, status, markup) {
  const body = Buffer.from(markup, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Content-Length': 0 });
  res.end();
}

function plain(res, status, text) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function cloneUrl(req, record) {
  const host = req.headers.host || `localhost:${PORT}`;
  return `http://${host}/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.name)}.git`;
}

function flashFrom(query) {
  const text = query.get('msg');
  if (!text) return null;
  return { text, kind: query.get('kind') === 'error' ? 'error' : 'ok' };
}

function safeNext(value) {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function isOwner(record, viewer) {
  return !!viewer && viewer.login.toLowerCase() === record.owner.toLowerCase();
}

// A ref and a path share the URL and either can contain a slash. The longest
// prefix that resolves to a revision is taken as the ref.
function splitRefAndPath(dir, parts) {
  for (let take = parts.length; take >= 1; take--) {
    const candidate = parts.slice(0, take).join('/');
    const sha = repo.resolveRevision(dir, candidate);
    if (sha) return { rev: candidate, rest: parts.slice(take) };
  }
  return null;
}

function repoContext(req, record) {
  const dir = storage.repoDir(record.owner, record.name);
  const list = repo.branches(dir);
  const head = repo.defaultBranch(dir);
  return {
    dir,
    branches: list,
    defaultBranch: head ? head.slice('refs/heads/'.length) : list[0]?.name || 'main',
    tags: repo.tags(dir),
    sizeBytes: storage.displayRepoSize(record.owner, record.name),
    accountBytes: storage.displayAccountSize(record.owner),
    cloneUrl: cloneUrl(req, record),
  };
}


function headLabel(context) {
  return context.defaultBranch;
}

function loadRepoOr404(req, res, owner, name, viewer) {
  if (!storage.validLogin(owner) || !storage.validRepoName(name)) {
    html(res, 404, views.notFoundPage({ user: viewer, what: 'Repository not found.' }));
    return null;
  }
  const record = accounts.getRepo(owner, name);
  if (!record) {
    html(res, 404, views.notFoundPage({ user: viewer, what: 'Repository not found.' }));
    return null;
  }
  if (record.private && !isOwner(record, viewer)) {
    html(res, 404, views.notFoundPage({ user: viewer, what: 'Repository not found.' }));
    return null;
  }
  const dir = storage.repoDir(record.owner, record.name);
  if (!repo.exists(dir)) {
    html(res, 500, views.notFoundPage({ user: viewer, what: 'Repository directory is missing on disk.' }));
    return null;
  }
  return { record, dir };
}

async function handleWeb(req, res, segments, url) {
  const viewer = auth.userFromCookie(req);
  const query = url.searchParams;
  const head = segments[0] || '';

  if (!segments.length) return dashboard(res, viewer, query);
  if (head === 'login' && segments.length === 1) return authRoute(req, res, 'login');
  if (head === 'register' && segments.length === 1) return authRoute(req, res, 'register');
  if (head === 'logout' && segments.length === 1) return logout(req, res);
  if (head === 'new' && segments.length === 1) return newRepoRoute(req, res, viewer);
  if (head === '_debug' && segments.length === 2 && segments[1] === 'state') return debugStateRoute(req, res, viewer);
  if (head === 'new' && segments[1] === 'import' && (segments.length === 3 || segments[3] === 'status')) {
    return importJobRoute(req, res, viewer, segments);
  }
  if (head === 'healthz' && segments.length === 1) return healthRoute(res);

  const owner = segments[0];
  const rawName = (segments[1] || '').replace(/\.git$/i, '');
  if (!rawName) return profileRoute(req, res, owner, viewer, query);

  const loaded = loadRepoOr404(req, res, owner, rawName, viewer);
  if (!loaded) return undefined;
  const { record, dir } = loaded;

  if (rawName !== segments[1]) {
    return redirect(res, `/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.name)}`);
  }
  if (segments.length === 2) return codeRoute(req, res, record, dir, viewer, 'HEAD', []);

  const section = segments[2];
  if (section === 'settings') return settingsRoute(req, res, record, dir, viewer, segments);
  if (section === 'branches') return branchesRoute(req, res, record, dir, viewer);
  if (section === 'tags') return tagsRoute(req, res, record, dir, viewer);
  if (section === 'commit' && segments.length === 4) return commitRoute(req, res, record, dir, viewer, segments[3]);
  if (section === 'raw') return rawRoute(res, dir, segments.slice(3));

  const split = splitRefAndPath(dir, segments.slice(3));
  if (!split) {
    html(res, 404, views.notFoundPage({ user: viewer, what: 'That revision does not exist in this repository.' }));
    return undefined;
  }

  if (section === 'tree') return codeRoute(req, res, record, dir, viewer, split.rev, split.rest);
  if (section === 'blob') return blobRoute(req, res, record, dir, viewer, split.rev, split.rest);
  if (section === 'commits') return commitsRoute(req, res, record, dir, viewer, split.rev);

  html(res, 404, views.notFoundPage({ user: viewer }));
  return undefined;
}


function dashboard(res, viewer, query) {
  const search = query.get('q') || '';
  const repos = catalog.search(search, viewer);
  html(res, 200, views.dashboard({ user: viewer, repos, query: search, flash: flashFrom(query) }));
}

function profileRoute(req, res, owner, viewer, query) {

  if (!storage.validLogin(owner)) {
    plain(res, 404, 'Not found\n');
    return;
  }
  const profile = accounts.getUserPublic(owner);
  if (!profile) {
    html(res, 404, views.notFoundPage({ user: viewer, what: 'No such account.' }));
    return;
  }
  const owned = catalog.ownedBy(profile.login);
  const repos = owned.filter((record) => !record.private || isOwner({ owner: profile.login }, viewer));
  html(
    res,
    200,
    views.profilePage({
      profile,
      repos,
      accountBytes: storage.displayAccountSize(profile.login),
      isSelf: isOwner({ owner: profile.login }, viewer),
      user: viewer,
      flash: flashFrom(query),
    })
  );
}

function csrfField(req) {
  return security.csrfToken(auth.getSecret(), auth.sessionCookieValue(req));
}

function requireCsrf(req, res) {
  if (security.csrfOk(auth.getSecret(), auth.sessionCookieValue(req), req.form.csrf)) return true;
  security.audit('csrf rejected', { path: req.url });
  plain(res, 403, 'Form rejected: bad token\n');
  return false;
}

async function authRoute(req, res, mode) {
  if (req.method === 'GET') {
    const next = new URL(req.url, 'http://x').searchParams.get('next');
    html(res, 200, views.authPage({ mode, next: safeNext(next), csrf: csrfField(req) }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'GET, POST', 'Content-Length': 0 });
    res.end();
    return;
  }

  const address = security.clientAddress(req);
  const login = String(req.form.login || '').trim();
  const password = String(req.form.password || '');
  const email = String(req.form.email || '').trim();
  const next = safeNext(req.form.next);

  if (mode === 'register') {
    // SAREIT_SIGNUP_OPEN=0 closes registration, which is what an instance
    // wants once its accounts exist. Registration is open by default so a
    // fresh install is usable without editing anything.
    if (process.env.SAREIT_SIGNUP_OPEN === '0') {
      security.audit('sign up refused', { reason: 'registration is closed' });
      html(res, 403, views.authPage({ mode, error: 'Registration is closed on this server.', csrf: csrfField(req) }));
      return;
    }
    // Registration is open on a private instance, so it is the cheapest way to
    // burn scrypt on the server. Rate limit per address before doing any work.
    const gate = security.registrationLimits.hit(address);
    if (!gate.ok) return security.tooMany(res, gate.retryAfterMs);
    if (!storage.validLogin(login)) {
      html(res, 400, views.authPage({ mode, error: 'Usernames use letters, digits and dashes.', values: { login, email }, csrf: csrfField(req) }));
      return;
    }
    if (password.length < 8) {
      html(res, 400, views.authPage({ mode, error: 'Passwords need at least 8 characters.', values: { login, email }, csrf: csrfField(req) }));
      return;
    }
    if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      html(res, 400, views.authPage({ mode, error: 'That does not look like an email address.', values: { login, email }, csrf: csrfField(req) }));
      return;
    }
    if (accounts.accountExists(login)) {
      html(res, 409, views.authPage({ mode, error: 'That username is taken.', values: { login, email }, csrf: csrfField(req) }));
      return;
    }
    try {
      await auth.register({ login, email, password });
    } catch (err) {
      log.error('account create failed', { login, reason: err.message });
      html(res, 500, views.authPage({ mode, error: 'Could not write the account file. See the server log.', values: { login, email }, csrf: csrfField(req) }));
      return;
    }
    security.audit('account created', { login, from: address });
  } else {
    // Both buckets are checked before any hash is computed, so a blocked
    // attempt costs nothing.
    const byAddress = security.signInLimits.hit(address);
    if (!byAddress.ok) return security.challenge(res, 'Too many sign in attempts\n');
    if (login) {
      const byAccount = security.signInPerAccount.hit(login.toLowerCase());
      if (!byAccount.ok) return security.challenge(res, 'Too many sign in attempts\n');
    }
    const ok = await auth.checkCredentials(login, password);
    if (!ok) {
      security.audit('sign in failed', { login: login || '(none)', from: address });
      html(res, 401, views.authPage({ mode, error: 'Wrong username or password.', values: { login }, csrf: csrfField(req) }));
      return;
    }
    // A success clears the buckets so a user who fumbled a few times is not
    // left one mistake away from a lockout.
    security.signInLimits.reset(address);
    if (login) security.signInPerAccount.reset(login.toLowerCase());
  }

  res.setHeader('Set-Cookie', auth.sessionCookie(auth.signSession(login)));
  redirect(res, next);
}

function logout(req, res) {
  if (req.method === 'POST' && !requireCsrf(req, res)) return undefined;
  res.setHeader('Set-Cookie', auth.clearCookie());
  redirect(res, '/');
  return undefined;
}

function debugStateRoute(req, res, viewer) {
  // GET only. A read of the counters is not a state change, so nothing upstream
  // filters it on method, and routing on the method is what stops it being
  // posted to.
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET', 'Content-Length': 0 });
    res.end();
    return undefined;
  }
  if (!viewer) {
    plain(res, 404, 'Not found\n');
    return undefined;
  }
  json(res, 200, debug.snapshot());
  return undefined;
}

function healthRoute(res) {
  const usage = catalog.usage();
  const body = Buffer.from(
    JSON.stringify({
      ok: true,
      accounts: usage.accounts,
      catalogBytes: usage.bytes,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    }) + '\n',
    'utf8'
  );
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function newRepoRoute(req, res, viewer) {
  if (!viewer) return redirect(res, '/login?next=/new');
  if (req.method === 'GET') {
    html(res, 200, views.newRepoPage({ user: viewer, values: {}, csrf: csrfField(req) }));
    return;
  }
  if (!requireCsrf(req, res)) return undefined;

  const name = String(req.form.name || '').trim();
  const description = String(req.form.description || '').trim();
  const isPrivate = req.form.private === '1';
  const values = { name, description, private: isPrivate };
  const base = `/${encodeURIComponent(viewer.login)}`;
  const gate = security.writeLimits.hit(viewer.login.toLowerCase());
  if (!gate.ok) return security.tooMany(res, gate.retryAfterMs);

  if (!storage.validRepoName(name)) {
    html(res, 400, views.newRepoPage({ user: viewer, error: 'Names use letters, digits, dot, dash and underscore, up to 64 characters.', values, csrf: csrfField(req) }));
    return;
  }
  if (accounts.getRepo(viewer.login, name)) {
    html(res, 409, views.newRepoPage({ user: viewer, error: 'You already have a repository with that name.', values, csrf: csrfField(req) }));
    return;
  }

  const source = String(req.form.import || '').trim();
  if (source) {
    const gate = security.importLimits.hit(viewer.login.toLowerCase());
    if (!gate.ok) return security.tooMany(res, gate.retryAfterMs);

    const remote = imports.validSource(source);
    if (!remote) {
      security.audit('import refused', { login: viewer.login, reason: 'bad source' });
      html(res, 400, views.newRepoPage({
        user: viewer,
        error: 'That is not a usable git remote. Give an https, http, ssh or git URL.',
        values: { name, description, private: isPrivate, import: source },
        csrf: csrfField(req),
      }));
      return undefined;
    }

    const job = imports.start({ owner: viewer.login, name, description, isPrivate, source: remote, typed: source });
    redirect(res, `/new/import/${job.id}`);
    return undefined;
  }

  try {
    const record = storage.createRepository(viewer.login, { name, description, isPrivate, headBranch: 'main' });
    security.audit('repository created', { repo: `${record.owner}/${record.name}`, private: isPrivate, by: viewer.login });
    redirect(res, `${base}/${encodeURIComponent(name)}?msg=Repository+created`);
  } catch (err) {
    log.error('repository create failed', { repo: `${viewer.login}/${name}`, reason: err.message });
    html(res, 500, views.newRepoPage({ user: viewer, error: 'Could not create the repository. See the server log.', values, csrf: csrfField(req) }));
  }
  return undefined;
}

// A failed copy is rendered as the new repository page again, with the values
// the job was started from, so a URL that turned out to be wrong does not have
// to be typed a second time.
function importJobRoute(req, res, viewer, segments) {
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET', 'Content-Length': 0 });
    res.end();
    return undefined;
  }

  const job = viewer ? imports.find(segments[2], viewer.login) : null;
  const page = `/new/import/${segments[2]}`;

  if (!job) {
    // The poll is for a job that existed when the page was rendered and is gone
    // now, swept or lost to a restart. Answered as a job that ended rather than
    // an error, so the poll can follow the location back to the explanation.
    if (segments[3]) return json(res, 200, { state: 'forgotten', location: page });
    html(res, 404, views.notFoundPage({ user: viewer, what: 'That import is not being tracked. A restart drops the ones still running.' }));
    return undefined;
  }

  // Status before the failure page: the poll has to keep getting JSON once the
  // copy has failed, and HTML there is what would leave the bar crawling
  // against a parse it can never complete.
  if (segments[3]) {
    json(res, 200, {
      state: job.state,
      percent: job.percent,
      reported: job.reported,
      phase: job.phase,
      detail: job.detail,
      error: job.error,
      location:
        job.state === 'done'
          ? `/${encodeURIComponent(job.owner)}/${encodeURIComponent(job.name)}?msg=Imported`
          : page,
    });
    return undefined;
  }

  if (job.state === 'failed') {
    html(res, 200, views.newRepoPage({
      user: viewer,
      error: `Import failed: ${job.error}`,
      values: { name: job.name, description: job.description, private: job.isPrivate, import: job.typed },
      csrf: csrfField(req),
    }));
    return undefined;
  }

  html(res, 200, views.importPage({ user: viewer, job, statusUrl: `${page}/status` }));
  return undefined;
}


function pusherMap(dir) {
  const map = new Map();
  const logRoot = path.join(dir, 'logs', 'refs', 'heads');
  let files;
  try {
    files = fs.readdirSync(logRoot, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const file of files) {
    if (!file.isFile()) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(logRoot, file.name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      const parts = (tab === -1 ? line : line.slice(0, tab)).split(' ');
      // A reflog identity runs "<name> <email> <seconds> <tz>". The name is
      // everything between the sha and the email bracket.
      const emailAt = parts.findIndex((part, i) => i >= 3 && part.startsWith('<'));
      const who = emailAt > 2 ? parts.slice(2, emailAt).join(' ') : parts[2] || '';
      const newSha = parts[1];
      if (newSha && who && !map.has(newSha)) map.set(newSha, who);
    }
  }
  return map;
}

function withPushers(dir, commits) {
  const map = pusherMap(dir);
  for (const commit of commits) {
    const who = map.get(commit.sha);
    if (who) commit.pushedBy = who;
  }
  return commits;
}

function commitOfRef(dir, rev) {
  const sha = repo.resolveRevision(dir, rev);
  const obj = sha ? repo.readObject(dir, sha) : null;
  return obj && obj.type === 'commit' ? objects.parseCommit(obj.body) : null;
}

function codeRoute(req, res, record, dir, viewer, rev, pathSegments) {
  const context = repoContext(req, record);
  const commit = commitOfRef(dir, rev);

  if (!commit) {
    html(res, 200, pages.emptyPage({
      repo: record,
      viewer,
      branches: context.branches,
      tags: context.tags,
      sizeBytes: context.sizeBytes,
      accountBytes: context.accountBytes,
      cloneUrl: context.cloneUrl,
      user: viewer,
    }));
    return;
  }

  const sha = repo.resolveRevision(dir, rev);
  const walk = repo.walkPath(dir, commit.tree, pathSegments);
  if (!walk) {
    html(res, 404, views.notFoundPage({ user: viewer, what: 'That path does not exist at this revision.' }));
    return;
  }
  if (walk.type !== 'tree') {
    blobRoute(req, res, record, dir, viewer, rev, pathSegments);
    return;
  }

  const entries = repo.readTreeEntries(dir, walk.sha);
  const lastCommits = repo.lastCommitsForTree(dir, sha, pathSegments);
  const readmeNames = new Set(entries.filter((entry) => !entry.isTree).map((entry) => entry.name));

  // Only the one README is read. Reading every blob in the directory to find one
  // would pull the whole tree into memory on a page load that wants one file.
  const readmeFile = pages.readmeName(readmeNames);
  let readmeBody = null;
  if (readmeFile && /\.mdx?$/i.test(readmeFile)) {
    const target = repo.walkPath(dir, walk.sha, [...pathSegments, readmeFile]);
    if (target && target.body && target.body.length <= pages.README_RENDER_BYTES) readmeBody = target.body;
  }

  html(res, 200, pages.codePage({
    repo: record,
    viewer,
    ref: rev === 'HEAD' ? headLabel(context) : rev,
    pathSegments,
    entries,
    lastCommits,
    readmeNames,
    readmeBody,
    branches: context.branches,
    tags: context.tags,
    sizeBytes: context.sizeBytes,
    accountBytes: context.accountBytes,
    cloneUrl: context.cloneUrl,
    user: viewer,
  }));
}

function blobRoute(req, res, record, dir, viewer, rev, pathSegments) {
  const context = repoContext(req, record);
  const commit = commitOfRef(dir, rev);
  if (!commit) {
    html(res, 404, views.notFoundPage({ user: viewer, what: 'That revision does not exist.' }));
    return;
  }
  const walk = repo.walkPath(dir, commit.tree, pathSegments);
  if (!walk || !walk.body) {
    html(res, 404, views.notFoundPage({ user: viewer, what: 'That path does not exist at this revision.' }));
    return;
  }

  html(res, 200, pages.blobPage({
    repo: record,
    viewer,
    ref: rev === 'HEAD' ? headLabel(context) : rev,
    pathSegments,
    blob: walk.body,
    mode: walk.trail.length ? walk.trail[walk.trail.length - 1].mode : '100644',
    branches: context.branches,
    tags: context.tags,
    sizeBytes: context.sizeBytes,
    accountBytes: context.accountBytes,
    cloneUrl: context.cloneUrl,
    user: viewer,
  }));
}

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  xml: 'application/xml',
};

function contentTypeFor(name) {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

function rawRoute(res, dir, parts) {
  const split = splitRefAndPath(dir, parts);
  const commit = split ? commitOfRef(dir, split.rev) : null;
  const walk = commit ? repo.walkPath(dir, commit.tree, split.rest) : null;
  if (!walk || !walk.body) return plain(res, 404, 'Not found\n');

  const fileName = split.rest[split.rest.length - 1] || 'file';
  res.writeHead(200, {
    'Content-Type': contentTypeFor(fileName),
    'Content-Length': walk.body.length,
    'Cache-Control': 'no-cache',
    'Content-Disposition': `inline; filename="${fileName.replace(/["\\]/g, '')}"`,
  });
  res.end(walk.body);
}

function commitsRoute(req, res, record, dir, viewer, rev) {
  const context = repoContext(req, record);
  const sha = repo.resolveRevision(dir, rev);
  const walked = sha ? repo.history(dir, sha, COMMIT_PAGE_SIZE) : { commits: [], truncated: false };

  html(res, 200, pages.commitsPage({
    repo: record,
    viewer,
    ref: rev === 'HEAD' ? headLabel(context) : rev,
    commits: withPushers(dir, walked.commits),
    truncated: walked.truncated,
    branches: context.branches,
    tags: context.tags,
    sizeBytes: context.sizeBytes,
    accountBytes: context.accountBytes,
    cloneUrl: context.cloneUrl,
    user: viewer,
    isEmpty: !context.branches.length,
  }));
}

function commitRoute(req, res, record, dir, viewer, sha) {
  const context = repoContext(req, record);
  const resolved = repo.resolveRevision(dir, sha);
  const obj = resolved ? repo.readObject(dir, resolved) : null;
  if (!obj || obj.type !== 'commit') {
    html(res, 404, views.notFoundPage({ user: viewer, what: 'No such commit.' }));
    return;
  }

  const commit = objects.parseCommit(obj.body);
  let parentTree = null;
  if (commit.parents.length) {
    const parent = repo.readObject(dir, commit.parents[0]);
    if (parent && parent.type === 'commit') parentTree = objects.parseCommit(parent.body).tree;
  }

  const summary = objects.commitSummary(commit);
  summary.sha = resolved;
  const pushed = pusherMap(dir).get(resolved);
  if (pushed) summary.pushedBy = pushed;

  html(res, 200, pages.commitPage({
    repo: record,
    viewer,
    ref: headLabel(context),
    commit: summary,
    parents: commit.parents,
    changed: pages.changedFiles(dir, parentTree, commit.tree),
    branches: context.branches,
    tags: context.tags,
    sizeBytes: context.sizeBytes,
    accountBytes: context.accountBytes,
    cloneUrl: context.cloneUrl,
    user: viewer,
  }));
}

function branchesRoute(req, res, record, dir, viewer) {
  const context = repoContext(req, record);
  const head = repo.headRef(dir);
  const headSha = head ? repo.resolveRefName(dir, head) : null;
  const walked = headSha ? repo.history(dir, headSha, MAX_HISTORY) : { commits: [], truncated: false };
  html(res, 200, pages.branchesPage({
    repo: record,
    viewer,
    branches: context.branches,
    tags: context.tags,
    commits: walked.commits,
    sizeBytes: context.sizeBytes,
    accountBytes: context.accountBytes,
    cloneUrl: context.cloneUrl,
    user: viewer,
  }));
}

function tagsRoute(req, res, record, dir, viewer) {
  const context = repoContext(req, record);
  html(res, 200, pages.tagsPage({
    repo: record,
    viewer,
    branches: context.branches,
    tags: context.tags,
    sizeBytes: context.sizeBytes,
    accountBytes: context.accountBytes,
    cloneUrl: context.cloneUrl,
    user: viewer,
  }));
}

async function settingsRoute(req, res, record, dir, viewer, segments) {
  if (!isOwner(record, viewer)) return plain(res, 403, 'Owner access only\n');
  const context = repoContext(req, record);
  const base = `/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.name)}`;
  const query = new URL(req.url, 'http://x').searchParams;
  const gate = security.writeLimits.hit(viewer.login.toLowerCase());
  if (!gate.ok) return security.tooMany(res, gate.retryAfterMs);

  if (req.method === 'POST' && !requireCsrf(req, res)) return undefined;

  // The two token branches are told apart by the fifth segment. Matching on the
  // fourth alone let "/tokens/revoke" fall into this one, because it comes
  // first: revoking a token issued another one and revoked nothing, so the old
  // token kept working while the user was told it had been revoked.
  if (segments[3] === 'tokens' && !segments[4] && req.method === 'POST') {
    const issued = await auth.issueToken(viewer.login, String(req.form.name || '').trim().slice(0, 60));
    security.audit('token issued', { login: viewer.login, name: issued.name || '(unnamed)', id: issued.id });
    redirect(res, `${base}/settings?token=${encodeURIComponent(issued.value)}`);
    return undefined;
  }

  if (segments[3] === 'tokens' && segments[4] === 'revoke' && req.method === 'POST') {
    const id = String(req.form.token || '').trim();
    if (/^[0-9a-f]{12}$/.test(id) && accounts.revokeToken(viewer.login, id)) {
      // A revoked token that is still sitting in the verification cache would
      // keep working for up to a minute, which is not what revoking means.
      auth.invalidateToken(viewer.login, id);
      security.audit('token revoked', { login: viewer.login, id });
    }
    redirect(res, `${base}/settings?msg=Token+revoked`);
    return undefined;
  }

  if (segments[3] === 'delete' && req.method === 'POST') {
    storage.deleteRepository(record.owner, record.name);
    security.audit('repository deleted', { repo: `${record.owner}/${record.name}`, by: viewer.login });
    redirect(res, '/?msg=Repository+deleted');
    return undefined;
  }

  if (req.method === 'POST') {
    storage.updateRepository(record.owner, record.name, {
      description: String(req.form.description || '').trim().slice(0, 180),
      private: req.form.private === '1',
    });
    redirect(res, `${base}/settings?msg=Saved`);
    return;
  }

  html(res, 200, pages.settingsPage({
    repo: accounts.getRepo(record.owner, record.name),
    user: viewer,
    branches: context.branches,
    sizeBytes: context.sizeBytes,
    accountBytes: context.accountBytes,
    flash: flashFrom(query),
    csrf: csrfField(req),
    tokens: accounts.listTokens(viewer.login),
    freshToken: query.get('token') || '',
  }));
  return undefined;
}

module.exports = { handleWeb };
