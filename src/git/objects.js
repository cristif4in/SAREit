// Git object encoding and loose object storage. A loose object is
// zlib("<type> <size>\0" + body) at objects/<2 hex>/<38 hex>.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const TYPE_CODES = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest();
}

function hashObject(type, body) {
  const header = Buffer.from(`${type} ${body.length}\0`);
  return sha1(Buffer.concat([header, body]));
}

function objectPath(dir, sha) {
  return path.join(dir, 'objects', sha.slice(0, 2), sha.slice(2));
}

function readLoose(dir, sha) {
  let raw;
  try {
    raw = fs.readFileSync(objectPath(dir, sha));
  } catch {
    return null;
  }
  let data;
  try {
    data = zlib.inflateSync(raw);
  } catch {
    return null;
  }
  const nul = data.indexOf(0);
  if (nul < 0) return null;
  const header = data.toString('latin1', 0, nul);
  const space = header.indexOf(' ');
  if (space < 0) return null;
  return { type: header.slice(0, space), body: data.subarray(nul + 1) };
}

// Temp name then rename, matching what git does so a reader never sees a
// half written object.
function writeLoose(dir, sha, type, body) {
  const dest = objectPath(dir, sha);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const framed = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
  const tmp = `${dest}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, zlib.deflateSync(framed, { level: 6 }));
  fs.renameSync(tmp, dest);
  return dest;
}

function parseTree(body) {
  const entries = [];
  let pos = 0;
  while (pos < body.length) {
    const space = body.indexOf(0x20, pos);
    if (space < 0) break;
    const nul = body.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > body.length) break;
    entries.push({
      mode: body.toString('latin1', pos, space),
      name: body.toString('utf8', space + 1, nul),
      sha: body.toString('hex', nul + 1, nul + 21),
    });
    pos = nul + 21;
  }
  return entries;
}

function parseIdent(raw) {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(raw);
  if (!match) return { name: raw, email: '', when: 0, tz: '+0000' };
  return { name: match[1], email: match[2], when: Number(match[3]) * 1000, tz: match[4] };
}

function parseCommit(body) {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const commit = {
    tree: null,
    parents: [],
    author: { name: '', email: '', when: 0, tz: '+0000' },
    committer: { name: '', email: '', when: 0, tz: '+0000' },
    message: split === -1 ? '' : text.slice(split + 2),
  };
  for (const line of header.split('\n')) {
    // Continuation lines belong to the previous field, gpgsig being the one
    // that shows up in practice.
    if (line.startsWith(' ')) continue;
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = parseIdent(line.slice(7));
    else if (line.startsWith('committer ')) commit.committer = parseIdent(line.slice(10));
  }
  return commit;
}

function parseTag(body) {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const tag = { object: null, type: null, tag: null, tagger: null, message: split === -1 ? '' : text.slice(split + 2) };
  for (const line of header.split('\n')) {
    if (line.startsWith(' ')) continue;
    if (line.startsWith('object ')) tag.object = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tag.tagger = parseIdent(line.slice(7));
  }
  return tag;
}

function commitSummary(commit) {
  const subject = commit.message.split('\n', 1)[0].trim();
  return {
    sha: null,
    subject,
    message: commit.message,
    author: commit.author,
    committer: commit.committer,
    parents: commit.parents,
    tree: commit.tree,
  };
}

function isBinary(body) {
  const window = body.subarray(0, 8000);
  return window.includes(0);
}

module.exports = {
  TYPE_CODES,
  CODE_TYPES,
  hashObject,
  readLoose,
  writeLoose,
  parseTree,
  parseCommit,
  parseTag,
  commitSummary,
  isBinary,
};
