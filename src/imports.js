// Importing a remote into an account, as a job that outlives the request.
//
// git clone of a large project runs for minutes. Holding an HTTP request open
// for that long tells the person waiting nothing at all, so the request that
// starts the copy returns at once with a job id and the page polls the job.
//
// Progress comes out of git itself: clone --progress writes the phase
// percentages to stderr, which is read here and folded into the one number the
// bar shows. A clone that reports nothing, which is what a copy from a local
// directory looks like, leaves the bar indeterminate rather than inventing a
// figure for it.
//
// The job table is in memory. A restart loses it, and the page reports that
// instead of waiting on a copy that is no longer running.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const storage = require('./storage');
const catalog = require('./catalog');
const repo = require('./git/repo');
const security = require('./security');
const log = require('./log');

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

// Long enough for the page to come back from a reload or a sleeping laptop and
// still read how the copy ended. Past that the job is dropped.
const JOB_TTL_MS = 10 * 60 * 1000;

// Each entry is a few hundred bytes, so this only bites against a lot of
// imports at once. The oldest finished job goes to make room, never a running
// one.
const MAX_JOBS = 64;

// git reports a percentage per phase and never one for the whole clone. The
// bar is a single number, so the phases get shares of it: receiving the objects
// is the transfer itself, while enumerating them and resolving the deltas sit
// at either end of it and finish quickly.
const PHASE_BAND = {
  counting: [0, 15],
  receiving: [15, 90],
  deltas: [90, 99],
};

const PHASES = [
  { phase: 'counting', label: 'Counting objects', seen: /(?:Enumerating|Counting|Compressing) objects/ },
  { phase: 'receiving', label: 'Receiving objects', seen: /Receiving objects:\s+(\d+)% \((\d+)\/(\d+)\)/ },
  { phase: 'deltas', label: 'Resolving deltas', seen: /Resolving deltas:\s+(\d+)% \((\d+)\/(\d+)\)/ },
];

const jobs = new Map();

// The source string is handed to git as an argument, so it must not be able to
// look like an option. A leading dash would otherwise turn the remote into a
// flag such as --upload-pack and run a command on this machine. Validating
// that it is a real remote URL also keeps file:// out.
//
// SAREIT_IMPORT_DIR, when set, is a staging directory the operator controls.
// A signed-in account may clone from inside it and nowhere else on this
// filesystem, which is what makes an offline migration possible without letting
// anyone read the server's own files through the import form.
function validSource(source) {
  if (!source || source.length > 1024) return null;
  if (source.startsWith('-')) return null;

  const staging = process.env.SAREIT_IMPORT_DIR;
  if (staging && !/^[a-z][a-z0-9+.-]*:\/\//i.test(source) && !/^[\w.-]+@[\w.-]+:/.test(source)) {
    const root = path.resolve(staging);
    const target = path.resolve(root, source);
    const relative = path.relative(root, target);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return target;
    return null;
  }

  if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(source)) return source;
  try {
    const url = new URL(source);
    if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'ssh:' && url.protocol !== 'git:') {
      return null;
    }
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// The page is the only reader, and it belongs to whoever started the copy. A
// job that is not the viewer's is not found whether or not it exists.
function find(id, login) {
  const job = jobs.get(String(id));
  if (!job || !login) return null;
  return job.owner.toLowerCase() === String(login).toLowerCase() ? job : null;
}

function start({ owner, name, description, isPrivate, source, typed = source }) {
  sweep();
  for (const job of jobs.values()) {
    if (job.state === 'running' && job.owner.toLowerCase() === owner.toLowerCase() && job.name.toLowerCase() === name.toLowerCase()) {
      // A second click on Import would clone into the directory the first one is
      // still writing, and its cleanup would take that copy with it.
      return job;
    }
  }

  const job = {
    id: crypto.randomBytes(16).toString('hex'),
    owner,
    name,
    description,
    isPrivate,
    // What the form said, which is not what git is given: a source inside the
    // staging directory resolves to an absolute path, and that is the wrong
    // thing to hand back to a form asking for a remote.
    typed,
    source,
    state: 'running',
    phase: 'Starting the clone',
    percent: 0,
    reported: false,
    detail: '',
    error: '',
    startedAt: Date.now(),
    finishedAt: 0,
    pending: '',
    tail: [],
    timedOut: false,
  };
  jobs.set(job.id, job);
  log.info('import started', { owner, name, from: job.typed });
  run(job);
  return job;
}

