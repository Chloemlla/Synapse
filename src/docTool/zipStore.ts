// 内置 ZIP 打包器：只服务「把成功产物打包下载」这一个场景。
//
// 为什么不引第三方库（archiver / yazip / adm-zip）：仓库依赖面已经很宽，
// 而这里需要的只是「deflate + 正确的头 + 中央目录 + EOCD」，Node 自带 zlib 就够；
// 新增依赖还要走 AGENTS.md §7 的锁文件重生成通路（两轮 CI），不值得。
//
// 只实现 ZIP 的**写**（不需要解压），且只支持 deflate 与 store 两种方式、无 zip64：
// 单次打包上限由调用方通过 maxTotalBytes 约束（默认 256 MB），超过时停止追加并置 truncated。
import fs from "node:fs";
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

/** CRC32（IEEE）。公开校验向量：crc32("123456789") === 0xcbf43926。 */
export function crc32(buf: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** DOS 时间/日期字段（ZIP 规范只支持 1980-2107 且精度 2 秒）。 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  const safe = year < 1980 ? new Date(1980, 0, 1) : date;
  const time =
    (safe.getHours() << 11) | (safe.getMinutes() << 5) | Math.floor(safe.getSeconds() / 2);
  const dosDate = ((safe.getFullYear() - 1980) << 9) | ((safe.getMonth() + 1) << 5) | safe.getDate();
  return { time, date: dosDate };
}

export interface ZipEntryInput {
  /** 压缩包内的名字（posix 相对路径） */
  name: string;
  /** 源文件绝对路径 */
  sourcePath: string;
}

export interface ZipBuildResult {
  buffer: Buffer;
  /** 实际写入的条目数 */
  entries: number;
  /** 条目原始字节合计（未压缩） */
  bytes: number;
  /** 因超出上限或读不到源文件而跳过的条目数 */
  skipped: number;
  truncated: boolean;
}

/**
 * 生成一个 zip 内存缓冲。读不到/读失败的文件跳过（打包下载是尽力而为，不该因为一个产物被删就整体失败）。
 */
export function createZipBuffer(
  entries: ZipEntryInput[],
  opts: { maxTotalBytes?: number } = {},
): ZipBuildResult {
  const maxTotalBytes = opts.maxTotalBytes ?? 256 * 1024 * 1024;
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let written = 0;
  let skipped = 0;
  let truncated = false;
  let totalBytes = 0;

  for (const entry of entries) {
    if (truncated) {
      skipped += 1;
      continue;
    }
    let data: Buffer;
    let mtime = new Date();
    try {
      const stat = fs.statSync(entry.sourcePath);
      if (!stat.isFile()) {
        skipped += 1;
        continue;
      }
      if (totalBytes + stat.size > maxTotalBytes) {
        truncated = true;
        skipped += 1;
        continue;
      }
      data = fs.readFileSync(entry.sourcePath);
      mtime = stat.mtime;
      totalBytes += data.length;
    } catch {
      skipped += 1;
      continue;
    }

    const nameBuf = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data);
    // 压不小就用 store（小文件/已压缩内容常见），省一层解压开销
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosDateTime(mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // 文件名按 UTF-8（中文名必需）
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    locals.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs：普通文件（要 >>> 0：<< 的结果是 int32，负数会被 Buffer 拒绝）
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + payload.length;
    written += 1;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(written, 8);
  eocd.writeUInt16LE(written, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return {
    buffer: Buffer.concat([...locals, centralBuf, eocd]),
    entries: written,
    bytes: totalBytes,
    skipped,
    truncated,
  };
}
