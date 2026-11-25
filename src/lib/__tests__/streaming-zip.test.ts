import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { streamZip } from "@/lib/streaming-zip";

describe("streaming result ZIP", () => {
  it("preserves bytes, writes CRC32 and unique UTF-8 file names", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "production-zip-"));
    const file = path.join(directory, "test.txt");
    await writeFile(file, "123456789");
    const chunks: Buffer[] = [];
    for await (const chunk of streamZip([{ path: file, name: "上衣.txt", size: 9 }, { path: file, name: "上衣.txt", size: 9 }])) chunks.push(chunk);
    const archive = Buffer.concat(chunks);
    expect(archive.readUInt32LE(0)).toBe(0x04034b50);
    expect(archive.toString("utf8")).toContain("001-上衣.txt");
    expect(archive.toString("utf8")).toContain("002-上衣.txt");
    const descriptor = archive.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
    expect(archive.readUInt32LE(descriptor + 4)).toBe(0xcbf43926);
    const start = 30 + archive.readUInt16LE(26);
    expect(archive.subarray(start, start + 9)).toEqual(await readFile(file));
    expect(archive.readUInt16LE(archive.length - 22 + 10)).toBe(2);
  });
  it("rejects ZIP32 overflow before reading files", async () => {
    const iterator = streamZip([{ path: "not-read", name: "large", size: 0xffffffff }]);
    await expect(iterator.next()).rejects.toThrow("批次过大");
  });
});
