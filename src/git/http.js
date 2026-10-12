// Smart HTTP git protocol. Two services share one pair of routes:
// git-upload-pack for fetch and clone, git-receive-pack for push.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const auth = require('../auth');
const accounts = require('../accounts');
const security = require('../security');
const storage = require('../storage');
const repo = require('./repo');
const pkt = require('./pkt');
const { ZERO_SHA, MAX_PUSH_BYTES, MAX_REPO_BYTES, DATA_DIR } = require('../config');

const AGENT = 'agent=sareit/1.0';
const UPLOAD_CAPS = ['side-band-64k', 'ofs-delta', AGENT];
const RECEIVE_CAPS = [
  'report-status',
  'delete-refs',
  'side-band-64k',
  'ofs-delta',
  'thin-pack',
  'agent=sareit/1.0',
];

const NO_CACHE = ['no-cache', 'max-age=0', 'must-revalidate'];

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { httpStatus: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// git labels a compressed push body gzip but writes a raw deflate stream,
// which older clients still do. Try each framing rather than guessing.
function maybeDecompress(req, body) {
  const encoding = String(req.headers['content-encoding'] || '').toLowerCase();
  if (!encoding || encoding === 'identity') return body;
  const attempts = [zlib.gunzipSync, zlib.inflateSync, zlib.inflateRawSync];
  for (const attempt of attempts) {
    try {
      return attempt(body, { maxOutputLength: MAX_PUSH_BYTES });
    } catch {
      continue;
    }
  }
  throw Object.assign(new Error(`unsupported request Content-Encoding: ${encoding}`), { httpStatus: 415 });
}

function send(res, status, contentType, body, extraHeaders = {}) {
  const headers = {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Pragma': 'no-cache',
    'Cache-Control': NO_CACHE.join(', '),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

function challenge(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="SAREit"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('Authentication required\n');
}

// Where packfiles are built. It sits next to the data so a clone of a
// repository near the storage ceiling has room for a temporary copy of it.
const PACK_TEMP_DIR = path.join(DATA_DIR, 'tmp');

// Sends the negotiation lines and then the packfile itself, reading the file
// in fixed chunks. Nothing here holds the pack in memory, so the peak is one
// chunk regardless of repository size.
//
// Content-Length is computed from the same loop that does the writing rather
// than predicted from the pack size. Predicting it means modelling how the
// sideband chunker splits each read, and getting that off by one byte is a
// client that waits forever for a body that has already ended.
// Streams the packfile. No Content-Length: sideband framing means the bytes on
// the wire are not the bytes in the file, and computing the length up front
// means modelling how the chunker splits every read. Being one byte out is a
// client that waits forever on a body that has already ended, which is exactly
// what a hung clone looks like. Chunked encoding has no such arithmetic.
async function sendPack(res, preamble, pack, useSideband) {
  const READ_CHUNK = 1 << 18;
  const SIDE = pkt.MAX_PAYLOAD - 1;

  res.writeHead(200, {
    'Content-Type': 'application/x-git-upload-pack-result',
    'Pragma': 'no-cache',
    'Cache-Control': NO_CACHE.join(', '),
  });

  const fd = fs.openSync(pack.path, 'r');
  try {
    if (!(await write(res, preamble))) await once(res, 'drain');

    const buf = Buffer.allocUnsafe(READ_CHUNK);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, READ_CHUNK, null);
      if (n <= 0) break;
      if (!useSideband) {
        if (!(await write(res, n === buf.length ? buf : Buffer.from(buf.subarray(0, n))))) await once(res, 'drain');
        continue;
      }
      for (let offset = 0; offset < n; offset += SIDE) {
        const framed = pkt.sideband(1, buf.subarray(offset, Math.min(offset + SIDE, n)));
        if (!(await write(res, framed))) await once(res, 'drain');
      }
    }
    if (useSideband) await write(res, Buffer.from(pkt.FLUSH, 'ascii'));
    res.end();
  } catch (err) {
    // A client that walks away mid-clone lands here. The connection is torn
    // down rather than closed cleanly, which is what git expects when a
    // transfer does not complete.
    console.error(`SAREit pack transfer ended early: ${err.message}`);
    res.destroy();
  } finally {
    fs.closeSync(fd);
    // The temporary pack has to go even when the client hung up, or repeated
    // aborted clones fill the disk.
    fs.rmSync(pack.path, { force: true });
  }
}

function write(res, chunk) {
  if (res.destroyed || res.writableEnded) throw new Error('client closed the connection');
  return res.write(chunk);
}

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once('error', reject);
    emitter.once('close', () => reject(new Error('client closed the connection')));
  });
}

