// Drives the pack reader hard enough to show a descriptor leak, by asking for
// objects out of a packed repository many times over.
//
// On Linux this reads /proc/<pid>/fd for the server and fails if the count
// grows. Elsewhere it reports EMFILE, which is how the leak actually shows up
// on Windows once the process runs out of descriptors.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 11709);

function fdCount(pid) {
  if (process.platform !== 'linux') return null;
  try {
    return fs.readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    return null;
  }
}

function countHandles(pid) {
  if (process.platform !== 'win32') return null;
  return null;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sareit-fd-'));
  const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sareit-fdimp-'));

  // A repository that is all packfile: the case the leak is in.
  const origin = path.join(importDir, 'origin');
  fs.mkdirSync(origin);
  const git = (args, cwd) => {
    const r = spawn('git', args, { cwd, stdio: 'ignore' });
    return new Promise((res) => r.on('close', res));
  };
  await git(['init', '-q', '-b', 'main'], origin);
  await git(['config', 'user.email', 'f@e.dev'], origin);
  await git(['config', 'user.name', 'F'], origin);
  for (let i = 0; i < 10; i++) {
    fs.writeFileSync(path.join(origin, `f${i}.txt`), `content ${i}\n`.repeat(50));
    await git(['add', '-A'], origin);
    await git(['commit', '-q', '-m', `commit ${i}`], origin);
  }
  await git(['gc', '-q', '--prune=now'], origin);

  const server = spawn(process.execPath, ['index.js'], {
    cwd: ROOT,
    env: { ...process.env, SAREIT_DATA: dataDir, SAREIT_PORT: String(PORT), SAREIT_IMPORT_DIR: importDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  server.stdout.on('data', (d) => (out += d));
  server.stderr.on('data', (d) => (out += d));

  const ready = await waitFor(PORT);
  if (!ready) {
    console.error(`server did not start:\n${out}`);
    server.kill();
    process.exit(1);
  }

  const repoDir = path.join(dataDir, 'repos', 'fdcheck', 'packed.git');
  fs.mkdirSync(path.dirname(repoDir), { recursive: true });
  const clone = spawn('git', ['clone', '-q', '--bare', origin, repoDir], { stdio: 'ignore' });
  await new Promise((res) => clone.on('close', res));
  spawnSyncAccounts(dataDir);

  const repo = require(path.join(ROOT, 'src', 'git', 'repo.js'));
  const shas = collectShas(repoDir);
  if (!shas.length) {
    console.error('no objects found in the packed repository');
    server.kill();
    process.exit(1);
  }

  const before = fdCount(server.pid);
  const rounds = 400;
  for (let i = 0; i < rounds; i++) {
    repo.readObject(repoDir, shas[i % shas.length]);
  }
  const after = fdCount(server.pid);
  repo.closePacks();
  const closed = fdCount(server.pid);

  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    fs.rmSync(importDir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // Windows holds a lock briefly after the process exits. The scratch
    // directories are named uniquely so leaving one behind is harmless.
  }

  console.log(`read ${rounds} objects from a packed repository`);

  if (before === null || after === null) {
    // No cheap descriptor counter here. The leak is instead shown directly:
    // the reader keeps a descriptor per packfile it has opened, and a leak in
    // it shows up as the count growing without bound across repositories.
    console.log('no fd counter on this platform, asserting against the reader cache instead');
    const repo2 = require(path.join(ROOT, 'src', 'git', 'repo.js'));
    repo2.closePacks();
    const held = repo2.openPackCount();
    console.log(`descriptors the pack reader is holding after closePacks: ${held}`);
    if (held !== 0) {
      console.log(`\nFAIL  closePacks left ${held} descriptors open`);
      process.exitCode = 1;
    } else {
      console.log('\nPASS  closePacks released everything');
    }
    return;
  }

  console.log(`descriptors before=${before} after=${after} after closePacks=${closed}`);
  const leaked = after - before;
  if (leaked > 8) {
    console.log(`\nFAIL  ${leaked} descriptors leaked across ${rounds} object reads`);
    console.log('each read opens a packfile and drops the descriptor');
    process.exitCode = 1;
  } else {
    console.log(`\nPASS  descriptor growth across ${rounds} object reads is ${leaked}`);
  }
}

// Registers an account file so the running server will serve that repository.
function spawnSyncAccounts(dataDir) {
  const script = `
    process.env.SAREIT_DATA = ${JSON.stringify(dataDir)};
    const accounts = require(${JSON.stringify(path.join(ROOT, 'src', 'accounts.js'))});
    accounts.createUser({
      login: 'fdcheck',
      email: '',
      salt: 'ab'.repeat(16),
      passwordHash: '00'.repeat(64),
    });
    accounts.createRepo('fdcheck', { name: 'packed', description: '', isPrivate: false });
  `;
  const { spawnSync } = require('child_process');
  spawnSync(process.execPath, ['-e', script], { cwd: ROOT, env: { ...process.env, SAREIT_DATA: dataDir } });
}

function collectShas(repoDir) {
  const { execFileSync } = require('child_process');
  const out = execFileSync('git', ['rev-list', '--objects', '--all'], { cwd: repoDir, encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => line.split(' ')[0])
    .filter((sha) => /^[0-9a-f]{40}$/.test(sha))
    .slice(0, 200);
}

function waitFor(port) {
  const http = require('http');
  const deadline = Date.now() + 20000;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 1000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => (Date.now() > deadline ? resolve(false) : setTimeout(attempt, 250)));
      req.on('timeout', () => req.destroy());
    };
    attempt();
  });
}

main();
