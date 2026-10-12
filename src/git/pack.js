// Packfile and pack index v2. Git clients always send OFS_DELTA and
// REF_DELTA objects, so the reader has to resolve both even though SAREit
// writes every object it stores as a loose object.

const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const { CODE_TYPES, TYPE_CODES, hashObject } = require('./objects');
const { MAX_OBJECT_BYTES } = require('../config');

// Pack object type codes as they appear in a packfile header.
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;

const MAX_DELTA_DEPTH = 50;

function inflateAt(buf, start) {
  // Node stops at the end of the deflate stream and leaves the bytes of the
  // next object in the input untouched. engine.bytesWritten is how much input
  // it ate, which is the only way to find the next object header.
  const result = zlib.inflateSync(buf.subarray(start), {
    info: true,
    maxOutputLength: MAX_OBJECT_BYTES,
  });
  return { data: result.buffer, end: start + result.engine.bytesWritten };
}

function readObjectHeader(buf, pos) {
  if (pos >= buf.length) throw new Error('pack truncated in object header');
  let byte = buf[pos++];
  const type = (byte >> 4) & 7;
  let size = byte & 15;
  let shift = 4;
  while (byte & 0x80) {
    if (pos >= buf.length) throw new Error('pack truncated in object header');
    byte = buf[pos++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { type, size, pos };
}

// Git's negative offset encoding: big endian with the low bit of every
// continuation byte carrying the sign of the whole number.
function readOfsDeltaOffset(buf, pos) {
  let byte = buf[pos++];
  let offset = byte & 0x7f;
  while (byte & 0x80) {
    offset += 1;
    byte = buf[pos++];
    offset = (offset << 7) | (byte & 0x7f);
  }
  return { offset, pos };
}

function readPackHeader(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'PACK') {
    throw new Error('not a pack file');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  return { version, count: buf.readUInt32BE(8) };
}

function readVarint(buf, pos) {
  let value = 0;
  let shift = 0;
  let byte;
  do {
    if (pos >= buf.length) throw new Error('delta truncated');
    byte = buf[pos++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return { value, pos };
}

function applyDelta(base, delta) {
  let pos = 0;
  const baseSize = readVarint(delta, pos);
  pos = baseSize.pos;
  const resultSize = readVarint(delta, pos);
  pos = resultSize.pos;
  if (baseSize.value !== base.length) throw new Error('delta base size does not match base object');

  const out = Buffer.allocUnsafe(resultSize.value);
  let outPos = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset |= delta[pos++];
      if (op & 0x02) copyOffset |= delta[pos++] << 8;
      if (op & 0x04) copyOffset |= delta[pos++] << 16;
      if (op & 0x08) copyOffset |= delta[pos++] << 24;
      if (op & 0x10) copySize |= delta[pos++];
      if (op & 0x20) copySize |= delta[pos++] << 8;
      if (op & 0x40) copySize |= delta[pos++] << 16;
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset < 0 || copyOffset + copySize > base.length) throw new Error('delta copy out of range');
      if (outPos + copySize > out.length) throw new Error('delta overruns its declared size');
      base.copy(out, outPos, copyOffset, copyOffset + copySize);
      outPos += copySize;
    } else if (op) {
      if (outPos + op > out.length) throw new Error('delta overruns its declared size');
      delta.copy(out, outPos, pos, pos + op);
      outPos += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (outPos !== out.length) throw new Error('delta produced the wrong number of bytes');
  return out;
}

// Splits a pack into resolved objects. lookupBase(sha) is consulted for the
// bases of a thin pack, and returns {type, body} or null.
function parsePack(buf, lookupBase) {
  const header = readPackHeader(buf);
  const entries = [];
  let pos = 12;

  for (let i = 0; i < header.count; i++) {
    const start = pos;
    const head = readObjectHeader(buf, pos);
    pos = head.pos;
    let baseSha = null;
    let baseOffset = null;
    if (head.type === OBJ_OFS_DELTA) {
      const ofs = readOfsDeltaOffset(buf, pos);
      pos = ofs.pos;
      baseOffset = start - ofs.offset;
      if (baseOffset < 12) throw new Error('ofs delta points outside the pack');
    } else if (head.type === OBJ_REF_DELTA) {
      baseSha = buf.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const inflated = inflateAt(buf, pos);
    pos = inflated.end;

    if (baseSha || baseOffset !== null) {
      entries.push({ offset: start, baseSha, baseOffset, delta: inflated.data });
    } else {
      const type = CODE_TYPES[head.type];
      if (!type) throw new Error(`unknown object type ${head.type} in pack`);
      entries.push({
        offset: start,
        type,
        body: inflated.data,
        sha: hashObject(type, inflated.data).toString('hex'),
      });
    }
  }

  const byOffset = new Map();
  const bySha = new Map();
  for (const entry of entries) {
    if (entry.sha) {
      byOffset.set(entry.offset, entry);
      bySha.set(entry.sha, entry);
    }
  }

  // A ref delta may point at an object later in the same pack, so resolution
  // is a sweep until a pass makes no progress.
  let pending = entries.filter((entry) => entry.delta);
  let thin = false;
  while (pending.length) {
    const unresolved = [];
    let progressed = false;
    for (const entry of pending) {
      let base = entry.baseOffset !== null ? byOffset.get(entry.baseOffset) : null;
      if (!base && entry.baseSha) base = bySha.get(entry.baseSha);
      if (!base && entry.baseSha && lookupBase) {
        const external = lookupBase(entry.baseSha);
        if (external) {
          base = { type: external.type, body: external.body };
          thin = true;
        }
      }
      if (!base) {
        unresolved.push(entry);
        continue;
      }
      entry.type = base.type;
      entry.body = applyDelta(base.body, entry.delta);
      entry.sha = hashObject(entry.type, entry.body).toString('hex');
      entry.delta = null;
      byOffset.set(entry.offset, entry);
      bySha.set(entry.sha, entry);
      progressed = true;
    }
    if (!progressed) {
      throw new Error(`pack has ${unresolved.length} object(s) with a missing delta base`);
    }
    pending = unresolved;
  }

  const trailer = buf.subarray(buf.length - 20);
  return { version: header.version, thin, trailer: trailer.toString('hex'), entries };
}

function encodeObjectHeader(type, size) {
  const bytes = [];
  let byte = (type << 4) | (size & 15);
  let rest = size >> 4;
  while (rest) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

// No deltas on the way out. A real clone of this repo gets a bigger pack than
// git would send, which costs bandwidth and nothing else.
function buildPack(entries) {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(entries.length, 8);
  const chunks = [head];
  for (const entry of entries) {
    chunks.push(encodeObjectHeader(TYPE_CODES[entry.type], entry.body.length));
    chunks.push(zlib.deflateSync(entry.body, { level: 6 }));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, crypto.createHash('sha1').update(body).digest()]);
}

// Index v2 only. git has written v2 by default since 1.5.4 (2007); a v1 index
// would need the 24 byte fanout variant, which no client in reach produces.
function readIdx(buf) {
  if (buf.length < 8 + 256 * 4) throw new Error('pack index truncated');
  if (buf.toString('hex', 0, 4) !== 'ff744f63') throw new Error('pack index is not version 2');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack index version ${version}`);

  const count = buf.readUInt32BE(8 + 255 * 4);
  const shaStart = 8 + 256 * 4;
  const offsetStart = shaStart + count * 20 + count * 4;
  const largeStart = offsetStart + count * 4;
  if (buf.length < largeStart) throw new Error('pack index truncated');

  const offsetFor = (index) => {
    const raw = buf.readUInt32BE(offsetStart + index * 4);
    if (!(raw & 0x80000000)) return raw;
    const large = raw & 0x7fffffff;
    if (largeStart + large * 8 + 8 > buf.length) throw new Error('pack index large offset out of range');
    return buf.readUInt32BE(largeStart + large * 8) * 2 ** 32 + buf.readUInt32BE(largeStart + large * 8 + 4);
  };

  return {
    count,
    packSha: buf.toString('hex', buf.length - 40, buf.length - 20),
    find(sha) {
      const target = Buffer.from(sha, 'hex');
      let lo = 0;
      let hi = count - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const cmp = buf.compare(target, 0, 20, shaStart + mid * 20, shaStart + mid * 20 + 20);
        if (cmp === 0) return offsetFor(mid);
        if (cmp < 0) lo = mid + 1;
        else hi = mid - 1;
      }
      return null;
    },
  };
}

function listPackFiles(dir) {
  try {
    return fs.readdirSync(`${dir}/objects/pack`).filter((name) => name.endsWith('.idx'));
  } catch {
    return [];
  }
}

module.exports = {
  OBJ_OFS_DELTA,
  OBJ_REF_DELTA,
  MAX_DELTA_DEPTH,
  parsePack,
  buildPack,
  encodeObjectHeader,
  readIdx,
  listPackFiles,
  readObjectHeader,
  readOfsDeltaOffset,
  inflateAt,
  applyDelta,
};
