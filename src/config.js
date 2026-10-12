// SAREit runtime configuration and paths.

const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// The data directory defaults to ./data next to the application, so running
// `node index.js` from the project puts every account and repository under
// <project>/data with nothing to configure. SAREIT_DATA moves it elsewhere,
// which is what the test runner uses to keep its accounts out of the real one.
const DATA_DIR = process.env.SAREIT_DATA
  ? path.resolve(process.env.SAREIT_DATA)
  : path.join(ROOT, 'data');

// One SQLite file per account, so a corrupt or locked account cannot take the
// others down with it and a backup is a single file copy.
const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');

// Bare git repositories. Git owns this directory and nothing in SAREit
// rewrites its contents, so a repository imported from elsewhere keeps its
// original history byte for byte.
const REPOS_DIR = path.join(DATA_DIR, 'repos');

// Signs session cookies. Generated on first boot and never sent to a client,
// so rotating it only invalidates open browser sessions.
const SECRET_FILE = path.join(DATA_DIR, 'session-secret');

const HOST = process.env.SAREIT_HOST || '0.0.0.0';
const PORT = Number(process.env.SAREIT_PORT || 11707);

// Storage ceilings. Both count every byte under the git directories and
// nothing else: the account record itself is a few hundred bytes of text and
// is never charged against them.
const MAX_REPO_BYTES = 100 * 1024 * 1024;
const MAX_ACCOUNT_BYTES = 100 * 1024 * 1024;

// A push body is read whole into memory before the pack is parsed, so the
// transport ceiling sits above the storage ceiling to leave room for the
// command list and the pack trailer.
const MAX_PUSH_BYTES = MAX_REPO_BYTES * 2;

// Largest object we will inflate out of an incoming pack.
const MAX_OBJECT_BYTES = MAX_REPO_BYTES;

const MAX_FORM_BYTES = 1024 * 1024;

// Account files are tiny, so integrity checking them all at boot costs
// milliseconds. This many open handles is the cap before the oldest is closed.
const MAX_OPEN_ACCOUNT_FILES = 64;

const SESSION_COOKIE = 'sareit_session';
const SESSION_MAX_AGE = 14 * 24 * 60 * 60;

const ZERO_SHA = '0'.repeat(40);

// Accounts whose repository cards get the animated highlight on the
// dashboard. A comma separated list of logins, or unset for none.
const HIGHLIGHTED_LOGINS = (process.env.SAREIT_HIGHLIGHT || '')
  .split(',')
  .map((part) => part.trim().toLowerCase())
  .filter(Boolean);

module.exports = {
  ROOT,
  PUBLIC_DIR,
  DATA_DIR,
  ACCOUNTS_DIR,
  REPOS_DIR,
  SECRET_FILE,
  HOST,
  PORT,
  MAX_REPO_BYTES,
  MAX_ACCOUNT_BYTES,
  MAX_PUSH_BYTES,
  MAX_OBJECT_BYTES,
  MAX_FORM_BYTES,
  MAX_OPEN_ACCOUNT_FILES,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  HIGHLIGHTED_LOGINS,
  ZERO_SHA,
};
