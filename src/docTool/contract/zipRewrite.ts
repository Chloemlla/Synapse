// 单条目替换式 ZIP 重打包：把「改一个 word/document.xml」变回一个完整 docx。
//
// 设计取舍（为什么不是「在内存里搬 local header 的偏移」）：
//   1) 改过长度的条目不搬会影响后续所有 local header 的 offset，中央目录要整片重算；
//      与其做「就地打补丁 + 偏移修正」，不如按原顺序整体重写 —— 逻辑只有一条路径，好验。
//   2) 时间戳固定成 1980-01-01、压缩参数固定，使输出**逐字节确定**。
//      这一条直接支撑了「幂等性」判据：同一份输入跑两轮 pass，sha256 必须相等。
//      如果沿用当前时间，两轮产物天然不同，幂等性就变成了测不出来的东西。
//
// 不改的东西：条目顺序、条目名、压缩方式的选择规则（能压小就 deflate，否则 store）。
// 会变的东西：所有条目的压缩字节（因为重压了一遍）与时间戳。这两个变化对 Word 无意义。
import zlib from "node:zlib";
import { crc32 } from "../zipStore";
import type { ZipArchive } from "./zipRead";

/** 固定的 DOS 时间/日期：1980-01-01 00:00（ZIP 纪元起点）。0 时间 + 0x0021 日期。 */
const FIXED_TIME = 0;
const FIXED_DATE = 0x0021;
/** 通用标志位：bit 11 = 文件名是 UTF-8。与 zipStore 写器保持一致。 */
const FLAG_UTF8 = 0x0800;

export interface RewriteResult {
  buffer: Buffer;
  /** 实际被替换的条目数（0 表示 zip 是按原样重写的，内容没变） */
  replaced: number;
}

/**
 * 按 replacements 替换条目内容，返回新的 docx 字节。
 * replacements 里出现 archive 中不存在的名字时**忽略**（不新增条目）：新增条目需要同时改
 * [Content_Types].xml 与 rels，属于「造文档」而不是「改文档」，不在本方案的职责边界内。
 */
export function rewriteZip(archive: ZipArchive, replacements: Map<string, Buffer>): RewriteResult {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let replaced = 0;

  for (const entry of archive.entries) {
    const incoming = replacements.get(entry.name);
    const data = incoming ?? entry.data;
    if (incoming && !incoming.equals(entry.data)) replaced += 1;

    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(FLAG_UTF8, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(FIXED_TIME, 10);
    localHeader.writeUInt16LE(FIXED_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    locals.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(FLAG_UTF8, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(FIXED_TIME, 12);
    centralHeader.writeUInt16LE(FIXED_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    // 普通文件权限位；<<16 的结果可能是负数（int32），Buffer 写无符号必须 >>> 0
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(archive.entries.length, 8);
  eocd.writeUInt16LE(archive.entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return { buffer: Buffer.concat([...locals, centralBuf, eocd]), replaced };
}

/** 只替换一个文本条目（内部会把字符串按 UTF-8 编码，不要手工加 BOM）。 */
export function replaceTextEntry(archive: ZipArchive, name: string, text: string): RewriteResult {
  return rewriteZip(archive, new Map([[name, Buffer.from(text, "utf8")]]));
}