function fail(res, status, message) {
  send(res, status, 'text/plain; charset=utf-8', Buffer.from(`${message}\n`, 'utf8'));
}

// The git protocol authenticates with HTTP Basic only. A session cookie is
// deliberately ignored here even when one is present: a git client never has
// a reason to send one, and letting a cookie stand in for Basic would mean a
// cookie copied out of a browser could be used to push. The web UI is the
// other way round and never reads a Basic header, so neither channel can be
// used on the other's routes.
async function gitViewer(req) {
  return auth.userFromBasic(req);
}

// A repository is private when its row says so; the owner is the only writer.
// There are no collaborators at this size, which is the one permission SAREit
// does not implement.
async function loadTarget(req, res, owner, name, needWrite) {
  const record = storageOwnerLookup(owner, name);
  if (!record) {
    fail(res, 404, 'Repository not found');
    return null;
  }
  const viewer = await gitViewer(req);
  const isOwner = !!viewer && viewer.login.toLowerCase() === record.owner.toLowerCase();
  if (needWrite ? !isOwner : record.private && !isOwner) {
    challenge(res);
    return null;
  }
  const dir = storage.repoDir(record.owner, record.name);
  if (!repo.exists(dir)) {
    fail(res, 500, 'Repository data is missing on disk');
    return null;
  }
  return { record, viewer, dir, isOwner };
}

function storageOwnerLookup(owner, name) {
  if (!storage.validLogin(owner) || !storage.validRepoName(name)) return null;
  return accounts.getRepo(owner, name);
}

function orderedRefs(dir) {
  const refs = repo.listRefs(dir);
  const out = [];
  const head = repo.headRef(dir);
  const headSha = head ? repo.resolveRefName(dir, head) : null;
  if (head && headSha) out.push(['HEAD', headSha]);
  for (const [ref, sha] of refs) out.push([ref, sha]);
  return out;
}

async function advertise(req, res, record, service) {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    fail(res, 403, 'Dumb HTTP protocol is not supported');
    return;
  }
  const push = service === 'git-receive-pack';
  const target = await loadTarget(req, res, record.owner, record.name, push);
  if (!target) return;

  const { dir } = target;
  const head = repo.headRef(dir);
  const refs = orderedRefs(dir);
  if (head && !refs.some(([ref]) => ref === head)) {
    const sha = repo.resolveRefName(dir, head);
    if (sha) refs.push([head, sha]);
  }
  const caps = push ? RECEIVE_CAPS : UPLOAD_CAPS;
  const body = push
    ? pkt.receivePackAdvertisement(refs, caps, head)
    : pkt.refAdvertisement(refs, caps, head);
  send(res, 200, `application/x-${service}-advertisement`, body);
}

// A want line is "<sha>[ <cap>...][\0<cap>...]". Modern git puts the
// capabilities straight after the sha separated by spaces; the NUL form is
// the older upload-pack request shape. Both are accepted.
function parseWantArgs(line) {
  const { head, caps } = pkt.splitCaps(line);
  const parts = head.split(' ');
  const wants = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{40}$/.test(part)) continue;
    wants.push(part);
  }
  const inlineCaps = parts.slice(1).filter((part) => !/^[0-9a-f]{40}$/.test(part));
  return { wants, caps: [...inlineCaps, ...caps] };
}

