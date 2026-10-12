// The database compatibility contract: an account file written by any earlier
// build has to keep working, keep its data, and gain whatever newer versions
// added without being touched by hand.
//
// This builds a schema version 1 file by hand, exactly as the previous build
// would have written it, and then lets the current build open it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sareit-migrate-'));
process.env.SAREIT_DATA = DATA;

const { openDatabase } = require(path.join(ROOT, 'src', 'sqlite.js'));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const LOGIN = 'oldaccount';
const PASSWORD = 'correct horse battery';

// Written with the version 1 schema and nothing else: no token table, no
// columns past the originals.
function buildVersion1(file) {
  const db = openDatabase(file);
  db.exec(`
    CREATE TABLE account (
      login        TEXT PRIMARY KEY,
      email        TEXT NOT NULL DEFAULT '',
      salt         TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE repository (
      name         TEXT PRIMARY KEY,
      name_key     TEXT NOT NULL UNIQUE,
      description  TEXT NOT NULL DEFAULT '',
      private      INTEGER NOT NULL DEFAULT 0,
      head_branch  TEXT NOT NULL DEFAULT 'main',
      imported_from TEXT NOT NULL DEFAULT '',
      created_at   TEXT NOT NULL
    );
  `);
  db.exec('PRAGMA user_version = 1');
  const salt = 'ab'.repeat(16);
  const hash = require('node:crypto').scryptSync(PASSWORD, salt, 64).toString('hex');
  db.prepare(
    'INSERT INTO account (login, email, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(LOGIN, 'old@example.com', salt, hash, '2024-03-01T10:00:00.000Z');
  db.prepare(
    `INSERT INTO repository (name, name_key, description, private, head_branch, imported_from, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('ancient', 'ancient', 'made before the migration', 1, 'trunk', '', '2024-03-01T10:00:00.000Z');
  db.close();
}

const accountsDir = path.join(DATA, 'accounts');
fs.mkdirSync(accountsDir, { recursive: true });
const file = path.join(accountsDir, `${LOGIN}.sqlite`);
buildVersion1(file);

// Confirm it really is version 1 before the current build sees it.
{
  const db = openDatabase(file);
  check('the file starts at schema version 1', db.prepare('PRAGMA user_version').get().user_version === 1);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  check('it has no token table yet', !tables.includes('token'), tables.join(', '));
  db.close();
}

const accounts = require(path.join(ROOT, 'src', 'accounts.js'));
const auth = require(path.join(ROOT, 'src', 'auth.js'));

console.log('');

const user = accounts.findUser(LOGIN);
check('the account still reads after the upgrade', !!user, user ? user.login : 'not found');
check('its email survived', user && user.email === 'old@example.com', user ? user.email : '');
check('its creation date survived', user && user.createdAt === '2024-03-01T10:00:00.000Z', user ? user.createdAt : '');

const repos = accounts.listRepos(LOGIN);
check('its repositories survived', repos.length === 1 && repos[0].name === 'ancient', repos.map((r) => r.name).join(','));
check(
  'the private flag survived',
  repos[0] && repos[0].private === true,
  repos[0] ? String(repos[0].private) : ''
);
check('the imported_from column survived', repos[0] && repos[0].importedFrom === '');

console.log('');

{
  const db = openDatabase(file);
  check('the file is now at the current schema version', db.prepare('PRAGMA user_version').get().user_version === 2);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  check('the token table was added', tables.includes('token'), tables.join(', '));
  db.close();
}

console.log('');

// The credential and the data written by the old build both have to work.
(async () => {
  const ok = await auth.checkCredentials(LOGIN, PASSWORD);
  check('the password hash written by the old build still verifies', !!ok, ok ? ok.login : 'rejected');

  const wrong = await auth.checkCredentials(LOGIN, 'not the password');
  check('a wrong password is still rejected', wrong === null);

  console.log('');

  // A token issued against the upgraded file has to behave like any other.
  const issued = await auth.issueToken(LOGIN, 'migrated account');
  check('a token can be issued against the upgraded file', !!issued.value, issued.id);
  check('the token looks like a token', /^sareit_[0-9a-f]{12}_[A-Za-z0-9_-]+$/.test(issued.value));

  const viaToken = await auth.checkCredentials(LOGIN, issued.value);
  check('the token authenticates', !!viaToken && viaToken.login === LOGIN);

  const viaPasswordStill = await auth.checkCredentials(LOGIN, PASSWORD);
  check('the account password still authenticates alongside it', !!viaPasswordStill);

  const listed = accounts.listTokens(LOGIN);
  check('the token is listed on the account', listed.length === 1 && listed[0].name === 'migrated account');
  // The secret is everything after the first underscore that follows the
  // prefix. A plain split on "_" is wrong here: the secret is base64url, so it
  // can itself contain underscores, and split("_")[2] would then be only the
  // fragment before the first one. A 1-character fragment occurs often enough
  // to be found anywhere in the listing, which made this check fail at random.
  const secret = issued.value.slice(issued.value.indexOf('_', 'sareit_'.length) + 1);
  check('the whole secret is recovered for comparison', secret.length >= 40, `${secret.length} chars`);
  check('the token secret never reaches the listing', !JSON.stringify(listed).includes(secret));

  const row = openDatabase(file);
  const stored = row.prepare('SELECT * FROM token WHERE id = ?').get(issued.id);
  check(
    'only a hash of the secret is stored',
    stored && stored.token_hash !== secret && stored.token_hash.length === 128,
    stored ? `${stored.token_hash.length} hex chars` : 'no row'
  );
  row.close();

  // The cache holds a verified credential for a minute, so revoking has to
  // reach into it rather than only marking the row.
  accounts.revokeToken(LOGIN, issued.id);
  auth.invalidateToken(LOGIN, issued.id);
  const afterRevoke = await auth.checkCredentials(LOGIN, issued.value);
  check('a revoked token stops working', afterRevoke === null);

  console.log('');

  // Opening again must be a no-op rather than a second migration.
  accounts.closeAll();
  const reopened = accounts.findUser(LOGIN);
  check('the file reopens cleanly after the upgrade', !!reopened);
  {
    const db = openDatabase(file);
    check('the version did not advance again', db.prepare('PRAGMA user_version').get().user_version === 2);
    db.close();
  }

  accounts.closeAll();
  fs.rmSync(DATA, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
})();
