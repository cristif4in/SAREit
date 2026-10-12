// A zip of a repository tree, written straight to the response.
//
// Stored rather than deflated: a compressed entry needs the whole blob before
// its compressed size is known, and this streams instead. Repositories here are
// capped at 100MB, and the blobs are already compressed inside their packfiles,
// so deflating them again buys very little.
//
// Zip64 is not implemented. A single entry over 4GB, or more than 65535 of
// them, cannot be written by this, and the storage ceiling is 100MB per
// repository, so neither is reachable here.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer, seed = 0) {
  let c = ~seed;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosDateTime(when) {
  const date = new Date(when);
  // The format cannot express anything before 1980, and the high bits are
  // treated as signed by some readers, so the floor is 1980-01-01.
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// Windows treats a path in an archive as backslash separated, and a leading
// slash or a drive letter would let an entry escape the directory it unzips
// into. Everything is rewritten to forward slashes with no leading separator.
function safeEntryName(name) {
  return name.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '').replace(/^\/+/, '');
}

class ZipWriter {
  constructor(res, prefix) {
    this.res = res;
    this.prefix = prefix;
    this.entries = [];
    this.offset = 0;
    this.checksum = 0;
    this.closed = false;
  }

  // Written straight through rather than accumulated: the peak is one blob, not
  // the whole archive.
  write(chunk) {
    if (this.closed) return false;
    this.checksum = crc32(chunk, this.checksum);
    this.offset += chunk.length;
    return this.res.write(chunk);
  }

  addFile(name, body, when) {
    if (this.closed) return;
    const entryName = Buffer.from(safeEntryName(`${this.prefix}/${name}`), 'utf8');
    const { time, day } = dosDateTime(when);
    const crc = crc32(body);
    const localOffset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(entryName.length, 26);
    header.writeUInt16LE(0, 28);

    this.write(header);
    this.write(entryName);
    this.write(body);

    this.entries.push({ name: entryName, crc, size: body.length, time, day, offset: localOffset });
  }

  // An empty directory is an entry with no body, which is how a reader is told
  // to create it. Git records no empty directories, so these only appear where
  // the walk made one.
  addDirectory(name, when) {
    if (this.closed) return;
    const entryName = Buffer.from(`${safeEntryName(`${this.prefix}/${name}`)}/`, 'utf8');
    const { time, day } = dosDateTime(when);
    const localOffset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(0, 14);
    header.writeUInt32LE(0, 18);
    header.writeUInt32LE(0, 22);
    header.writeUInt16LE(entryName.length, 26);
    header.writeUInt16LE(0, 28);

    this.write(header);
    this.write(entryName);

    this.entries.push({ name: entryName, crc: 0, size: 0, time, day, offset: localOffset });
  }

  // The central directory is the index a reader uses to seek, so it cannot be
  // streamed and is the one part held whole. It is 46 bytes per entry.
  close() {
    if (this.closed) return;
    this.closed = true;

    const directory = [];
    let size = 0;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.day, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.size, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt32LE(entry.offset, 42);
      directory.push(header, entry.name);
      size += header.length + entry.name.length;
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(this.offset, 16);

    this.res.write(Buffer.concat([...directory, end]));
    this.res.end();
  }
}

module.exports = { ZipWriter, crc32, safeEntryName };