async function uploadPack(req, res, record) {
  const target = await loadTarget(req, res, record.owner, record.name, false);
  if (!target) return;
  const { dir } = target;
  let body;
  try {
    body = maybeDecompress(req, await readBody(req, MAX_PUSH_BYTES));
  } catch (err) {
    fail(res, err.httpStatus || 400, err.message);
    return;
  }

  const { lines } = pkt.readLines(body, 0);
  const wants = [];
  const haveShas = [];
  let clientCaps = [];

  for (const line of lines) {
    if (line.startsWith('want ')) {
      const parsed = parseWantArgs(line);
      wants.push(...parsed.wants);
      // Only the first want carries the capability list. A later want without
      // one must not clear what the first one negotiated.
      if (parsed.caps.length) clientCaps = parsed.caps;
    } else if (line.startsWith('have ')) {
      const sha = line.slice(5).trim();
      if (/^[0-9a-f]{40}$/.test(sha)) haveShas.push(sha);
    } else if (line.startsWith('done')) {
      break;
    }
  }

  const useSideband = clientCaps.includes('side-band-64k');
  const realWants = wants.filter((sha) => sha !== ZERO_SHA);
  const chunks = [];

  if (!realWants.length) {
    // Clone of an empty repository. git expects a bare NAK and no pack.
    chunks.push(pkt.encodeLines(['NAK']));
    chunks.push(Buffer.from(pkt.FLUSH, 'ascii'));
    send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(chunks));
    return;
  }

  const known = realWants.filter((sha) => repo.hasObject(dir, sha));
  if (!known.length) {
    fail(res, 404, 'No matching remote ref for the requested object');
    return;
  }

  // Old protocol negotiation: one ACK for the first have we already have,
  // then wait for the client to send its flush before the pack.
  const shared = haveShas.find((sha) => repo.hasObject(dir, sha));
  chunks.push(pkt.encodeLines([shared ? `ACK ${shared}` : 'NAK']));

  let pack;
  try {
    pack = repo.packForFetch(dir, known, shared ? [shared] : [], PACK_TEMP_DIR);
  } catch (err) {
    console.error(`SAREit could not build a pack for ${record.owner}/${record.name}: ${err.message}`);
    fail(res, 500, 'Could not build packfile');
    return;
  }

  if (!pack || !pack.count) {
    chunks.push(Buffer.from(pkt.FLUSH, 'ascii'));
    send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(chunks));
    return;
  }

  // Streamed. The pack is already a file on disk from packForFetch, so
  // reading it back into one buffer would undo the point of writing it out.
  await sendPack(res, Buffer.concat(chunks), pack, useSideband);
}

function applyCommand(dir, command, report, created, pusher) {
  const { oldSha, newSha, ref } = command;
  const current = repo.resolveRefName(dir, ref) || ZERO_SHA;
  if (current !== oldSha) {
    report.push(`ng ${ref} fetch first`);
    return;
  }
  if (newSha === ZERO_SHA) {
    if (repo.deleteRef(dir, ref)) report.push(`ok ${ref}`);
    else report.push(`ng ${ref} ref does not exist`);
    return;
  }
  if (!repo.tagTargetSha(dir, newSha)) {
    report.push(`ng ${ref} missing necessary objects`);
    return;
  }
  repo.updateRef(dir, ref, newSha);
  repo.logRefUpdate(dir, ref, oldSha, newSha, pusher, `push: ${newSha.slice(0, 7)}`);
  created.push(ref);
  report.push(`ok ${ref}`);
}

