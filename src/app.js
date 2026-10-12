// Request dispatch. One port serves the site and the git protocol, and the
// git paths are matched first because they overlap the web ones.

const fs = require('fs');
const path = require('path');
const githttp = require('./git/http');
const { handleWeb } = require('./routes');
const accounts = require('./accounts');
const storage = require('./storage');
const auth = require('./auth');
const security = require('./security');
const catalog = require('./catalog');
const repo = require('./git/repo');
const { PUBLIC_DIR, MAX_FORM_BYTES, MAX_PUSH_BYTES, REPOS_DIR, ACCOUNTS_DIR, HOST } = require('./config');

const STATIC_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
};

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function serveStatic(req, res, name) {
  const file = path.join(PUBLIC_DIR, name);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    sendText(res, 404, 'Not found\n');
    return;
  }
  const stat = fs.statSync(file);
  // Strong validator from the size and the last write time. The two together
  // change whenever the file does, so a hit is a real hit and a miss is a real
  // miss; mtime alone would be ambiguous within the same second.
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream',
    ETag: etag,
    'Last-Modified': stat.mtime.toUTCString(),
    // Revalidate on every use instead of serving a copy blind for an hour.
    // These two files carry the whole theme: a browser holding a stale
    // stylesheet shows the old palette and a toggle that appears to do nothing,
    // which no redeploy can fix from the server side. A conditional request
    // costs one stat and comes back 304 with no body, so revalidating is cheap.
    // Assets worth caching hard should be fingerprinted into their filename.
    'Cache-Control': 'no-cache',
  };

  const offered = req.headers['if-none-match'];
  if (offered && offered.split(',').some((tag) => tag.trim() === etag || tag.trim() === '*')) {
    // 304 carries no body, so it must not carry a length either.
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const body = fs.readFileSync(file);
  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  res.end(body);
}

// Boot pass over the on-disk state. Account files are a few hundred KB each
// so a quick_check on every one costs milliseconds, and it is the difference
// between finding a damaged file at startup and finding it during someone's
// push. Repository directories are checked against their account rows in both
// directions: an unmatched pair is reported, never repaired, because which
// side is correct is a decision for whoever owns the machine.
function reportStartupState() {
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  fs.mkdirSync(REPOS_DIR, { recursive: true });

  const logins = accounts.listLogins();
  let healthy = 0;
  for (const login of logins) {
    try {
      accounts.connect(login);
      healthy++;
    } catch (err) {
      console.error(`SAREit account "${login}" did not open, its file is not being served: ${err.message}`);
    }
  }

  // The catalog is a cache, so it is rebuilt whenever an account file has
  // changed. On a large instance the fingerprint matches and this is a no-op,
  // which keeps restart time flat as the account count grows.
  let catalogNote = 'catalog not built';
  try {
    const result = catalog.rebuildIfStale();
    catalogNote = result.rebuilt
      ? `catalog rebuilt, ${result.count} repositories`
      : 'catalog current';
  } catch (err) {
    catalogNote = `catalog could not be built: ${err.message}`;
    console.error(`SAREit ${catalogNote}`);
  }

  const problems = [];
  for (const name of storage.missingRepoDirs()) problems.push(`repository row with no directory: ${name}`);
  for (const dir of storage.listOrphanedDirs()) problems.push(`directory with no repository row: ${dir}`);

  console.log(
    `SAREit storage: ${healthy}/${logins.length} account file(s) readable, ${catalogNote}, ${problems.length} repository mismatch(es)`
  );
  for (const problem of problems) console.error(`SAREit ${problem}`);
}

function parseForm(req) {
  return githttp
    .readBody(req, MAX_FORM_BYTES)
    .then((body) => Object.fromEntries(new URLSearchParams(body.toString('utf8'))))
    .catch(() => Object.create(null));
}

// Anything that changes state needs a signed-in session and a CSRF token,
// with the exception of signing in and registering, which are the two ways to
// get a session in the first place. Enforcing it here rather than inside each
// handler means a route added later cannot accidentally skip it.
const STATE_CHANGES_WITHOUT_A_SESSION = new Set(['/login', '/register']);

function isStateChange(req, segments) {
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'PATCH' && req.method !== 'DELETE') {
    return false;
  }
  const path = `/${segments.join('/')}`;
  return !STATE_CHANGES_WITHOUT_A_SESSION.has(path);
}

function createApp() {
  return async function app(req, res) {
    security.applySecurityHeaders(res);

    let url;
    let segments;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      segments = url.pathname
        .split('/')
        .filter(Boolean)
        .map((part) => decodeURIComponent(part));
    } catch {
      sendText(res, 400, 'Malformed request path\n');
      return;
    }

    // Checked before anything is read, so a forged request is refused without
    // this process doing work on its behalf.
    if (!security.hostAllowed(req, HOST)) {
      security.audit('host refused', `host=${req.headers.host} path=${req.url}`);
      sendText(res, 421, 'Unknown host\n');
      return;
    }
    if (!security.sameOrigin(req)) {
      security.audit('cross origin refused', `origin=${req.headers.origin} path=${req.url}`);
      sendText(res, 403, 'Cross origin request refused\n');
      return;
    }

    try {
      // Browsers ask for this on every page load. Answered here so it never
      // reaches the router, where a single segment would be read as an account
      // name and produce a lookup for something that is not one.
      if (segments.length === 1 && segments[0] === 'favicon.ico') {
        serveStatic(req, res, 'favicon.svg');
        return;
      }

      if (segments[0] === 'static' && segments.length === 2) {
        serveStatic(req, res, segments[1]);
        return;
      }

      // A body of any size is capped before it is read, so an oversized form
      // is refused rather than buffered. The git routes have their own, much
      // larger ceiling and are dispatched before this.
      const name = (segments[1] || '').replace(/\.git$/i, '');
      if (isGitPath(segments) && segments[0] && name) {
        await githttp.handle(req, res, {
          owner: segments[0],
          name,
          hook: segments[2] === 'info' ? 'info/refs' : segments[2],
          searchParams: url.searchParams,
        });
        return;
      }

      // A body larger than either ceiling is refused on the header alone,
      // before a single byte is read. A lying or absent Content-Length is
      // caught by the reader's own limit.
      const declared = Number(req.headers['content-length'] || 0);
      const ceiling = isGitPath(segments) ? MAX_PUSH_BYTES : MAX_FORM_BYTES;
      if (declared > ceiling) {
        sendText(res, 413, 'Request body too large\n');
        return;
      }

      req.form = req.method === 'POST' ? await parseForm(req) : Object.create(null);

      if (isStateChange(req, segments) && !auth.userFromCookie(req)) {
        security.audit('unauthenticated state change refused', `path=${req.url}`);
        sendText(res, 401, 'Sign in to make changes\n');
        return;
      }

      await handleWeb(req, res, segments, url);
    } catch (err) {
      console.error(`SAREit ${req.method} ${req.url} failed: ${err.stack || err.message}`);
      if (!res.headersSent) sendText(res, 500, 'Internal server error\n');
      else res.end();
    }
  };
}

function isGitPath(segments) {
  if (segments.length < 3) return false;
  const hook = segments[2];
  return hook === 'git-upload-pack' || hook === 'git-receive-pack' || (hook === 'info' && segments[3] === 'refs');
}

module.exports = { createApp, reportStartupState };
