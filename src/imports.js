// Importing a remote into an account, as a queued background job.
//
// The repository row is written before the clone starts and is private until it
// finishes, so the only person who sees an import in progress is the one who
// started it, and /owner/name is the page to come back to.
//
// git clone --progress writes its phase percentages to stderr, which is what the
// page's bar is built from. A clone that reports none, which is what a copy from
// a local directory looks like, leaves the bar indeterminate and the elapsed
// counter as the only thing moving.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const storage = require('./storage');
const catalog = require('./catalog');
const repo = require('./git/repo');
const security = require('./security');
const accounts = require('./accounts');
const log = require('./log');
const { MAX_REPO_BYTES } = require('./config');

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const JOB_TTL_MS = 10 * 60 * 1000;

// One clone at a time. Two concurrent clones competing with the request
// handlers for the same cores is what makes the whole instance feel slow, and a
// queue bounds that without patching git.
const IMPORT_CONCURRENCY = 1;

// Lower process priority where the platform has one. Windows has nothing
// reachable from here, so an instance there gets the queue without the nice.
const IMPORT_NICE = 10;

// pack.threads=1 stops delta resolution fanning out across cores, gc.auto=0
// stops a garbage collection firing the moment the clone lands, and a small
// bigFileThreshold keeps large blobs out of the delta heap.
const CLONE_OPTIONS = ['-c', 'pack.threads=1', '-c', 'gc.auto=0', '-c', 'core.bigFileThreshold=4m'];

// git reports a percentage per phase and never one for the whole clone, and the
// bar is a single number, so the phases get shares of it: receiving the objects
// is the transfer, the other two sit at either end and finish quickly.
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
const queue = [];
const running = new Set();

function key(owner, name) {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

// The job for a repository, while there is one worth looking at. A finished job
// is left out so the repository page shows the repository rather than a report
// on the copy that produced it.
function jobFor(owner, name) {
  const job = jobs.get(key(owner, name));
  return job && job.state !== 'done' ? job : null;
}

// The source string is handed to git as an argument, so it must not be able to
// look like an option. A leading dash would otherwise turn the remote into a
// flag such as --upload-pack and run a command on this machine. Validating
// that it is a real remote URL also keeps file:// out.
//
// SAREIT_IMPORT_DIR, when set, is a staging directory the operator controls. A
// signed-in account may clone from inside it and nowhere else on this
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

function start({ owner, name, description, isPrivate, source, typed = source }) {
  sweep();

  const job = {
    owner,
    name,
    description,
    isPrivate,
    // What the form said. A source inside the staging directory resolves to an
    // absolute path, which is the wrong thing to hand back to a form.
    typed,
    source,
    state: 'queued',
    phase: 'Waiting for a slot',
    percent: 0,
    reported: false,
    detail: '',
    error: '',
    queuedAt: Date.now(),
    finishedAt: 0,
    pending: '',
    tail: [],
    timedOut: false,
  };
  jobs.set(key(owner, name), job);

  queue.push(job);
  log.info('import queued', { owner, name, from: typed, waiting: queue.length });
  pump();
  return job;
}

function pump() {
  while (running.size < IMPORT_CONCURRENCY && queue.length) {
    const job = queue.shift();
    running.add(job);
    job.state = 'running';
    job.phase = 'Starting git';
    run(job);
  }
}

function spawnGit(args, options) {
  if (process.platform === 'win32') return spawn('git', args, options);
  return spawn('nice', ['-n', String(IMPORT_NICE), 'git', ...args], options);
}

function run(job) {
  const dir = storage.repoDir(job.owner, job.name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  const child = spawnGit([...CLONE_OPTIONS, 'clone', '--bare', '--progress', '--', job.source, dir], {
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

  // A spawn that never started emits both of these, so the first to land settles
  // the job; otherwise the second replaces the real reason with an exit code.
  let settled = false;
  const done = (reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fail(job, dir, reason);
  };

  child.stderr.on('data', (chunk) => readProgress(job, chunk));
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

// The directory is written, so the row leaves the queue state it was in and the
// repository becomes visible under the visibility the form asked for.
function adopt(job, dir) {
  try {
    const headRef = repo.headRef(dir);
    const sizeBytes = storage.repoSize(dir);
    const over = storage.checkBudget(job.owner, job.name, 0);
    if (over) throw new Error(over);
    if (sizeBytes > MAX_REPO_BYTES) {
      throw new Error(`imported repository is ${Math.round(sizeBytes / 1048576)}MB, over the ${Math.round(MAX_REPO_BYTES / 1048576)}MB limit`);
    }

    accounts.updateRepo(job.owner, job.name, {
      description: job.description,
      private: job.isPrivate,
      headBranch: headRef ? headRef.slice('refs/heads/'.length) : 'main',
    });
    catalog.describe(job.owner, job.name, { description: job.description, private: job.isPrivate });
    catalog.storeSize(job.owner, job.name, sizeBytes);

    job.state = 'done';
    job.percent = 100;
    job.reported = true;
    job.phase = 'Imported';
    job.finishedAt = Date.now();
    running.delete(job);
    log.info('import finished', {
      repo: `${job.owner}/${job.name}`,
      mb: Math.round(sizeBytes / 1048576),
      seconds: Math.round((job.finishedAt - job.queuedAt) / 1000),
    });
    security.audit('repository imported', {
      repo: `${job.owner}/${job.name}`,
      from: job.typed,
      mb: Math.round(sizeBytes / 1048576),
      by: job.owner,
    });
    pump();
  } catch (err) {
    fail(job, dir, err.message);
  }
}

// The row stays. The page it is on is where the reason is shown and where the
// owner can delete it, and a repository row with no directory is what a failed
// copy leaves behind rather than something to be tidied away here.
function fail(job, dir, reason) {
  fs.rmSync(dir, { recursive: true, force: true });
  job.state = 'failed';
  job.phase = 'Import failed';
  job.error = reason;
  job.finishedAt = Date.now();
  running.delete(job);
  log.error('import failed', { owner: job.owner, name: job.name, from: job.typed, reason });
  security.audit('import failed', { login: job.owner, from: job.typed, reason });
  pump();
}

// git --progress separates its updates with a bare carriage return and ends the
// last with a newline, so both have to split: newlines alone collapse a run of
// updates into one line and parse only the first of them.
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

// A line that is progress updates the job; one that is not is kept, because the
// reason a clone failed is the only line in its output that says so.
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
    if (job.state !== 'running' && job.state !== 'queued' && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

// What the page polls. The elapsed count is computed here rather than in the
// browser so a reload does not restart it.
function status(job) {
  return {
    state: job.state,
    percent: job.percent,
    reported: job.reported,
    phase: job.phase,
    detail: job.detail,
    error: job.error,
    seconds: Math.round(((job.finishedAt || Date.now()) - job.queuedAt) / 1000),
    location: `/${encodeURIComponent(job.owner)}/${encodeURIComponent(job.name)}`,
  };
}

module.exports = { validSource, start, jobFor, status, sweep, IMPORT_CONCURRENCY };