async function receivePack(req, res, record) {
  const target = await loadTarget(req, res, record.owner, record.name, true);
  if (!target) return;
  const { dir } = target;
  let body;
  try {
    body = maybeDecompress(req, await readBody(req, MAX_PUSH_BYTES));
  } catch (err) {
    fail(res, err.httpStatus || 400, err.message);
    return;
  }

  const { lines, pos } = pkt.readLines(body, 0);
  const commands = [];
  let clientCaps = [];
  for (const line of lines) {
    const parsed = pkt.splitCaps(line);
    if (commands.length === 0) clientCaps = parsed.caps;
    const parts = parsed.head.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldSha: parts[0], newSha: parts[1], ref: parts[2] });
  }

  const useSideband = clientCaps.includes('side-band-64k');
  const report = [];
  const refBackup = commands.map((command) => ({
    ref: command.ref,
    current: repo.resolveRefName(dir, command.ref) || ZERO_SHA,
  }));

  if (process.env.SAREIT_TRACE) {
    console.log(`SAREit receive-pack request: ${commands.length} command(s), ${body.length - pos} pack bytes`);
  }

  let unpackStatus = 'unpack ok';
  let thin = false;
  const packBuf = body.subarray(pos);

  if (packBuf.length >= 12) {
    try {
      thin = repo.receivePack(dir, packBuf, {
        limitBytes: MAX_REPO_BYTES,
        headroomBytes: MAX_REPO_BYTES - storage.repoSize(dir),
        verify: () => {
          const over = storage.checkBudget(record.owner, record.name, 0);
          if (over) throw new Error(over);
        },
      }).thin;
    } catch (err) {
      unpackStatus = `unpack ${err.message}`;
      console.error(`SAREit unpack failed for ${record.owner}/${record.name}: ${err.message}`);
    }
  } else if (commands.some((command) => command.newSha !== ZERO_SHA)) {
    unpackStatus = 'unpack no pack received';
  }

  if (unpackStatus === 'unpack ok') {
    const created = [];
    const pusher = target.viewer ? target.viewer.login : null;
    for (const command of commands) applyCommand(dir, command, report, created, pusher);
    // A fresh repository has HEAD pointing at refs/heads/main. If the first
    // branch a client pushes is called something else, HEAD is left naming a
    // branch that does not exist, and every page that resolves HEAD reports
    // the repository as empty. Repointing it at the branch that just arrived
    // is what git does when you clone and check out the remote's default.
    const headSha = repo.headRef(dir) ? repo.resolveRefName(dir, repo.headRef(dir)) : null;
    if (!headSha && created.length) {
      const branchesCreated = created.filter((ref) => ref.startsWith('refs/heads/'));
      const chosen = branchesCreated.includes('refs/heads/main')
        ? 'refs/heads/main'
        : branchesCreated.sort()[0];
      if (chosen) {
        repo.setHeadRef(dir, chosen);
        console.log(`SAREit set ${record.owner}/${record.name} HEAD to ${chosen}`);
      }
    }
  } else {
    for (const backup of refBackup) {
      if (backup.current === ZERO_SHA) repo.deleteRef(dir, backup.ref);
      else repo.updateRef(dir, backup.ref, backup.current);
    }
    for (const command of commands) report.push(`ng ${command.ref} ${unpackStatus}`);
  }

  const responseLines = [unpackStatus, ...report];
  // report-status is: unpack-status, one line per ref, flush-pkt. That inner
  // flush is part of the report and has to be there. The sideband stream then
  // needs its own bare flush to end, matching how upload-pack closes a
  // packfile it sent. A thin pack takes one more of each.
  const framed = Buffer.concat([
    pkt.encodeLines(responseLines),
    Buffer.from(pkt.FLUSH, 'ascii'),
    thin ? Buffer.from(pkt.FLUSH, 'ascii') : Buffer.alloc(0),
  ]);
  const payload = useSideband
    ? Buffer.concat([pkt.sideband(1, framed), Buffer.from(pkt.FLUSH, 'ascii')])
    : framed;

  console.log(
    `SAREit push to ${record.owner}/${record.name}: ${commands.length} ref(s), ${unpackStatus}`
  );
  if (unpackStatus === 'unpack ok') {
    // The stored size is the catalog's; refresh it now that the bytes are in.
    storage.exactRepoSize(record.owner, record.name);
  }

  send(res, 200, 'application/x-git-receive-pack-result', payload);
}

async function handle(req, res, { owner, name, hook, searchParams }) {
  const record = storageOwnerLookup(owner, name);
  if (!record) {
    fail(res, 404, 'Repository not found');
    return;
  }

  // The git transport runs on a handful of routes an attacker can hammer, so
  // it gets a per-address request ceiling. It sits well above what a real
  // client needs for a fetch or a push.
  const gate = security.gitLimits.hit(security.clientAddress(req));
  if (!gate.ok) {
    security.audit('git rate limit', `from=${security.clientAddress(req)} path=${req.url}`);
    security.tooMany(res, gate.retryAfterMs);
    return;
  }

  if (hook === 'git-upload-pack') {
    if (req.method === 'GET' || req.method === 'POST') {
      await uploadPack(req, res, record);
    } else {
      res.setHeader('Allow', 'GET, POST');
      fail(res, 405, 'Method not allowed');
    }
    return;
  }
  if (hook === 'git-receive-pack') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      fail(res, 405, 'Method not allowed');
    } else {
      await receivePack(req, res, record);
    }
    return;
  }
  await advertise(req, res, record, searchParams.get('service'));
}

module.exports = { handle, readBody };
