// Accounts, one SQLite file each under data/accounts/<login>.sqlite.
//
// Why one file per account rather than one shared database: a single file is
// the only piece of state a login owns, so a locked, corrupt or half restored
// account cannot take every other account with it, and a backup or a manual
// inspection is a plain file copy. Enumerating accounts is a directory read.
//
// Durability settings, and what each one is for:
//   journal_mode=WAL    commits are atomic and a reader never blocks a writer
//   synchronous=FULL    WAL's default NORMAL drops commits on power loss,
//                       which is the wrong trade for a password record
//   busy_timeout        a concurrent writer waits rather than throwing
//   foreign_keys=ON     no cascades are used, so this is a tripwire for a
//                       future schema edit that adds one
// Every schema change goes through migrate() and bumps user_version, so an
// account file written by an older build is upgraded in place on first open
// instead of being read with whatever columns it happens to have.

const fs = require('fs');
const path = require('path');
const { openDatabase } = require('./sqlite');
const { ACCOUNTS_DIR, MAX_OPEN_ACCOUNT_FILES } = require('./config');
const log = require('./log');

// Schema history. Every entry takes the database from version N to N+1 and
// must only ever add: a new table, a new column with a default, a new index.
// Nothing here drops or renames, because an account file written by any earlier
// build has to keep working without being touched by hand. Migrations run in
// order inside one transaction each, so a file half upgraded rolls back.
const SCHEMA_VERSION = 2;

const MIGRATIONS = [
  // 0 -> 1: initial schema.
  `
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
  `,
  // 1 -> 2: access tokens for the git protocol.
  //
  // A token stands in for the account password in git's credential store, so a
  // machine that pushes never holds the password that unlocks the web UI. Only
  // a hash is kept, and the id half is unique enough to find the row by.
  `
  CREATE TABLE token (
    id           TEXT PRIMARY KEY,
    salt         TEXT NOT NULL,
    token_hash   TEXT NOT NULL,
    name         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    last_used_at TEXT NOT NULL DEFAULT '',
    revoked_at   TEXT NOT NULL DEFAULT ''
  );
  `,
];

const open = new Map();

// page_size only takes effect before the first table is written. A fresh file
// has no tables yet, so this is the one moment it can be set. 1024 keeps an
// empty account file at a few KB instead of the 28KB that 4096-byte pages
// allocate for the same handful of rows.
const ACCOUNT_PAGE_SIZE = 1024;

function tune(db) {
  db.exec('PRAGMA page_size = 1024');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > SCHEMA_VERSION) {
    throw new Error(`account file is at schema version ${current}, this build understands ${SCHEMA_VERSION}`);
  }
  for (let version = current; version < SCHEMA_VERSION; version++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// Filenames come from a validated login, so the only characters reaching
// path.join are [a-z0-9-]. Anything else is rejected before this runs.
function accountFile(login) {
  if (!/^[a-z0-9-]{1,39}$/.test(login)) throw new Error(`refusing to derive a path from login "${login}"`);
  return path.join(ACCOUNTS_DIR, `${login}.sqlite`);
}

function connect(login, { create = false } = {}) {
  const key = login.toLowerCase();
  const cached = open.get(key);
  if (cached) return cached;

  const file = accountFile(key);
  if (!create && !fs.existsSync(file)) return null;
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });

  const db = openDatabase(file);
  tune(db);
  migrate(db);

  // A file that fails its own integrity check is kept out of the cache so no
  // caller can write to it, and is never repaired in place.
  const health = db.prepare('PRAGMA quick_check').get().quick_check;
  if (health !== 'ok') {
    db.close();
    throw new Error(`integrity check on ${key}.sqlite returned "${health}"`);
  }

  const handle = { key, file, db };
  open.set(key, handle);
  evictOldest(key);
  return handle;
}

