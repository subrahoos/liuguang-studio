import { createReadStream } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  return crc >>> 0;
});

export function zipSizeUpperBound(files: Array<{ size: number }>) {
  // A 180 UTF-16-unit name can require up to 540 UTF-8 bytes, twice per entry.
  return 22 + files.reduce((sum, item) => sum + item.size + 1200, 0);
}

// ZIP STORE + data descriptors: bounded memory, no temporary archive or shell.
export async function* streamZip(files: Array<{ path: string; name: string; size: number }>) {
  if (files.length > 65535 || zipSizeUpperBound(files) > 0xffffffff) throw new Error("批次过大，请按类型或分批下载。");
  const central: Buffer[] = [];
  let offset = 0;
  for (const [index, file] of files.entries()) {
    const name = Buffer.from(`${String(index + 1).padStart(3, "0")}-${file.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 180)}`, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x808, 6); // UTF-8 and trailing descriptor
    header.writeUInt16LE(33, 12); // 1980-01-01
    header.writeUInt16LE(name.length, 26);
    const initialOffset = offset;
    yield header; yield name;
    offset += header.length + name.length;
    let crc = 0xffffffff;
    let size = 0;
    for await (const chunk of createReadStream(file.path)) {
      const bytes = chunk as Buffer;
      for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
      size += bytes.length;
      if (size > file.size) throw new Error("下载期间文件发生变化，请重试。");
      yield bytes;
      offset += bytes.length;
    }
    if (size !== file.size) throw new Error("结果文件不完整，请检查后重试。");
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    yield descriptor; offset += descriptor.length;
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x808, 8); entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(size, 20); entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(initialOffset, 42);
    central.push(entry, name);
  }
  const centralStart = offset;
  for (const entry of central) { yield entry; offset += entry.length; }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(offset - centralStart, 12); end.writeUInt32LE(centralStart, 16);
  yield end;
}
