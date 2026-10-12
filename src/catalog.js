// A derived index of repositories, used only for discovery: the dashboard
// list, the search box, and the stored size of each repository.
//
// Without it, listing repositories means opening every account file, because
// each account owns its own SQLite database. That cost is linear in the number
// of accounts on every single page load, which is the first thing to fall over
// past a few dozen users.
//
// This file is a cache, not a source of truth. The account files hold the
// authoritative rows; a single repository is always read from its account file.
// A rebuild at boot reconciles whatever drifted, so a stale or damaged catalog
// costs a rebuild rather than data.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openDatabase } = require('./sqlite');
const { ACCOUNTS_DIR, DATA_DIR, MAX_REPO_BYTES } = require('./config');
const accounts = require('./accounts');
const log = require('./log');

const CATALOG_FILE = path.join(DATA_DIR, 'catalog.sqlite');

// A stored size older than this is reported immediately and refreshed in the
// background, so a page render never blocks on a directory walk it does not
// actually need to be exact about.
const SIZE_TTL_MS = 5 * 60 * 1000;

let db = null;

function connect() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = openDatabase(CATALOG_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA page_size = 4096');
  db.exec(`
    CREATE TABLE IF NOT EXISTS repository (
      owner           TEXT NOT NULL,
      name            TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      private         INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL,
      size_bytes      INTEGER NOT NULL DEFAULT 0,
      size_checked_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (owner, name)
    );
    CREATE INDEX IF NOT EXISTS repository_created ON repository (created_at DESC);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  return db;
}

function close() {
  if (!db) return;
  try {
    db.close();
  } catch {
    // Already closed on shutdown.
  }
  db = null;
}

// Login names and their modification times. A different fingerprint means an
// account file appeared, vanished, or was rewritten, which is the only thing
// that can invalidate the catalog.
function fingerprint() {
  const entries = [];
  for (const login of accounts.listLogins()) {
    const file = path.join(ACCOUNTS_DIR, `${login}.sqlite`);
    try {
      const stat = fs.statSync(file);
      entries.push(`${login}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      entries.push(`${login}:gone`);
    }
  }
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
}

function getMeta(key) {
  const row = connect().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(key, value) {
  connect().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function upsert(record) {
  connect()
    .prepare(
      `INSERT INTO repository (owner, name, description, private, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(owner, name) DO UPDATE SET
         description = excluded.description,
         private = excluded.private`
    )
    .run(record.owner, record.name, record.description || '', record.private ? 1 : 0, record.createdAt);
}

function remove(owner, name) {
  connect().prepare('DELETE FROM repository WHERE owner = ? AND name = ?').run(owner, name);
}

function describe(owner, name, changes) {
  connect()
    .prepare('UPDATE repository SET description = ?, private = ? WHERE owner = ? AND name = ?')
    .run(changes.description || '', changes.private ? 1 : 0, owner, name);
}

function rowsToRepos(rows) {
  return rows.map((row) => ({
    owner: row.owner,
    name: row.name,
    description: row.description,
    private: !!row.private,
    createdAt: row.created_at,
    sizeBytes: row.size_bytes,
  }));
}

function list(viewer) {
  const rows = connect()
    .prepare('SELECT * FROM repository ORDER BY created_at DESC, name ASC')
    .all();
  return rowsToRepos(rows).filter((repo) => !repo.private || (viewer && viewer.login.toLowerCase() === repo.owner.toLowerCase()));
}

function ownedBy(owner) {
  const rows = connect()
    .prepare('SELECT * FROM repository WHERE owner = ? ORDER BY created_at DESC, name ASC')
    .all(owner.toLowerCase());
  return rowsToRepos(rows);
}

function search(query, viewer) {
  const needle = String(query || '').trim().toLowerCase();
  const all = list(viewer);
  if (!needle) return all;
  return all.filter((repo) =>
    `${repo.owner}/${repo.name} ${repo.description}`.toLowerCase().includes(needle)
  );
}

// Stored size plus how stale it is. A stale value is still returned, because a
// gauge that is five minutes behind is better than a page that waits on a walk
// of a hundred thousand loose objects.
function storedSize(owner, name) {
  const row = connect()
    .prepare('SELECT size_bytes, size_checked_at FROM repository WHERE owner = ? AND name = ?')
    .get(owner, name);
  if (!row) return null;
  return { bytes: row.size_bytes, stale: Date.now() - row.size_checked_at > SIZE_TTL_MS };
}

function storeSize(owner, name, bytes) {
  connect()
    .prepare(
      `UPDATE repository SET size_bytes = ?, size_checked_at = ?
       WHERE owner = ? AND name = ?`
    )
    .run(bytes, Date.now(), owner, name);
}

const refreshing = new Set();

// Kicked off after a page render rather than inside it. The walk runs on the
// main thread, so it is deliberately not awaited anywhere a request is waiting.
function refreshSizeInBackground(owner, name, measure) {
  const token = `${owner}/${name}`;
  if (refreshing.has(token)) return;
  refreshing.add(token);
  setImmediate(() => {
    try {
      storeSize(owner, name, measure());
    } catch (err) {
      log.error('size record failed', { repo: token, reason: err.message });
    } finally {
      refreshing.delete(token);
    }
  });
}

// The sum of what is stored, with no directory walk and no refresh. A stale
// entry is counted at its last known size, which is the right trade for a
// budget check: the answer is a moment old rather than the caller blocking the
// event loop on a filesystem walk.
function storedAccountTotal(owner) {
  const row = connect()
    .prepare('SELECT SUM(size_bytes) AS total FROM repository WHERE owner = ?')
    .get(owner.toLowerCase());
  return row && row.total ? row.total : 0;
}

// Runs once at boot. Skipped when no account file has changed since the last
// build, so a restart on a large instance is immediate.
function rebuildIfStale() {
  connect();
  const current = fingerprint();
  if (getMeta('fingerprint') === current && getMeta('schema') === '1') return { rebuilt: false, count: 0 };

  const connection = connect();
  connection.exec('BEGIN IMMEDIATE');
  let count = 0;
  try {
    connection.exec('DELETE FROM repository');
    for (const login of accounts.listLogins()) {
      let repos;
      try {
        repos = accounts.listRepos(login);
      } catch (err) {
        log.error('catalog skipped account', { login, reason: err.message });
        continue;
      }
      for (const repo of repos) {
        upsert(repo);
        count++;
      }
    }
    setMeta('fingerprint', current);
    setMeta('schema', '1');
    connection.exec('COMMIT');
  } catch (err) {
    connection.exec('ROLLBACK');
    throw err;
  }
  return { rebuilt: true, count };
}

function usage() {
  let bytes = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      bytes += fs.statSync(CATALOG_FILE + suffix).size;
    } catch {
      // The sidecar files only exist while a connection is open.
    }
  }
  return { bytes, accounts: accounts.listLogins().length };
}

module.exports = {
  connect,
  close,
  upsert,
  remove,
  describe,
  list,
  ownedBy,
  search,
  storedSize,
  storeSize,
  refreshSizeInBackground,
  storedAccountTotal,
  rebuildIfStale,
  fingerprint,
  usage,
  SIZE_TTL_MS,
  MAX_REPO_BYTES,
};
