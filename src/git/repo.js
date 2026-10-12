// A bare repository on disk: ref storage, object lookup that spans loose
// files and packs, tree and commit walks, and the on-disk size figure used
// for the 100MB ceiling.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const {
  TYPE_CODES,
  readLoose,
  writeLoose,
  parseTree,
  parseCommit,
  parseTag,
  hashObject,
} = require('./objects');
const {
  parsePack,
  encodeObjectHeader,
  readIdx,
  listPackFiles,
  readObjectHeader,
  readOfsDeltaOffset,
  inflateAt,
  applyDelta,
  OBJ_OFS_DELTA,
  OBJ_REF_DELTA,
  MAX_DELTA_DEPTH,
} = require('./pack');
const { ZERO_SHA } = require('../config');

const DEFAULT_BRANCH = 'main';

// Pack indexes are read per push and per fetch. Caching them keeps repeated
// clones from re-reading a multi megabyte index, and the cache is dropped
// whenever a repository gains or loses a pack file. Bounded because the key is
// a repository directory and a busy server touches a lot of them.
const packCache = new Map();
const MAX_CACHED_PACK_DIRS = 64;

function touchPackCache(dir, value) {
  packCache.delete(dir);
  packCache.set(dir, value);
  while (packCache.size > MAX_CACHED_PACK_DIRS) {
    const oldest = packCache.keys().next().value;
    closePackHandles(packCache.get(oldest)?.indexes || []);
    packCache.delete(oldest);
  }
}

function init(dir) {
  fs.mkdirSync(path.join(dir, 'objects', 'info'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'objects', 'pack'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'refs', 'heads'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'refs', 'tags'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'HEAD'), `ref: refs/heads/${DEFAULT_BRANCH}\n`);
  fs.writeFileSync(
    path.join(dir, 'config'),
    ['[core]', '\trepositoryformatversion = 0', '\tfilemode = false', '\tbare = true', ''].join('\n')
  );
  fs.writeFileSync(path.join(dir, 'description'), 'SAREit repository\n');
  packCache.delete(dir);
}

function exists(dir) {
  try {
    return fs.statSync(path.join(dir, 'HEAD')).isFile();
  } catch {
    return false;
  }
}

// Packfile data is read by offset. Reading the whole file for every object
// turns one commit lookup on a 50MB pack into 50MB of I/O, so a window is read
// instead and grown until the object inflates. Most objects need the first
// window; a large blob needs a window sized to it and nothing more.
const FIRST_WINDOW = 256 * 1024;
const MAX_WINDOW = 96 * 1024 * 1024;
const packHandles = new Map();

