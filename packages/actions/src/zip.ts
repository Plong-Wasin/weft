import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry { name: string; data: Uint8Array }

const maxZip32 = 0xffffffff;

/** DOS date and time fields of the ZIP headers (local time is not meaningful here, so UTC is used). */
function dosStamp(date: Date) {
  const year = Math.max(date.getUTCFullYear(), 1980);
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/**
 * A ZIP archive of the entries, each deflated. Plain ZIP (no ZIP64): the archive and its entries must stay under 4 GiB,
 * far above the Export size bound; over that this throws.
 */
export function createZip(entries: ZipEntry[], now = new Date()): Uint8Array {
  const stamp = dosStamp(now);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const packed = deflateRawSync(entry.data);
    const checksum = crc32(entry.data);
    if (entry.data.byteLength > maxZip32 || packed.byteLength > maxZip32) throw new Error("ZIP entry is too large");
    // Bit 11 of the flags marks the name as UTF-8.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.byteLength, 18); local.writeUInt32LE(entry.data.byteLength, 22); local.writeUInt16LE(name.byteLength, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x0800, 8); header.writeUInt16LE(8, 10);
    header.writeUInt16LE(stamp.time, 12); header.writeUInt16LE(stamp.date, 14); header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(packed.byteLength, 20); header.writeUInt32LE(entry.data.byteLength, 24); header.writeUInt16LE(name.byteLength, 28);
    header.writeUInt32LE(offset, 42);
    parts.push(local, name, packed);
    central.push(header, name);
    offset += local.byteLength + name.byteLength + packed.byteLength;
  }
  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  if (offset + centralSize > maxZip32 || entries.length > 0xffff) throw new Error("ZIP archive is too large");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}
