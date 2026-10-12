// Security file

const crypto = require('crypto');
const { MAX_FORM_BYTES } = require('./config');
const log = require('./log');

function audit(event, fields) {
  log.audit(event, fields);
}


function makeLimiter({ windowMs, max }) {
  const buckets = new Map();
  const windowMsValue = windowMs;

  function prune(now) {
    for (const [key, entry] of buckets) {
      const live = entry.hits.filter((t) => now - t < windowMsValue);
      if (live.length === 0 && now >= entry.blockedUntil) buckets.delete(key);
      else {
        entry.hits = live;
        buckets.delete(key);
        buckets.set(key, entry);
      }
    }
  }

  return {
    // Returns {ok, retryAfterMs}. A blocked bucket stays blocked for the whole
    // window once it trips, so the answer does not flicker as old hits age out.
    hit(key, { count = 1 } = {}) {
      const now = Date.now();
      if (buckets.size > 20000) prune(now);
      const entry = buckets.get(key) || { hits: [], blockedUntil: 0 };
      if (now < entry.blockedUntil) {
        buckets.delete(key);
        buckets.set(key, entry);
        return { ok: false, retryAfterMs: entry.blockedUntil - now };
      }
      entry.hits.push(now);
      if (entry.hits.length > max) {
        entry.blockedUntil = now + windowMsValue;
        buckets.delete(key);
        buckets.set(key, entry);
        audit('rate limit tripped', { key, windowMs: windowMsValue, max });
        return { ok: false, retryAfterMs: windowMsValue };
      }
      buckets.delete(key);
      buckets.set(key, entry);
      return { ok: true, retryAfterMs: 0 };
    },
    reset(key) {
      buckets.delete(key);
    },
    size() {
      return buckets.size;
    },
  };
}

// Sign in is per remote address and per account, so one attacker cannot lock a
// known account out from a shared address, and one shared address cannot spray
// many accounts without tripping the per-address bucket.
const signInLimits = makeLimiter({ windowMs: 15 * 60 * 1000, max: 12 });
const signInPerAccount = makeLimiter({ windowMs: 15 * 60 * 1000, max: 12 });

// git opens several connections per operation, so this counts requests rather
// than failures and sits far above real client behaviour.
const gitLimits = makeLimiter({ windowMs: 60 * 1000, max: 900 });

const registrationLimits = makeLimiter({ windowMs: 60 * 60 * 1000, max: 20 });
const importLimits = makeLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
const writeLimits = makeLimiter({ windowMs: 60 * 1000, max: 120 });

function clientAddress(req) {
  // A proxy in front of SAREit sets this. It is trusted the same way the
  // client address is: whatever reaches the socket.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// Content-Length is computed from the string rather than written by hand. A
// length larger than the body is not a wrong page, it is a connection that
// never closes: the client waits for bytes that will not arrive.
function tooMany(res, retryAfterMs, message = 'Too many requests\n') {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.writeHead(429, {
    'Retry-After': String(seconds),
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
  });
  res.end(message);
}

function challenge(res, message = 'Too many requests\n') {
  res.writeHead(429, {
    'Retry-After': '900',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
  });
  res.end(message);
}

// The session payload is stable for the life of a cookie, so a CSRF token
// derived from it is stable too and needs no storage. An attacker on another
// origin can neither read the cookie nor compute the tag without the secret.
function csrfToken(sessionSecret, sessionCookieValue) {
  if (!sessionCookieValue) return '';
  return crypto
    .createHmac('sha256', sessionSecret)
    .update(`csrf:${sessionCookieValue}`)
    .digest('base64url');
}

function csrfOk(sessionSecret, sessionCookieValue, supplied) {
  const expected = csrfToken(sessionSecret, sessionCookieValue);
  if (!expected || typeof supplied !== 'string' || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

// Everything the pages load is same-origin, so the policy can forbid inline
// script and styles outright. public/app.js carries the few behaviours that
// used to be inline handlers.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

// DNS rebinding: a page on the internet can resolve a hostname to 127.0.0.1
// and then talk to a service bound to the loopback interface from inside the
// victim's browser. The browser will still send the Host header the page
// asked for, so rejecting a Host that is not an address this instance answers
// to closes that off.
//
// SAREIT_ALLOWED_HOSTS adds names to the list, which is what is needed behind
// a proxy that rewrites Host. The bind address is always accepted so the
// default case needs no configuration.
function hostAllowed(req, bindHost) {
  const header = req.headers.host;
  if (!header) return false;
  const host = String(header).split(':')[0].toLowerCase().replace(/^\[|\]$/g, '');
  const extras = (process.env.SAREIT_ALLOWED_HOSTS || '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (extras.includes(host)) return true;
  if (bindHost === '0.0.0.0' || bindHost === '::') return true;
  return host === bindHost || host === 'localhost';
}

// Cross-origin form posts are the other half. The CSRF token already refuses
// them, but a browser tells us the origin before any of that is checked, and
// an Origin that does not match the Host is never a legitimate request here.
//
// The literal string "null" is what a browser sends from a sandboxed frame, a
// privacy mode, or a cross-site redirect. It names no origin, so it cannot be
// compared against anything and is not grounds for a refusal: treating it as a
// mismatch locks people out of their own site from those contexts. The CSRF
// token is what actually stops the attack this check is a second line for.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;
  let originHost;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    // Unparseable is a real refusal, unlike the documented "null".
    return false;
  }
  return String(req.headers.host || '').toLowerCase() === originHost;
}

// Every response, including the error paths, carries the same policy.
function applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // no-referrer rather than same-origin: a repository path can carry a branch
  // name, and the git clone URL carries the account login, so neither belongs
  // in a Referer header going anywhere.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
}

module.exports = {
  audit,
  makeLimiter,
  signInLimits,
  signInPerAccount,
  gitLimits,
  registrationLimits,
  importLimits,
  writeLimits,
  clientAddress,
  tooMany,
  challenge,
  csrfToken,
  csrfOk,
  applySecurityHeaders,
  hostAllowed,
  sameOrigin,
  MAX_FORM_BYTES,
};
