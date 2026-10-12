// Sign in, session cookies, and HTTP Basic credentials for the git protocol.
//
// scrypt is the deliberate cost here, so it runs on the libuv threadpool
// rather than on the main thread: a blocking 120ms hash on every git request
// stalls every other connection. Verified credentials are cached briefly,
// keyed by the credential itself, so a repeat request is a map lookup and a
// changed password simply misses.
//
// A missing account still runs a hash against a fixed dummy salt, so the time
// to reject an unknown login matches the time to reject a wrong password and
// the endpoint cannot be used to enumerate accounts.

const crypto = require('crypto');
const fs = require('fs');
const { DATA_DIR, SECRET_FILE, SESSION_COOKIE, SESSION_MAX_AGE } = require('./config');
const accounts = require('./accounts');

// scrypt cost parameters. N=16384 with 64 bytes of output is the library
// default and took 121ms on the machine this was built on.
const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Must be a valid salt of the same shape, so the work done is comparable.
const DUMMY_SALT = '00000000000000000000000000000000';

const VERIFIED_TTL_MS = 60 * 1000;
const VERIFIED_MAX = 1024;

let secret = null;

function getSecret() {
  if (secret) return secret;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    secret = fs.readFileSync(SECRET_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    secret = crypto.randomBytes(32);
    fs.writeFileSync(SECRET_FILE, secret);
    // The secret signs every session cookie. On a shared machine it should
    // not be readable by other accounts on the box.
    try {
      fs.chmodSync(SECRET_FILE, 0o600);
    } catch {
      // Windows and some network filesystems do not carry unix modes.
    }
  }
  return secret;
}

function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString('hex'));
    });
  });
}

function equalHex(a, b) {
  if (typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// A token looks like "sareit_<id>_<secret>". The id half locates the row, the
// secret half is hashed and compared. Used as the git password so a machine
// that pushes does not hold the password that unlocks the web UI.
const TOKEN_PREFIX = 'sareit_';

function parseToken(value) {
  if (typeof value !== 'string' || !value.startsWith(TOKEN_PREFIX)) return null;
  const rest = value.slice(TOKEN_PREFIX.length);
  const separator = rest.indexOf('_');
  if (separator < 1) return null;
  return { id: rest.slice(0, separator), secret: rest.slice(separator + 1) };
}

async function issueToken(login, name) {
  const id = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  const tokenHash = await scryptAsync(secret, salt);
  accounts.addToken(login, { id, salt, tokenHash, name });
  return { id, name: name || '', value: `${TOKEN_PREFIX}${id}_${secret}`, createdAt: new Date().toISOString() };
}

// Returns the account when the token is valid and not revoked. A token that
// does not resolve still runs a hash against a dummy salt, so an unknown token
// costs the same as a wrong password.
async function verifyToken(login, tokenValue) {
  const parsed = parseToken(tokenValue);
  const row = parsed ? accounts.findToken(login, parsed.id) : null;
  const salt = row ? row.salt : DUMMY_SALT;
  const hash = await scryptAsync(parsed ? parsed.secret : '', salt);
  if (!row || !equalHex(hash, row.token_hash)) return null;
  accounts.touchToken(login, parsed.id);
  const user = accounts.getUserPublic(login);
  return user;
}

const verified = new Map();

function cacheKey(login, password) {
  // The password is part of the key by design: a changed password can never
  // hit a stale entry, so no invalidation path is needed.
  return `${login}\0${crypto.createHash('sha256').update(password).digest('base64url')}`;
}

function cacheGet(key) {
  const hit = verified.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    verified.delete(key);
    return null;
  }
  return hit.user;
}

// The cache key is a hash of the credential, so the token id cannot be read
// back out of it. It is kept alongside instead, which is what lets a revoked
// token be dropped from the cache rather than left working for its TTL.
function cachePut(key, user, tokenId = '') {
  if (verified.size >= VERIFIED_MAX) {
    const oldest = verified.keys().next().value;
    verified.delete(oldest);
  }
  verified.set(key, { user, tokenId, expires: Date.now() + VERIFIED_TTL_MS });
}

function invalidate(login) {
  for (const key of verified.keys()) {
    if (key.startsWith(`${login}\0`)) verified.delete(key);
  }
}

// A revoked token must not keep working from the verification cache, which
// would otherwise honour it for up to a minute after revocation. The id is
// enough: it is the part of the token that is not hashed.
function invalidateToken(login, tokenId) {
  for (const [key, entry] of verified) {
    if (!key.startsWith(`${login}\0`)) continue;
    if (entry.tokenId === tokenId) verified.delete(key);
  }
}

async function register({ login, email, password }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scryptAsync(password, salt);
  return accounts.createUser({
    login,
    email: String(email || '').trim().slice(0, 254),
    salt,
    passwordHash: hash,
  });
}

async function checkCredentials(login, password) {
  if (typeof login !== 'string' || typeof password !== 'string') return null;
  // A token-shaped credential is checked as a token and never falls through
  // to the password path, so the two hashes cannot be told apart by timing.
  if (password.startsWith(TOKEN_PREFIX)) {
    const key = cacheKey(login, password);
    const cached = cacheGet(key);
    if (cached) return cached;
    const user = await verifyToken(login, password);
    if (user) cachePut(key, user, parseToken(password)?.id || '');
    return user;
  }

  const key = cacheKey(login, password);
  const cached = cacheGet(key);
  if (cached) return cached;

  const user = accounts.findUser(login);
  const salt = user ? user.salt : DUMMY_SALT;
  const hash = await scryptAsync(password, salt);
  if (!user || !equalHex(hash, user.hash)) return null;

  const publicUser = { login: user.login, email: user.email, createdAt: user.createdAt };
  cachePut(key, publicUser);
  return publicUser;
}

function signSession(login) {
  const payload = Buffer.from(
    JSON.stringify({ login, exp: Date.now() + SESSION_MAX_AGE * 1000 })
  ).toString('base64url');
  const mac = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

function readSession(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  let mac;
  try {
    mac = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', getSecret()).update(payload).digest();
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
  let claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!claims || typeof claims.exp !== 'number' || claims.exp < Date.now()) return null;
  return accounts.getUserPublic(claims.login);
}

function parseCookies(header) {
  const jar = Object.create(null);
  if (!header) return jar;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      jar[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      jar[name] = part.slice(eq + 1).trim();
    }
  }
  return jar;
}

function sessionCookieValue(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
}

function userFromCookie(req) {
  return readSession(sessionCookieValue(req));
}

async function userFromBasic(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) return null;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return null;
  return checkCredentials(decoded.slice(0, colon), decoded.slice(colon + 1));
}

function sessionCookie(token) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE}`,
  ].join('; ');
}

function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

module.exports = {
  getSecret,
  register,
  checkCredentials,
  issueToken,
  parseToken,
  invalidate,
  invalidateToken,
  signSession,
  readSession,
  parseCookies,
  sessionCookieValue,
  userFromCookie,
  userFromBasic,
  sessionCookie,
  clearCookie,
};
