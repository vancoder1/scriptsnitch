// Reads the zip archives GitHub serves for workflow artifacts (stored and deflated entries).
import { inflateRawSync } from 'node:zlib';

// An artifact holds a snapshot and script evidence; nothing in one should inflate past these.
export function readZip(buffer, { maxEntry = 32 * 1024 * 1024, maxTotal = 256 * 1024 * 1024 } = {}) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end === -1 || end + 22 > buffer.length) throw new Error('not a zip archive');
  const count = buffer.readUInt16LE(end + 10);
  let pos = buffer.readUInt32LE(end + 16);
  if (pos === 0xffffffff || count === 0xffff) throw new Error('ZIP64 archives are not supported');
  const files = new Map();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('zip central directory is damaged');
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const size = buffer.readUInt32LE(pos + 20);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const local = buffer.readUInt32LE(pos + 42);
    const name = buffer.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new Error(`zip entry ${name} is encrypted`);
    if (name.endsWith('/')) continue;
    const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(dataStart, dataStart + size);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = inflateRawSync(raw, { maxOutputLength: maxEntry }); } catch (e) { throw e instanceof RangeError ? new Error(`zip entry ${name} is too large`) : e; }
    } else throw new Error(`zip entry ${name} uses unsupported compression ${method}`);
    if (data.length > maxEntry) throw new Error(`zip entry ${name} is too large`);
    total += data.length;
    if (total > maxTotal) throw new Error('zip archive is too large');
    files.set(name, data);
  }
  return files;
}
