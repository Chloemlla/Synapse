// 最小 ZIP **读**器：只做「把 docx 拆成 {name → bytes}」这一件事。
//
// 为什么不引 jszip / adm-zip / yauzl：本仓库 docTool 已经有一个自写 ZIP 写器（../zipStore.ts），
// 缺的只是读侧；而 ZIP 读侧真正需要的逻辑只有三步 —— 找 EOCD → 走中央目录 → inflateRaw，
// Node 自带 zlib 就够。新增依赖还要走 AGENTS.md §7 的锁文件重生成通路（两轮 CI），不值得。
//
// 与写器的对称性说明（这条是自证的一部分，不是修辞）：
//   写器 crc32("123456789") = 0xcbf43926；本读器对写器产出的包做「解出来的字节 + CRC 双向校验」，
//   两边都不引用对方的解码逻辑，所以「写错了也读得回来」这种自证不成立。
//
// 刻意不支持：zip64（>4GB 或 >65535 条目）、多分卷、加密、data descriptor 的流式场景。
// docx 的体量（单次上限 256MB 写在 zipStore 里，docTool 单文件上限 8MB）离这些边界很远；
// 一旦真的遇到，宁可抛一个说人话的错，也不要在半懂的状态下拼字节。
import zlib from "node:zlib";
import { crc32 } from "../zipStore";

/** 单个条目解压后的大小上限：防「压缩炸弹」把 8MB 的 docx 解成几个 GB 撑爆内存。 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** 条目数上限：docx 正常不超过几十个条目（[Content_Types] + rels + document + styles + media）。 */
const MAX_ENTRIES = 4096;

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export interface ZipEntry {
  /** 包内名字（UTF-8 解码；docx 的条目名全是 ASCII，中文名只会出现在用户自己打的包里） */
  name: string;
  /** 0 = store，8 = deflate */
  method: number;
  /** 解压后的字节数 */
  size: number;
  /** 压缩后的字节数 */
  compressedSize: number;
  /** CRC32（与 ../zipStore 的 crc32 同一定义） */
  crc: number;
  /** 通用标志位（bit 11 = 文件名 UTF-8） */
  flags: number;
  /** 解压后的内容 */
  data: Buffer;
}

export interface ZipArchive {
  entries: ZipEntry[];
  names: string[];
  /** 原包字节（rewriteZip 用它做「除目标条目外一切照搬」的依据） */
  buffer: Buffer;
  get(name: string): ZipEntry | undefined;
  /** 文本条目（xml/rels），不存在返回 null */
  text(name: string): string | null;
}

export interface ReadZipOptions {
  maxEntryBytes?: number;
  maxEntries?: number;
}

class ZipFormatError extends Error {}

function findEocd(buffer: Buffer): number {
  // EOCD 最短 22 字节，注释最长 65535 → 只需要扫最后 65557 字节
  const from = Math.max(0, buffer.length - (0xffff + 22));
  for (let offset = buffer.length - 22; offset >= from; offset -= 1) {
    if (buffer.readUInt32LE(offset) === SIG_EOCD) return offset;
  }
  return -1;
}

/** 读一个 zip 包。任何结构性问题都抛错（调用方据此把产物判为「容器坏了」，不要静默返回空表）。 */
export function readZip(buffer: Buffer, opts: ReadZipOptions = {}): ZipArchive {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new ZipFormatError("不是有效的 ZIP：字节数不足 22（连 EOCD 都放不下）");
  }
  const maxEntryBytes = opts.maxEntryBytes ?? MAX_ENTRY_BYTES;
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES;

  const eocd = findEocd(buffer);
  if (eocd < 0) throw new ZipFormatError("不是有效的 ZIP：找不到中央目录结束记录（EOCD）");

  const total = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  // zip64 的标记值：真遇到了必须明说，否则会按 32 位读出一堆负数偏移
  if (total === 0xffff || centralOffset === 0xffffffff) {
    throw new ZipFormatError("不支持 zip64 的 docx（超过 4GB 或条目数超过 65535）");
  }
  if (total > maxEntries) {
    throw new ZipFormatError(`ZIP 条目数 ${total} 超过上限 ${maxEntries}`);
  }
  if (centralOffset >= buffer.length) {
    throw new ZipFormatError("ZIP 中央目录偏移越过文件末尾（文件被截断？）");
  }

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > buffer.length) throw new ZipFormatError("中央目录被截断");
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new ZipFormatError(`中央目录第 ${index + 1} 条的签名不对`);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    if (size > maxEntryBytes) {
      throw new ZipFormatError(`条目 ${name} 解压后 ${size} 字节，超过上限 ${maxEntryBytes}`);
    }
    if (localOffset + 30 > buffer.length) throw new ZipFormatError(`条目 ${name} 的本地头越界`);
    if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new ZipFormatError(`条目 ${name} 的本地头签名不对`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.length) {
      throw new ZipFormatError(`条目 ${name} 的数据区越界（文件被截断？）`);
    }
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      try {
        data = zlib.inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
      } catch (error) {
        throw new ZipFormatError(`条目 ${name} 解压失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      throw new ZipFormatError(`条目 ${name} 使用了不支持的压缩方式 ${method}（只支持 store/deflate）`);
    }
    // 双向校验：长度与 CRC 都要对得上，否则「读出来一坨乱码」会被后面的 XML 扫描器当成「没有表格」
    if (data.length !== size) {
      throw new ZipFormatError(`条目 ${name} 解压后长度 ${data.length} 与中央目录记录的 ${size} 不符`);
    }
    if (crc32(data) !== crc) {
      throw new ZipFormatError(`条目 ${name} 的 CRC 校验失败`);
    }

    entries.push({ name, method, size, compressedSize, crc, flags, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  return {
    entries,
    names: entries.map((entry) => entry.name),
    buffer,
    get: (name: string) => byName.get(name),
    text(name: string) {
      const entry = byName.get(name);
      // 末位 BOM 处理：Word 偶尔会给 styles.xml 加 UTF-8 BOM，带 BOM 的字符串做 `^<\?xml` 判断会全部失配
      return entry ? entry.data.toString("utf8").replace(/^\uFEFF/, "") : null;
    },
  };
}

/** 读写对称的自检向量：解一个自己写的包，逐字节比对（单测与离线评测都复用它）。 */
export function zipSelfCheck(archive: ZipArchive): { ok: boolean; error?: string } {
  if (!archive.entries.length) return { ok: false, error: "ZIP 里没有任何条目" };
  for (const entry of archive.entries) {
    if (entry.data.length !== entry.size) return { ok: false, error: `${entry.name} 长度不一致` };
    if (crc32(entry.data) !== entry.crc) return { ok: false, error: `${entry.name} CRC 不一致` };
  }
  return { ok: true };
}
