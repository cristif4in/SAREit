// Where a repository lives on disk and how much of the storage budget it has
// used. Git owns the directory itself; this module only names it and measures
// it.
//
// The budgets are 100MB per repository and 100MB per account across all of
// its repositories. Both count the bytes under the git directories and nothing
// else, so an account record stays free: it is a login, an email and a 64 byte
// scrypt hash, well under a kilobyte, and it is never charged against the
// quota it is being charged for.

const fs = require('fs');
const path = require('path');
const { REPOS_DIR, MAX_REPO_BYTES, MAX_ACCOUNT_BYTES } = require('./config');
const accounts = require('./accounts');
const catalog = require('./catalog');
const repo = require('./git/repo');

const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function validLogin(login) {
  return LOGIN_RE.test(login);
}

function validRepoName(name) {
  return NAME_RE.test(name) && name !== '.' && name !== '..';
}

function repoDir(owner, name) {
  return path.join(REPOS_DIR, owner.toLowerCase(), `${name.toLowerCase()}.git`);
}

function repoSize(dir) {
  return repo.dirSize(dir);
}

// The exact number, always by walking the directory. Used on a push and on a
// delete, where the answer has to be right.
function exactRepoSize(owner, name) {
  const bytes = repoSize(repoDir(owner, name));
  catalog.storeSize(owner, name, bytes);
  return bytes;
}

// The stored number, refreshed in the background when it has gone stale. Used
// when rendering a page, where being five minutes behind costs nothing.
function displayRepoSize(owner, name) {
  const stored = catalog.storedSize(owner, name);
  if (stored && !stored.stale) return stored.bytes;
  if (!stored) return exactRepoSize(owner, name);
  catalog.refreshSizeInBackground(owner, name, () => repoSize(repoDir(owner, name)));
  return stored.bytes;
}

function displayAccountSize(owner) {
  const rows = accounts.listRepos(owner);
  let total = 0;
  for (const record of rows) {
    total += displayRepoSize(record.owner, record.name);
  }
  return total;
}

function exactAccountSize(owner) {
  let total = 0;
  for (const record of accounts.listRepos(owner)) {
    total += exactRepoSize(record.owner, record.name);
  }
  return total;
}

function formatLimit(bytes) {
  return `${Math.round(bytes / 1048576)}MB`;
}

// Returns null when there is room, otherwise the reason there is not. Both the
// single repository ceiling and the account total are checked, and the account
// total is the sum over every repository it owns.
function checkBudget(owner, name, extraBytes) {
  const dir = repoDir(owner, name);
  const repoBytes = repoSize(dir) + extraBytes;
  if (repoBytes > MAX_REPO_BYTES) {
    return `${name} would reach ${formatLimit(repoBytes)}, past the ${formatLimit(MAX_REPO_BYTES)} per-repository limit`;
  }
  const others = exactAccountSize(owner);
  const current = accounts.getRepo(owner, name) ? repoSize(dir) : 0;
  const accountBytes = others - current + repoBytes;
  if (accountBytes > MAX_ACCOUNT_BYTES) {
    return `${owner} would reach ${formatLimit(accountBytes)} across all repositories, past the ${formatLimit(MAX_ACCOUNT_BYTES)} per-account limit`;
  }
  return null;
}

function ensureRepoDir(owner, name) {
  const dir = repoDir(owner, name);
  fs.mkdirSync(dir, { recursive: true });
  if (!repo.exists(dir)) repo.init(dir);
  return dir;
}

// Creates the bare repository first and the row second. The reverse order
// leaves a row pointing at an empty directory if the process dies between the
// two, which is the direction that loses data.
function createRepository(owner, fields) {
  const dir = ensureRepoDir(owner, fields.name);
  try {
    const record = accounts.createRepo(owner, fields);
    catalog.upsert(record);
    catalog.storeSize(record.owner, record.name, 0);
    return record;
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

// The row without the directory. An import writes the directory itself with
// git clone --bare, and cloning into a directory that already exists and is not
// empty fails, so the row goes in first and git creates the directory.
function reserveRepository(owner, fields) {
  const record = accounts.createRepo(owner, fields);
  catalog.upsert(record);
  return record;
}

function deleteRepository(owner, name) {
  fs.rmSync(repoDir(owner, name), { recursive: true, force: true });
  catalog.remove(owner, name);
  return accounts.deleteRepo(owner, name);
}

function updateRepository(owner, name, changes) {
  const record = accounts.updateRepo(owner, name, changes);
  catalog.describe(owner, name, changes);
  return record;
}

function listOrphanedDirs() {
  const known = new Set(
    accounts.listAllRepos().map((record) => path.resolve(repoDir(record.owner, record.name)))
  );
  const orphans = [];
  let owners;
  try {
    owners = fs.readdirSync(REPOS_DIR, { withFileTypes: true });
  } catch {
    return orphans;
  }
  for (const owner of owners) {
    if (!owner.isDirectory()) continue;
    let repos;
    try {
      repos = fs.readdirSync(path.join(REPOS_DIR, owner.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of repos) {
      if (!entry.isDirectory() || !entry.name.endsWith('.git')) continue;
      const full = path.join(REPOS_DIR, owner.name, entry.name);
      if (!known.has(path.resolve(full))) orphans.push(full);
    }
  }
  return orphans;
}

function missingRepoDirs() {
  return accounts
    .listAllRepos()
    .filter((record) => !fs.existsSync(repoDir(record.owner, record.name)))
    .map((record) => `${record.owner}/${record.name}`);
}

module.exports = {
  validLogin,
  validRepoName,
  repoDir,
  repoSize,
  exactRepoSize,
  displayRepoSize,
  displayAccountSize,
  exactAccountSize,
  checkBudget,
  ensureRepoDir,
  createRepository,
  reserveRepository,
  updateRepository,
  deleteRepository,
  listOrphanedDirs,
  missingRepoDirs,
};