// Closes the least recently opened handle once past the cap. The handle being
// opened right now is skipped rather than closed, since closing it would drop
// the write the caller is about to make.
function evictOldest(exemptKey) {
  if (open.size <= MAX_OPEN_ACCOUNT_FILES) return;
  for (const key of open.keys()) {
    if (key === exemptKey) continue;
    closeAccount(key);
    if (open.size <= MAX_OPEN_ACCOUNT_FILES) return;
  }
}

function closeAccount(login) {
  const handle = open.get(login);
  if (!handle) return;
  open.delete(login);
  try {
    handle.db.close();
  } catch {
    // Already closed by the runtime on shutdown.
  }
}

function closeAll() {
  for (const key of [...open.keys()]) closeAccount(key);
}

function listLogins() {
  try {
    return fs
      .readdirSync(ACCOUNTS_DIR)
      .filter((name) => /^[a-z0-9-]{1,39}\.sqlite$/.test(name))
      .map((name) => name.slice(0, -'.sqlite'.length))
      .sort();
  } catch {
    return [];
  }
}

function touchCreated(login) {
  connect(login, { create: true });
}

function rowToUser(row) {
  if (!row) return null;
  return {
    login: row.login,
    email: row.email || '',
    salt: row.salt,
    hash: row.password_hash,
    createdAt: row.created_at,
  };
}

// The owner is attached on read rather than stored, so a repository row can
// never disagree with the account file it lives in. There is no owner column to
// read here; listRepos and getRepo add it from the handle they already opened.
function rowToRepo(row) {
  if (!row) return null;
  return {
    name: row.name,
    description: row.description,
    private: !!row.private,
    headBranch: row.head_branch,
    importedFrom: row.imported_from,
    createdAt: row.created_at,
  };
}

function findUser(login) {
  if (typeof login !== 'string' || !login) return null;
  let handle;
  try {
    handle = connect(login);
  } catch (err) {
    log.error('account unreadable', { login, reason: err.message });
    return null;
  }
  if (!handle) return null;
  return rowToUser(handle.db.prepare('SELECT * FROM account WHERE login = ?').get(login));
}

function getUserPublic(login) {
  const user = findUser(login);
  if (!user) return null;
  return { login: user.login, email: user.email, createdAt: user.createdAt };
}

function createUser({ login, email, salt, passwordHash }) {
  const key = login.toLowerCase();
  const file = accountFile(key);
  if (fs.existsSync(file)) throw new Error('account already exists');
  // The directory is created here rather than relying on a boot pass having
  // made it, so an account can be created into a data directory that is
  // otherwise empty.
  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });

  const db = openDatabase(file);
  try {
    tune(db);
    migrate(db);
    db.prepare(
      'INSERT INTO account (login, email, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(login, email || '', salt, passwordHash, new Date().toISOString());
    // Returns the freed pages to the filesystem so an account that has never
    // held a repository is a few KB on disk rather than a preallocated block.
    db.exec('VACUUM');
  } catch (err) {
    db.close();
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // The file was never committed, so an empty leftover is harmless.
    }
    throw err;
  }
  db.close();
  closeAccount(key);
  touchCreated(key);
  return { login, email: email || '', createdAt: new Date().toISOString() };
}

function updateUser(login, changes) {
  const handle = connect(login);
  if (!handle) return null;
  handle.db.prepare('UPDATE account SET email = ? WHERE login = ?').run(changes.email || '', login);
  return getUserPublic(login);
}

function accountExists(login) {
  return fs.existsSync(accountFile(login.toLowerCase()));
}

function listRepos(login) {
  const handle = connect(login);
  if (!handle) return [];
  const rows = handle.db.prepare('SELECT * FROM repository ORDER BY created_at DESC, name ASC').all();
  return rows.map((row) => ({ ...rowToRepo(row), owner: handle.key }));
}

function getRepo(ownerLogin, name) {
  const handle = connect(ownerLogin);
  if (!handle) return null;
  const row = handle.db.prepare('SELECT * FROM repository WHERE name_key = ?').get(String(name).toLowerCase());
  return row ? { ...rowToRepo(row), owner: handle.key } : null;
}

