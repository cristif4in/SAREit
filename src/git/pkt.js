// pkt-line framing, the length prefixed format every git wire message is
// built from. A four digit hex length counts itself, and 0000 is the flush.

const MAX_PKT = 65520;
const MAX_PAYLOAD = MAX_PKT - 4;
const FLUSH = '0000';

// The length prefix is four ASCII hex digits, not two binary bytes. 0x001e
// written as a uint16 is the byte pair 00 1e, which git reads as the two
// non-hex characters 0x00 and 0x1e and rejects as a bad line length.
function lengthHeader(payloadBytes) {
  return Buffer.from((payloadBytes + 4).toString(16).padStart(4, '0'), 'ascii');
}

function pkt(payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  if (body.length > MAX_PAYLOAD) throw new Error('pkt-line payload too large');
  return Buffer.concat([lengthHeader(body.length), body]);
}

function encodeLines(lines) {
  return Buffer.concat(lines.map((line) => pkt(`${line}\n`)));
}

function sideband(channel, data) {
  const out = [];
  for (let offset = 0; offset < data.length; offset += MAX_PAYLOAD - 1) {
    const chunk = data.subarray(offset, Math.min(offset + MAX_PAYLOAD - 1, data.length));
    out.push(lengthHeader(chunk.length + 1), Buffer.from([channel]), chunk);
  }
  return Buffer.concat(out);
}

function isFlush(buf, pos) {
  return buf[pos] === 0x30 && buf[pos + 1] === 0x30 && buf[pos + 2] === 0x30 && buf[pos + 3] === 0x30;
}

// Returns {lines, pos}. Lines keep the NUL byte that terminates a command
// line, since the capability list is separated by it.
function readLines(buf, start) {
  const lines = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    if (isFlush(buf, pos)) {
      pos += 4;
      continue;
    }
    const length = parseInt(buf.toString('ascii', pos, pos + 4), 16);
    if (!Number.isFinite(length) || length < 4 || pos + length > buf.length) break;
    lines.push(buf.toString('utf8', pos + 4, pos + length).replace(/\n$/, ''));
    pos += length;
  }
  return { lines, pos };
}

function splitCaps(line) {
  const nul = line.indexOf('\0');
  if (nul < 0) return { head: line, caps: [] };
  return { head: line.slice(0, nul), caps: line.slice(nul + 1).split(' ').filter(Boolean) };
}

function refAdvertisement(refs, caps, headRefName) {
  const capLine = [];
  if (headRefName) capLine.push(`symref=HEAD:${headRefName}`);
  capLine.push(...caps);

  const lines = [];
  let first = true;
  for (const [ref, sha] of refs) {
    if (first) {
      lines.push(pkt(`${sha} ${ref}\0${capLine.join(' ')}`));
      first = false;
    } else {
      lines.push(pkt(`${sha} ${ref}`));
    }
  }
  if (first) {
    // An empty repository. git upload-pack emits the zero sha against
    // capabilities^{} here and git clone relies on that exact shape.
    lines.push(pkt(`${'0'.repeat(40)} capabilities^{}\0${capLine.join(' ')}`));
  }
  return Buffer.concat([pkt('# service=git-upload-pack\n'), Buffer.from(FLUSH, 'ascii'), ...lines, Buffer.from(FLUSH, 'ascii')]);
}

function receivePackAdvertisement(refs, caps, headRefName) {
  const capLine = [];
  if (headRefName) capLine.push(`symref=HEAD:${headRefName}`);
  capLine.push(...caps);

  const lines = [];
  let first = true;
  for (const [ref, sha] of refs) {
    lines.push(pkt(first ? `${sha} ${ref}\0${capLine.join(' ')}` : `${sha} ${ref}`));
    first = false;
  }
  if (first) {
    lines.push(pkt(`${'0'.repeat(40)} capabilities^{}\0${capLine.join(' ')}`));
  }
  return Buffer.concat([pkt('# service=git-receive-pack\n'), Buffer.from(FLUSH, 'ascii'), ...lines, Buffer.from(FLUSH, 'ascii')]);
}

module.exports = {
  MAX_PKT,
  MAX_PAYLOAD,
  FLUSH,
  pkt,
  encodeLines,
  sideband,
  readLines,
  splitCaps,
  refAdvertisement,
  receivePackAdvertisement,
};
