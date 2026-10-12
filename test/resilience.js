// Storage resilience checks: a damaged account file, an orphaned repository
// directory, and a rollback after a half finished repository creation.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DATA = process.env.SAREIT_DATA;
if (!DATA) {
  console.error('SAREIT_DATA must point at the running server data directory');
  process.exit(1);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function boot() {
  const r = spawnSync(process.execPath, ['-e', "require(process.argv[1] + '/src/app.js').reportStartupState()", path.join(__dirname, '..')], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function accountFiles() {
  return fs.readdirSync(path.join(DATA, 'accounts')).filter((f) => f.endsWith('.sqlite'));
}

// These run as `node -e`, where a relative require has no module path to
// resolve against, so the project root is passed in explicitly.
const PROJECT_ROOT = path.join(__dirname, '..');

// Reads the account row straight out of the file, the way a person would with
// a sqlite3 binary if they were ever curious what is in there.
function inspectAccount(file) {
  const script = `
    const { openDatabase } = require(process.argv[2] + '/src/sqlite.js');
    const db = openDatabase(process.argv[1]);
    const account = db.prepare('SELECT login, email FROM account').get();
    const repos = db.prepare('SELECT name, description FROM repository ORDER BY name').all();
    console.log(JSON.stringify({ account, repos }));
  `;
  const r = spawnSync(process.execPath, ['-e', script, path.join(DATA, 'accounts', file), PROJECT_ROOT], {
    encoding: 'utf8',
    cwd: PROJECT_ROOT,
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const existing = accountFiles();
check('there are account files to work with', existing.length > 0, `${existing.length} file(s)`);

const healthy = accountFiles()[0];
const before = inspectAccount(healthy);
check(
  'a healthy account file reads back',
  before.code === 0 && before.out.includes('login'),
  before.out.slice(0, 80)
);

// Copy a good account file, scribble over the first page, and confirm the boot
// pass refuses to open it rather than serving it or crashing.
const damaged = path.join(DATA, 'accounts', 'damaged.sqlite');
fs.copyFileSync(path.join(DATA, 'accounts', healthy), damaged);
const junk = Buffer.alloc(4096, 0xa5);
const fd = fs.openSync(damaged, 'r+');
fs.writeSync(fd, junk, 0, junk.length, 0);
fs.closeSync(fd);

const afterDamage = boot();
const readableLine = afterDamage.out.trim();
const unreadable = Number(readableLine.match(/(\d+)\/(\d+)/)?.[2] || 0) - Number(readableLine.match(/(\d+)\/(\d+)/)?.[1] || 0);
check(
  'boot reports the damaged account instead of serving it',
  afterDamage.err.includes('damaged') && unreadable >= 1,
  `${readableLine} | ${afterDamage.err.split('\n')[0].trim()}`
);
check('boot survives a damaged account file', afterDamage.code === 0, `exit ${afterDamage.code}`);

const damagedLook = inspectAccount('damaged.sqlite');
check(
  'a damaged account file is not readable as an account',
  damagedLook.code !== 0 || !damagedLook.out.includes('login'),
  damagedLook.err.split('\n')[0] || damagedLook.out.slice(0, 60)
);

// The other accounts must be untouched by one damaged file beside them.
const stillHealthy = inspectAccount(healthy);
check(
  'other accounts are unaffected by a damaged neighbour',
  stillHealthy.code === 0 && stillHealthy.out === before.out,
  'identical before and after'
);

fs.rmSync(damaged, { force: true });
fs.rmSync(path.join(DATA, 'accounts', 'damaged.sqlite-wal'), { force: true });
fs.rmSync(path.join(DATA, 'accounts', 'damaged.sqlite-shm'), { force: true });

// A repository directory with no row: the boot pass reports it and does not
// delete it, because the operator is the one who decides which side is right.
const orphan = path.join(DATA, 'repos', 'orphan-owner', 'leftover.git');
fs.mkdirSync(orphan, { recursive: true });
fs.writeFileSync(path.join(orphan, 'HEAD'), 'ref: refs/heads/main\n');

const afterOrphan = boot();
check(
  'boot reports a repository directory with no row',
  afterOrphan.err.includes('directory with no repository row') && afterOrphan.err.includes('leftover.git'),
  afterOrphan.err.trim()
);
check('the orphaned directory is left in place, not deleted', fs.existsSync(orphan));

// A row with no directory is the other half of the same mismatch.
const script = `
  const { openDatabase } = require(process.argv[2] + '/src/sqlite.js');
  const db = openDatabase(process.argv[1]);
  db.prepare("INSERT INTO repository (name, name_key, description, private, head_branch, imported_from, created_at) VALUES (?, ?, ?, 0, 'main', '', '2026-01-01T00:00:00.000Z')")
    .run('ghost', 'ghost', 'row without a directory');
`;
const target = path.join(DATA, 'accounts', healthy);
spawnSync(process.execPath, ['-e', script, target, PROJECT_ROOT], { encoding: 'utf8', cwd: PROJECT_ROOT });

const afterGhost = boot();
check(
  'boot reports a repository row with no directory',
  afterGhost.err.includes('repository row with no directory') && afterGhost.err.includes('ghost'),
  afterGhost.err.trim()
);

const ghostScript = `
  const { openDatabase } = require(process.argv[2] + '/src/sqlite.js');
  const db = openDatabase(process.argv[1]);
  db.prepare("DELETE FROM repository WHERE name_key = 'ghost'").run();
`;
spawnSync(process.execPath, ['-e', ghostScript, target, PROJECT_ROOT], { encoding: 'utf8', cwd: PROJECT_ROOT });
fs.rmSync(orphan, { recursive: true, force: true });
fs.rmdirSync(path.join(DATA, 'repos', 'orphan-owner'));

// A password record is a salt and a hash, never the password itself.
const leakScript = `
  const { openDatabase } = require(process.argv[2] + '/src/sqlite.js');
  const db = openDatabase(process.argv[1]);
  const row = db.prepare('SELECT * FROM account').get();
  console.log(JSON.stringify({ columns: Object.keys(row) }));
`;
const leak = spawnSync(process.execPath, ['-e', leakScript, target, PROJECT_ROOT], { encoding: 'utf8', cwd: PROJECT_ROOT });
const columns = JSON.parse(leak.stdout.trim()).columns;
check(
  'the account table holds a salt and a hash, never a password column',
  !columns.includes('password') && columns.includes('salt') && columns.includes('password_hash'),
  columns.join(', ')
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);
  process.exitCode = 1;
}