function createRepo(ownerLogin, { name, description, isPrivate, headBranch, importedFrom }) {
  const handle = connect(ownerLogin);
  if (!handle) throw new Error(`no account file for ${ownerLogin}`);
  handle.db
    .prepare(
      `INSERT INTO repository (name, name_key, description, private, head_branch, imported_from, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      name.toLowerCase(),
      description || '',
      isPrivate ? 1 : 0,
      headBranch || 'main',
      importedFrom || '',
      new Date().toISOString()
    );
  return getRepo(ownerLogin, name);
}

function updateRepo(ownerLogin, name, changes) {
  const handle = connect(ownerLogin);
  if (!handle) return null;
  handle.db
    .prepare('UPDATE repository SET description = ?, private = ?, head_branch = ? WHERE name_key = ?')
    .run(changes.description || '', changes.private ? 1 : 0, changes.headBranch || 'main', String(name).toLowerCase());
  return getRepo(ownerLogin, name);
}

function deleteRepo(ownerLogin, name) {
  const handle = connect(ownerLogin);
  if (!handle) return false;
  const info = handle.db
    .prepare('DELETE FROM repository WHERE name_key = ?')
    .run(String(name).toLowerCase());
  return info.changes > 0;
}

// Access tokens for the git protocol. The row is found by the id half of the
// token, which is not a secret on its own; the secret half is what gets
// hashed. Revoking keeps the row so the token name and creation date stay on
// the settings page rather than vanishing.
function addToken(ownerLogin, { id, salt, tokenHash, name }) {
  const handle = connect(ownerLogin);
  if (!handle) throw new Error(`no account file for ${ownerLogin}`);
  handle.db
    .prepare(
      `INSERT INTO token (id, salt, token_hash, name, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(id, salt, tokenHash, name || '', new Date().toISOString());
  return id;
}

function findToken(ownerLogin, id) {
  const handle = connect(ownerLogin);
  if (!handle) return null;
  return handle.db.prepare('SELECT * FROM token WHERE id = ? AND revoked_at = ?').get(id, '') || null;
}

function touchToken(ownerLogin, id) {
  const handle = connect(ownerLogin);
  if (!handle) return;
  handle.db.prepare("UPDATE token SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), id);
}

function revokeToken(ownerLogin, id) {
  const handle = connect(ownerLogin);
  if (!handle) return false;
  const info = handle.db
    .prepare("UPDATE token SET revoked_at = ? WHERE id = ? AND revoked_at = ''")
    .run(new Date().toISOString(), id);
  return info.changes > 0;
}

function listTokens(ownerLogin) {
  const handle = connect(ownerLogin);
  if (!handle) return [];
  return handle.db
    .prepare('SELECT id, name, created_at, last_used_at, revoked_at FROM token ORDER BY created_at DESC')
    .all();
}

// Dashboard and search walk every account file. Accounts are counted in the
// hundreds before this is a problem, and each file is a few hundred KB.
function listAllRepos() {
  const out = [];
  for (const login of listLogins()) {
    let repos;
    try {
      repos = listRepos(login);
    } catch (err) {
      log.error('repositories skipped', { login, reason: err.message });
      continue;
    }
    out.push(...repos);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name));
}

function searchRepos(query) {
  const needle = String(query || '').trim().toLowerCase();
  const all = listAllRepos();
  if (!needle) return all;
  return all.filter((repo) =>
    `${repo.owner}/${repo.name} ${repo.description}`.toLowerCase().includes(needle)
  );
}

module.exports = {
  SCHEMA_VERSION,
  connect,
  closeAccount,
  closeAll,
  listLogins,
  findUser,
  getUserPublic,
  createUser,
  updateUser,
  accountExists,
  listRepos,
  getRepo,
  createRepo,
  updateRepo,
  deleteRepo,
  addToken,
  findToken,
  touchToken,
  revokeToken,
  listTokens,
  listAllRepos,
  searchRepos,
};