// One descriptor per packfile, opened once and reused. Opening it twice, once
// for the read and once for the size, leaks the second one on every call:
// enough clones and the process runs out of descriptors, which surfaces as an
// EMFILE throw part way through serving a clone.
function packHandle(packPath) {
  let handle = packHandles.get(packPath);
  if (handle) return handle;
  const fd = fs.openSync(packPath, 'r');
  try {
    handle = { fd, size: fs.fstatSync(fd).size };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
  packHandles.set(packPath, handle);
  return handle;
}

function openPackCount() {
  return packHandles.size;
}

function readPackWindow(packPath, offset, length) {
  const handle = packHandle(packPath);
  const want = Math.max(0, Math.min(length, handle.size - offset));
  const buf = Buffer.allocUnsafe(want);
  let got = 0;
  while (got < want) {
    const n = fs.readSync(handle.fd, buf, got, want - got, offset + got);
    if (n <= 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

// Reads and inflates one object, growing the window until the deflate stream
// ends inside it or the packfile does.
function readPackObjectData(packPath, start) {
  const handle = packHandle(packPath);
  let window = FIRST_WINDOW;
  for (;;) {
    const slice = readPackWindow(packPath, start, window);
    if (!slice.length) throw new Error('pack offset past end of file');
    try {
      return inflateAt(slice, 0).data;
    } catch (err) {
      if (start + slice.length >= handle.size || window >= MAX_WINDOW) throw err;
      window = Math.min(window * 4, MAX_WINDOW);
    }
  }
}

function closePackHandles(indexes) {
  for (const entry of indexes) {
    const handle = packHandles.get(entry.packPath);
    if (!handle) continue;
    packHandles.delete(entry.packPath);
    try {
      fs.closeSync(handle.fd);
    } catch {
      // Already closed.
    }
  }
}

function closePacks() {
  for (const handle of packHandles.values()) {
    try {
      fs.closeSync(handle.fd);
    } catch {
      // Already closed.
    }
  }
  packHandles.clear();
  packCache.clear();
}

function packIndexCache(dir) {
  const names = listPackFiles(dir);
  const cached = packCache.get(dir);
  if (cached && cached.names.join(',') === names.join(',')) {
    touchPackCache(dir, cached);
    return cached.indexes;
  }
  const indexes = [];
  for (const name of names) {
    const stem = name.slice(0, -4);
    let index;
    try {
      index = readIdx(fs.readFileSync(path.join(dir, 'objects', 'pack', name)));
    } catch (err) {
      console.error(`SAREit skipping unreadable pack index ${stem}: ${err.message}`);
      continue;
    }
    indexes.push({ stem, index, packPath: path.join(dir, 'objects', 'pack', `${stem}.pack`) });
  }
  touchPackCache(dir, { names, indexes });
  return indexes;
}

// Reads one object out of a packfile by offset. The header is small, but the
// deflate stream after it is whatever the object happens to weigh, so the read
// window has to be able to grow to cover a whole large blob.
function readObjectFromPack(entry, dir, depth) {
  if (depth > MAX_DELTA_DEPTH) throw new Error('pack delta chain too deep');
  let header;
  try {
    header = readPackWindow(entry.packPath, entry.offset, FIRST_WINDOW);
  } catch {
    return null;
  }
  if (header.length < 2) return null;

  const head = readObjectHeader(header, 0);
  let pos = head.pos;
  let baseSha = null;
  let baseOffset = null;
  if (head.type === OBJ_OFS_DELTA) {
    const ofs = readOfsDeltaOffset(header, pos);
    pos = ofs.pos;
    baseOffset = entry.offset - ofs.offset;
  } else if (head.type === OBJ_REF_DELTA) {
    if (pos + 20 > header.length) throw new Error('pack truncated in delta base id');
    baseSha = header.toString('hex', pos, pos + 20);
    pos += 20;
  }
  const data = readPackObjectData(entry.packPath, entry.offset + pos);

  if (baseSha === null && baseOffset === null) {
    const types = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
    const type = types[head.type];
    if (!type) throw new Error(`unknown object type ${head.type} in pack`);
    return { type, body: data };
  }
  let base = null;
  if (baseOffset !== null) {
    for (const candidate of packIndexCache(dir)) {
      base = readObjectFromPack({ ...candidate, offset: baseOffset }, dir, depth + 1);
      if (base) break;
    }
  }
  if (!base && baseSha) base = readObject(dir, baseSha, depth + 1);
  if (!base) throw new Error(`delta base ${baseSha || baseOffset} missing from pack ${entry.stem}`);
  return { type: base.type, body: applyDelta(base.body, data) };
}

function readObject(dir, sha, depth = 0) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  const loose = readLoose(dir, sha);
  if (loose) return loose;
  if (depth > MAX_DELTA_DEPTH) return null;
  for (const entry of packIndexCache(dir)) {
    const offset = entry.index.find(sha);
    if (offset === null) continue;
    try {
      return readObjectFromPack({ ...entry, offset }, dir, depth + 1);
    } catch (err) {
      console.error(`SAREit could not read ${sha} from pack ${entry.stem}: ${err.message}`);
      return null;
    }
  }
  return null;
}

function hasObject(dir, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) return false;
  if (fs.existsSync(path.join(dir, 'objects', sha.slice(0, 2), sha.slice(2)))) return true;
  return packIndexCache(dir).some((entry) => entry.index.find(sha) !== null);
}

function readRefFile(dir, ref) {
  try {
    return fs.readFileSync(path.join(dir, ref), 'utf8').trim();
  } catch {
    return null;
  }
}

function packedRefs(dir) {
  const refs = new Map();
  let text;
  try {
    text = fs.readFileSync(path.join(dir, 'packed-refs'), 'utf8');
  } catch {
    return refs;
  }
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    refs.set(line.slice(space + 1).trim(), line.slice(0, space).trim());
  }
  return refs;
}

function walkRefDir(dir, base, prefix, out) {
  let names;
  try {
    names = fs.readdirSync(path.join(dir, base), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of names) {
    const ref = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walkRefDir(dir, `${base}/${entry.name}`, ref, out);
    else out.set(ref, readRefFile(dir, ref));
  }
}

// Loose refs win over packed refs, same as git.
function listRefs(dir) {
  const refs = packedRefs(dir);
  walkRefDir(dir, 'refs', 'refs', refs);
  const clean = new Map();
  for (const [ref, sha] of refs) if (sha && sha !== ZERO_SHA) clean.set(ref, sha);
  return clean;
}

function headRef(dir) {
  const raw = (readRefFile(dir, 'HEAD') || '').trim();
  return raw.startsWith('ref: ') ? raw.slice(5).trim() : null;
}

function setHeadRef(dir, ref) {
  fs.writeFileSync(path.join(dir, 'HEAD'), `ref: ${ref}\n`);
}

// The branch the code page should show. HEAD is the answer when it names a
// branch that exists. A repository imported or pushed from a client whose
// default branch was not main can have a HEAD pointing at nothing, and a
// repository whose main was deleted can as well, so the first branch present
// stands in rather than leaving the page empty.
function defaultBranch(dir) {
  const head = headRef(dir);
  if (head && resolveRefName(dir, head)) return head;
  const list = branches(dir);
  if (!list.length) return head;
  const main = list.find((branch) => branch.name === 'main');
  return `refs/heads/${(main || list[0]).name}`;
}

function resolveRefName(dir, ref) {
  let current = ref;
  for (let hops = 0; hops < 10; hops++) {
    const value = readRefFile(dir, current) ?? listRefs(dir).get(current);
    if (value === null || value === undefined) return null;
    if (value.startsWith('ref: ')) {
      current = value.slice(5).trim();
      continue;
    }
    return /^[0-9a-f]{40}$/.test(value) ? value : null;
  }
  return null;
}

// Accepts a sha, a full ref name, HEAD, a branch or tag name, and any unique
// sha prefix of 7 characters or more.
function resolveRevision(dir, rev) {
  if (!rev) return null;
  if (rev === 'HEAD') {
    const head = headRef(dir);
    const viaHead = head ? resolveRefName(dir, head) : null;
    if (viaHead) return viaHead;
    // HEAD naming a branch that does not exist is normal on a repository
    // whose first push used a different default branch name. Fall through to
    // whatever branch is there rather than reporting an empty repository.
    const fallback = defaultBranch(dir);
    return fallback ? resolveRefName(dir, fallback) : null;
  }
  if (/^[0-9a-f]{40}$/.test(rev)) return hasObject(dir, rev) ? rev : null;
  if (rev.startsWith('refs/')) return resolveRefName(dir, rev);

  const refs = listRefs(dir);
  for (const candidate of [`refs/heads/${rev}`, `refs/tags/${rev}`, `refs/remotes/${rev}`]) {
    const sha = resolveRefName(dir, candidate);
    if (sha) return sha;
  }

  const needle = rev.toLowerCase();
  if (needle.length >= 7 && /^[0-9a-f]+$/.test(needle)) {
    let found = null;
    for (const sha of looseObjectShas(dir)) {
      if (!sha.startsWith(needle)) continue;
      if (found) return null;
      found = sha;
    }
    if (found) return found;
  }
  return null;
}

// Abbreviated sha lookup only scans loose objects. Packed objects would need
// a per sha index walk that nothing on this site links to.
function looseObjectShas(dir) {
  const shas = [];
  let fanout;
  try {
    fanout = fs.readdirSync(path.join(dir, 'objects'), { withFileTypes: true });
  } catch {
    return shas;
  }
  for (const entry of fanout) {
    if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue;
    for (const name of fs.readdirSync(path.join(dir, 'objects', entry.name))) {
      if (/^[0-9a-f]{38}$/.test(name)) shas.push(entry.name + name);
    }
  }
  return shas;
}

function branches(dir) {
  const refs = listRefs(dir);
  const out = [];
  for (const [ref, sha] of refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({ name: ref.slice('refs/heads/'.length), sha });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function tags(dir) {
  const refs = listRefs(dir);
  const out = [];
  for (const [ref, sha] of refs) {
    if (!ref.startsWith('refs/tags/')) continue;
    out.push({ name: ref.slice('refs/tags/'.length), sha, target: tagTargetSha(dir, sha) || sha });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function tagTargetSha(dir, sha) {
  if (!sha) return null;
  const obj = readObject(dir, sha);
  if (!obj) return null;
  if (obj.type === 'tag') return tagTargetSha(dir, parseTag(obj.body).object);
  return sha;
}

function updateRef(dir, ref, sha) {
  const file = path.join(dir, ref);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${sha}\n`);
}

// A reflog entry per update, in git's own on-disk format at logs/<ref>:
// "<old> <new> <name> <email> <seconds> <tz>\t<message>". This is what lets a
// page say who pushed a commit as well as who wrote it, because the two are
// different people whenever a developer pushes work committed under a shared
// git identity.
function logRefUpdate(dir, ref, oldSha, newSha, who, message) {
  if (!who) return;
  const file = path.join(dir, 'logs', ref);
  const seconds = Math.floor(Date.now() / 1000);
  const zone = -new Date().getTimezoneOffset();
  const sign = zone < 0 ? '-' : '+';
  const offset = `${sign}${String(Math.floor(Math.abs(zone) / 60)).padStart(2, '0')}${String(Math.abs(zone) % 60).padStart(2, '0')}`;
  const line = `${oldSha} ${newSha} ${who} <${who}@sareit> ${seconds} ${offset}\t${message}\n`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line);
  } catch (err) {
    // The ref itself is already written. A missing reflog costs the "pushed
    // by" line on a page, which is not worth failing a push over.
    console.error(`SAREit could not append to the reflog for ${ref}: ${err.message}`);
  }
}

// The most recent entry for a ref, or null when it has no reflog.
function readReflog(dir, ref) {
  try {
    const text = fs.readFileSync(path.join(dir, 'logs', ref), 'utf8');
    const lines = text.split('\n').filter(Boolean);
    if (!lines.length) return null;
    const line = lines[lines.length - 1];
    const tab = line.indexOf('\t');
    const head = tab === -1 ? line : line.slice(0, tab);
    const parts = head.split(' ');
    // "<old> <new> <name> <email> <seconds> <tz>": the name is everything
    // between the sha and the email bracket.
    const emailAt = parts.findIndex((part, i) => i >= 3 && part.startsWith('<'));
    return {
      oldSha: parts[0],
      newSha: parts[1],
      who: emailAt > 2 ? parts.slice(2, emailAt).join(' ') : parts[2] || '',
      when: Number(parts[parts.length - 2]) * 1000,
      message: tab === -1 ? '' : line.slice(tab + 1),
      entries: lines.length,
    };
  } catch {
    return null;
  }
}

function deleteRef(dir, ref) {
  try {
    fs.unlinkSync(path.join(dir, ref));
  } catch {
    return false;
  }
  return true;
}

// Walks from commit tips and returns sha plus type for everything reachable.
// Bodies are not retained, so the 100MB ceiling does not have to fit in memory
// to build the exclusion set for a fetch.
function reachable(dir, tips) {
  const found = new Map();
  const queue = tips.filter((sha) => /^[0-9a-f]{40}$/.test(sha) && sha !== ZERO_SHA);
  while (queue.length) {
    const sha = queue.pop();
    if (found.has(sha)) continue;
    const obj = readObject(dir, sha);
    if (!obj) continue;
    found.set(sha, { type: obj.type, size: obj.body.length });
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.body);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.body).object);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.body)) queue.push(entry.sha);
    }
  }
  return found;
}

// Builds the packfile for a fetch and writes it to a temporary file, returning
// the path and its size rather than a buffer.
//
// Holding every object body in a list first, then concatenating them into one
// buffer, peaks at roughly three times the repository size for a clone of a
// repository near the 100MB ceiling, and two clones at once exhausts the heap.
// Writing each object out as it is produced keeps the peak at one object, and
// the response streams from disk.
function packForFetch(dir, wantShas, haveShas, tempDir) {
  const wanted = reachable(dir, wantShas);
  if (haveShas.length) {
    const owned = reachable(dir, haveShas);
    for (const sha of owned.keys()) wanted.delete(sha);
  }
  if (!wanted.size) return { path: null, count: 0, bytes: 0 };

  fs.mkdirSync(tempDir, { recursive: true });
  const target = path.join(tempDir, `pack-${process.pid}-${crypto.randomBytes(8).toString('hex')}.pack`);
  const fd = fs.openSync(target, 'w');
  let count = 0;
  let bytes = 0;

  try {
    const header = Buffer.alloc(12);
    header.write('PACK', 0, 4, 'latin1');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(wanted.size, 8);
    bytes += fs.writeSync(fd, header);

    // Batched so a repository with many small objects does not turn into
    // thousands of write calls. The batch is bounded, so the peak is one
    // megabyte rather than the whole pack.
    const FLUSH_AT = 1 << 20;
    let pending = [];
    let pendingBytes = 0;
    const emit = (chunk) => {
      pending.push(chunk);
      pendingBytes += chunk.length;
      if (pendingBytes < FLUSH_AT) return;
      bytes += fs.writeSync(fd, Buffer.concat(pending));
      pending = [];
      pendingBytes = 0;
    };

    for (const [sha, meta] of wanted) {
      const obj = readObject(dir, sha);
      if (!obj || obj.type !== meta.type) continue;
      emit(encodeObjectHeader(TYPE_CODES[obj.type], obj.body.length));
      emit(zlib.deflateSync(obj.body, { level: 6 }));
      count++;
    }
    for (const chunk of pending) bytes += fs.writeSync(fd, chunk);

    const digest = hashFile(target);
    bytes += fs.writeSync(fd, digest);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(target, { force: true });
    throw err;
  }
  fs.closeSync(fd);

  return { path: target, count, bytes };
}

function hashFile(file) {
  const hash = crypto.createHash('sha1');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest();
}

// Refs are written loose and never rewritten into packed-refs. Packing them
// would mean deleting the loose files, and an imported repository can carry
// symbolic refs and peeled tag lines that do not survive that round trip.
// Loose refs are what git reads first, so a repository imported from elsewhere
// keeps its original refs alongside the ones a push adds.

// Receives an incoming pack. Objects already present are skipped. headroom is
// how many more bytes this repository may hold before it reaches its ceiling.
// verify runs once every object is on disk, so a caller can apply a wider
// budget such as the per-account total; if it throws, or if the write loop
// itself fails part way, the objects this call created are deleted again and
// the repository is left exactly as it was found.
function receivePack(dir, packBuf, { limitBytes, headroomBytes, verify }) {
  const existing = new Set();
  const parseLookup = (sha) => {
    const obj = readObject(dir, sha);
    if (!obj) return null;
    existing.add(sha);
    return obj;
  };

  const parsed = parsePack(packBuf, parseLookup);
  const trailer = crypto.createHash('sha1').update(packBuf.subarray(0, packBuf.length - 20)).digest('hex');
  if (trailer !== parsed.trailer) throw new Error('pack checksum mismatch');

  const written = [];
  let added = 0;
  try {
    for (const entry of parsed.entries) {
      if (existing.has(entry.sha) || hasObject(dir, entry.sha)) continue;
      if (added + entry.body.length > headroomBytes) {
        throw new Error(`push would take the repository past its ${Math.round(limitBytes / 1048576)}MB limit`);
      }
      writeLoose(dir, entry.sha, entry.type, entry.body);
      written.push(entry.sha);
      added += entry.body.length;
    }
    if (verify) verify();
  } catch (err) {
    undoWrite(dir, written);
    throw err;
  }
  return { thin: parsed.thin, written, count: parsed.entries.length, newObjects: written.length };
}

function undoWrite(dir, shas) {
  for (const sha of shas) {
    try {
      fs.unlinkSync(path.join(dir, 'objects', sha.slice(0, 2), sha.slice(2)));
    } catch {
      // Already gone.
    }
  }
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        total += fs.statSync(full).size;
      } catch {
        continue;
      }
    }
  }
  return total;
}

function walkPath(dir, treeSha, parts) {
  let sha = treeSha;
  const trail = [];
  for (const part of parts) {
    if (!part) continue;
    const obj = readObject(dir, sha);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.body).find((item) => item.name === part);
    if (!entry) return null;
    trail.push(entry);
    sha = entry.sha;
  }
  const obj = readObject(dir, sha);
  return { sha, type: obj ? obj.type : null, body: obj ? obj.body : null, trail };
}

function readTreeEntries(dir, treeSha) {
  const obj = readObject(dir, treeSha);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.body)
    .map((entry) => {
      const isTree = entry.mode === '40000' || entry.mode === '040000';
      return {
        name: entry.name,
        sha: entry.sha,
        mode: entry.mode,
        isTree,
        isSymlink: entry.mode === '120000',
        isSubmodule: entry.mode === '160000',
      };
    })
    .sort((a, b) => {
      if (a.isTree !== b.isTree) return a.isTree ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

// Full history walk sorted by commit date, newest first. maxCommits bounds how
// many commit objects are read: a repository with a very deep ancestry would
// otherwise spend unbounded time and file descriptors on a page that shows a
// few dozen rows. The bound is reported through truncated so the view can say
// so rather than quietly showing a partial history.
const MAX_HISTORY_READ = 4000;

function history(dir, tipSha, limit, maxCommits = MAX_HISTORY_READ) {
  const seen = new Set();
  const collected = [];
  const queue = [{ sha: tipSha, depth: 0 }];
  while (queue.length && seen.size < maxCommits) {
    const { sha, depth } = queue.shift();
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = readObject(dir, sha);
    if (!obj || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.body);
    collected.push({
      sha,
      // Consumers that walk snapshots need the tree each commit points at.
      // Leaving it out made every snapshot read back as empty, which is silent:
      // the walk had nothing to compare and reported nothing.
      tree: commit.tree,
      subject: commit.message.split('\n', 1)[0].trim(),
      author: commit.author,
      committer: commit.committer,
      parents: commit.parents,
      depth,
    });
    for (const parent of commit.parents) queue.push({ sha: parent, depth: depth + 1 });
  }
  collected.sort((a, b) => b.committer.when - a.committer.when);
  const truncated = queue.length > 0;
  return { commits: limit ? collected.slice(0, limit) : collected, truncated };
}

// The last commit that touched each entry of a directory.
//
// The answer has to come from history rather than from the reflog, because a
// repository created before reflogs existed has none, and the point of this is
// that old repositories show the same column as new ones.
//
// Each commit is diffed against its own first parent, so a commit is credited
// only with what it actually changed, and commits are visited newest first so
// the first answer found for an entry is the most recent one. The walk stops
// as soon as every entry currently in the tree has an answer, so a stable
// directory costs one commit rather than the whole history.
//
// Two cases have no commit to compare against and are handled explicitly: the
// root commit, which has no parent, and any commit still unexplained when the
// bound cuts the walk short. Those entries are left out and the view renders
// them as unrecorded rather than pointing at the wrong commit.
const LAST_COMMIT_BOUND = 20000;

function lastCommitsForTree(dir, tipSha, prefixParts) {
  const cacheKey = `${dir}\0${prefixParts.join('/')}\0${tipSha}`;
  const cached = lastCommitCache.get(cacheKey);
  if (cached) return cached;

  const { commits, truncated } = history(dir, tipSha, 0, LAST_COMMIT_BOUND);
  // Anchored to the commit that was asked for rather than to the first one the
  // walk returned. History is ordered by commit time, and commits written in
  // the same second tie, so the tip is not guaranteed to sort first. Landing on
  // the wrong commit here would make wanted describe a different directory, and
  // an empty one ends the walk before it starts.
  const tipCommit = commits.find((commit) => commit.sha === tipSha) || commits[0];
  const wanted = new Set(snapshotTree(dir, tipCommit ? tipCommit.tree : null, prefixParts).keys());
  const found = new Map();

  // Each commit is compared against its own first parent and credited with what
  // that comparison shows. Comparing neighbouring snapshots instead is off by
  // one: the difference between two snapshots is the change made by the newer of
  // the two, so crediting the older one dates every file a commit too early.
  const firstParentTree = (commit) =>
    commit.parents.length ? treeOfCommit(dir, commit.parents[0]) : null;

  for (const commit of commits) {
    const snapshot = snapshotTree(dir, commit.tree, prefixParts);
    const parentTree = firstParentTree(commit);
    // The root commit has no parent to compare against. Whatever it created and
    // nothing touched afterwards is handled by the oldest-commit pass below.
    if (parentTree !== null) {
      const before = snapshotTree(dir, parentTree, prefixParts);
      for (const [name, sha] of snapshot) {
        if (before.get(name) !== sha && !found.has(name)) {
          found.set(name, { sha: commit.sha, subject: commit.subject });
        }
      }
      for (const name of before.keys()) {
        if (!snapshot.has(name) && !found.has(name)) {
          found.set(name, { sha: commit.sha, subject: commit.subject });
        }
      }
    }
    if (found.size >= wanted.size) break;
  }

  // A commit is credited with a change only when it differs from its parent, so
  // the files the oldest commit created and nothing has touched since carry the
  // same sha in every snapshot and no comparison ever fires for them. They used
  // to render as unrecorded. When the walk reached the start of the history that
  // oldest commit is not a guess: it is where those files were written. When the
  // walk was cut short by the bound the true answer may be further back, so
  // those stay unrecorded rather than being handed a commit that may not be the
  // one that touched them.
  if (!truncated) {
    const oldest = commits[commits.length - 1];
    if (oldest) {
      for (const name of wanted) {
        if (!found.has(name)) found.set(name, { sha: oldest.sha, subject: oldest.subject });
      }
    }
  }

  if (lastCommitCache.size >= 64) {
    lastCommitCache.delete(lastCommitCache.keys().next().value);
  }
  lastCommitCache.set(cacheKey, found);
  return found;
}

function treeOfCommit(dir, commitSha) {
  const obj = readObject(dir, commitSha);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.body).tree;
}

const lastCommitCache = new Map();

function snapshotTree(dir, treeSha, parts) {
  const entries = new Map();
  let sha = treeSha;
  for (const part of parts) {
    if (!part) continue;
    const obj = readObject(dir, sha);
    if (!obj || obj.type !== 'tree') return entries;
    const hit = parseTree(obj.body).find((item) => item.name === part);
    if (!hit) return entries;
    sha = hit.sha;
  }
  const obj = readObject(dir, sha);
  if (!obj || obj.type !== 'tree') return entries;
  for (const item of parseTree(obj.body)) entries.set(item.name, item.sha);
  return entries;
}

module.exports = {
  DEFAULT_BRANCH,
  init,
  exists,
  readObject,
  hasObject,
  listRefs,
  headRef,
  setHeadRef,
  defaultBranch,
  resolveRefName,
  resolveRevision,
  branches,
  tags,
  tagTargetSha,
  updateRef,
  logRefUpdate,
  readReflog,
  deleteRef,
  reachable,
  packForFetch,
  receivePack,
  undoWrite,
  dirSize,
  walkPath,
  readTreeEntries,
  history,
  lastCommitsForTree,
  closePacks,
};
