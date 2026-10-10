// 删除任务时清理它产出的文件，以及按保留期清扫 out/ 下的过期产物。
//
// 取舍（照抄 src/mediaTool/jobs/artifactCleanup.ts）：
//   1) 每条路径都先 resolve 再 relInside(userRoot) 校验，越界一律跳过 —— 记录里的 destRel 是
//      用户可影响的数据（上传时的相对路径），不校验就等于把删除权交给请求体；
//   2) 只删普通文件，绝不递归删目录 —— 目录里可能混着用户自己放的东西，
//      误删一个目录的代价远大于留下一个空目录；
//   3) best-effort —— 单个文件删不掉（占用/权限）只跳过，不让整次任务删除失败。
//
// 与 mediaTool 的一处差异：这里用 lstat 而不是 stat。stat 会跟随符号链接，
// 链接被当作普通文件后递归清扫（sweep）会顺着链接走出用户目录；lstat 把链接本身视为非普通文件直接跳过。
import fs from "node:fs";
import path from "node:path";
import { relInside } from "../runtime";
import type { DocJobRecord } from "../types";

/** 只认普通文件：符号链接/目录/FIFO 等一律不动。 */
function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * 删除一个任务的产物（items 里的 destRel），返回实际删除的文件数。
 *
 * 默认保留入参 .md（keepInputs 默认 true）：那是用户上传的原稿，任务删了它就该还能再转一次；
 * 只有调用方明确要求（例如用户勾了「连上传的源文件一起删」）才传 keepInputs: false。
 */
export function purgeDocArtifacts(job: DocJobRecord, userRoot: string, opts?: { keepInputs?: boolean }): number {
  const keepInputs = opts?.keepInputs !== false;
  const keep = keepInputs ? new Set(job.input.files.map(String)) : new Set<string>();

  let removed = 0;
  for (const item of job.items) {
    const rel = item.destRel;
    if (!rel || keep.has(rel)) continue;
    const abs = path.resolve(userRoot, rel);
    if (relInside(userRoot, abs) === null) continue;
    const st = lstatOrNull(abs);
    if (!st?.isFile()) continue;
    try {
      fs.unlinkSync(abs);
      removed += 1;
    } catch {
      // 尽力而为：占用/权限问题留给运维，不阻断任务删除
    }
  }
  return removed;
}

/**
 * 清扫 out/ 下超过保留期的产物，返回删除的文件数。
 *
 * 只覆盖 out/：alongside 模式的产物与用户上传的 .md 同目录，按 mtime 删那个目录有误删用户文件的风险，
 * 交给任务删除（purgeDocArtifacts）和 Mongo TTL 的记录过期去覆盖。
 * 目录本身不删（可能还有别的任务在用），只删过期文件。
 */
export function sweepExpiredArtifacts(userRoot: string, keepDays: number): number {
  const days = Number.isFinite(keepDays) && keepDays > 0 ? keepDays : 1;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const outDir = path.resolve(userRoot, "out");
  if (relInside(userRoot, outDir) === null) return 0;

  let removed = 0;
  const walk = (dir: string, depth: number): void => {
    // 深度上限：正常产物最多几层（保留源目录结构），撞到更深的说明目录结构异常，不再往下啃
    if (depth > 16) return;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      if (relInside(userRoot, abs) === null) continue;
      const st = lstatOrNull(abs);
      if (!st) continue;
      if (st.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.mtimeMs > cutoff) continue;
      try {
        fs.unlinkSync(abs);
        removed += 1;
      } catch {
        // best-effort：删不掉就留到下次
      }
    }
  };
  walk(outDir, 0);
  return removed;
}