// git clone --bare is what keeps an imported project intact: it copies the
// objects and refs as they are, so commit messages, authors, dates, tags and
// notes come across exactly as the origin platform recorded them. Nothing
// afterwards rewrites them, so a normal clone of the result reproduces the
// original history.
function run(job) {
  const dir = storage.repoDir(job.owner, job.name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  const child = spawn('git', ['clone', '--bare', '--progress', '--', job.source, dir], {
    cwd: path.dirname(dir),
    // GIT_TERMINAL_PROMPT stops git blocking on a credential prompt it can never
    // answer, which would otherwise hold the job open until the timeout.
    env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_ASKPASS_REQUIRE: 'never' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const timer = setTimeout(() => {
    job.timedOut = true;
    child.kill();
  }, CLONE_TIMEOUT_MS);

  child.stderr.on('data', (chunk) => readProgress(job, chunk));
  // A spawn that never started emits both of these, so the first one to land
  // settles the job and the other is ignored. Without that the second run of
  // fail replaces the real reason with an exit code that says nothing.
  let settled = false;
  const done = (reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fail(job, dir, reason);
  };

  child.on('error', (err) => done(err.message));
  child.on('close', (code) => {
    if (settled) return;
    if (code !== 0) {
      const last = job.tail.filter(Boolean).slice(-3).join(' ') || `git clone exited ${code}`;
      return done(job.timedOut ? `the copy did not finish within ${CLONE_TIMEOUT_MS / 60000} minutes` : last);
    }
    settled = true;
    clearTimeout(timer);
    adopt(job, dir);
  });
}

// The clone wrote the objects; now the row that makes them a repository, which
// is also the point where the storage budget is checked.
function adopt(job, dir) {
  try {
    const headRef = repo.headRef(dir);
    const sizeBytes = storage.repoSize(dir);
    const over = storage.checkBudget(job.owner, job.name, 0);
    if (over) throw new Error(over);

    const record = storage.createRepository(job.owner, {
      name: job.name,
      description: job.description,
      isPrivate: job.isPrivate,
      headBranch: headRef ? headRef.slice('refs/heads/'.length) : 'main',
      importedFrom: job.source,
    });
    catalog.storeSize(record.owner, record.name, sizeBytes);

    job.state = 'done';
    job.percent = 100;
    job.phase = 'Imported';
    job.finishedAt = Date.now();
    security.audit('repository imported', {
      repo: `${record.owner}/${record.name}`,
      from: job.source,
      mb: Math.round(sizeBytes / 1048576),
      by: job.owner,
    });
    log.info('import finished', {
      repo: `${record.owner}/${record.name}`,
      mb: Math.round(sizeBytes / 1048576),
      seconds: Math.round((job.finishedAt - job.startedAt) / 1000),
    });
  } catch (err) {
    fail(job, dir, err.message);
  }
}

function fail(job, dir, reason) {
  fs.rmSync(dir, { recursive: true, force: true });
  job.state = 'failed';
  job.phase = 'Import failed';
  job.error = reason;
  job.finishedAt = Date.now();
  log.error('import failed', { owner: job.owner, name: job.name, from: job.source, reason });
  security.audit('import failed', { login: job.owner, from: job.source, reason });
}

// git --progress rewrites the line it is on with a bare carriage return and
// ends it with a newline, so both have to split. Splitting on newlines alone
// collapses a whole run of updates into one line and parses only the first of
// them. Whatever the last chunk cut in half is held until the next one arrives.
function readProgress(job, chunk) {
  job.pending += chunk.toString('utf8');
  const lines = job.pending.split(/\r\n|\r|\n/);
  job.pending = lines.pop();
  for (const line of lines) {
    if (applyLine(job, line)) continue;
    job.tail.push(line.trim());
  }
  if (job.tail.length > 3) job.tail.shift();
}

// Returns true when the line was progress, so that a line that is not is kept
// as the reason the clone failed.
function applyLine(job, line) {
  for (const phase of PHASES) {
    const hit = phase.seen.exec(line);
    if (!hit) continue;
    const [from, to] = PHASE_BAND[phase.phase];
    const within = Math.min(100, Number(hit[1]) || 0);
    // A phase change must not walk the bar backwards, which is what a plain
    // per-phase percentage would do at the start of receiving.
    job.percent = Math.max(job.percent, Math.round(from + ((to - from) * within) / 100));
    job.reported = true;
    job.phase = phase.label;
    if (hit[2] && hit[3]) job.detail = `${hit[2]} of ${hit[3]} objects`;
    return true;
  }
  return false;
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.state !== 'running' && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
  while (jobs.size > MAX_JOBS) {
    const finished = [...jobs.values()].filter((job) => job.state !== 'running');
    if (!finished.length) break;
    finished.sort((a, b) => a.finishedAt - b.finishedAt);
    jobs.delete(finished[0].id);
  }
}

module.exports = { validSource, find, start };