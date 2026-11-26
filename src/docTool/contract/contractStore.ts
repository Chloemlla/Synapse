// 契约的存取层：内置契约、用户契约（JSON）、编译后的参考样式（缓存）。
//
// 三条边界，写在这里是为了以后改动时不越界：
//   1) **不 import converter.ts**：converter 要 import contract/index 才能接管线，
//      这里再反向 import 就是循环。所以 `--print-default-data-file reference.docx` 在本文件里本地实现一次。
//   2) 契约 JSON 一律经过 normalizeContract 才允许落盘/使用：用户手改 JSON 少一个字段是常态，
//      不能让一个缺失字段在编译期炸掉整批转换。
//   3) 编译产物按 `<id>-<hash12>.docx` 命名：契约改一个字就换缓存名，永不出现「改了契约但用了旧缓存」。
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  BUILTIN_CONTRACTS,
  DEFAULT_CONTRACT_ID,
  compileReferenceDoc,
  contractFromDocx,
  contractHash,
  summarizeContract,
  normalizeContract,
  type ContractSummary,
  type StyleContract,
} from "./index";

/** 契约 id 会变成文件名，所以只允许小写字母/数字/下划线/连字符。 */
const CONTRACT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export function sanitizeContractId(raw: unknown): string | null {
  const value = String(raw ?? "").trim().toLowerCase();
  return CONTRACT_ID_RE.test(value) ? value : null;
}

export function contractsDir(userRoot: string): string {
  return path.join(userRoot, "contracts");
}

export interface ContractEntry {
  id: string;
  name: string;
  source: "builtin" | "user";
  summary: ContractSummary;
}

function readJsonContract(file: string, id: string): StyleContract | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    // 强制用文件名做 id：用户可以把 JSON 里的 id 改成任意值，但磁盘上以文件名为准，
    // 否则「按 id 找文件」和「文件里的 id」会指向两个东西。
    return normalizeContract({ ...raw, id });
  } catch {
    return null;
  }
}

export function loadUserContract(userRoot: string, contractId: string): StyleContract | null {
  const id = sanitizeContractId(contractId);
  if (!id) return null;
  const file = path.join(contractsDir(userRoot), `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return readJsonContract(file, id);
}

export function listUserContracts(userRoot: string): ContractEntry[] {
  const dir = contractsDir(userRoot);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const out: ContractEntry[] = [];
  for (const name of names.sort()) {
    const id = sanitizeContractId(name.replace(/\.json$/i, ""));
    if (!id) continue;
    const contract = loadUserContract(userRoot, id);
    if (!contract) continue;
    out.push({ id, name: contract.name, source: "user", summary: summarizeContract(contract, false) });
  }
  return out;
}

export function listBuiltinContracts(): ContractEntry[] {
  return BUILTIN_CONTRACTS.map((contract) => ({
    id: contract.id,
    name: contract.name,
    source: "builtin" as const,
    summary: summarizeContract(contract, true),
  }));
}

export interface ResolvedContract {
  contract: StyleContract;
  /** 契约来自哪里（用户在界面上要能看出「我选的到底是哪一份」） */
  source: "builtin" | "user" | "default";
}

/**
 * 解析「这次任务用哪份契约」。顺序：用户目录里同名 JSON → 内置 → 默认（CN_HANDOUT_V1）。
 * 为什么用户契约优先于内置：用户完全可以上传一份 id 叫 `cn-handout` 的自己的契约覆盖内置，
 * 这是他明确表达过的意图；但内置永远在，所以不会出现「找不到契约」这种让任务失败的出口。
 */
export function resolveContract(opts: { userRoot: string; contractId?: string | null }): ResolvedContract {
  const wanted = sanitizeContractId(opts.contractId ?? "");
  if (wanted) {
    const user = loadUserContract(opts.userRoot, wanted);
    if (user) return { contract: user, source: "user" };
    const builtin = BUILTIN_CONTRACTS.find((contract) => contract.id === wanted);
    if (builtin) return { contract: builtin, source: "builtin" };
  }
  const fallback = BUILTIN_CONTRACTS.find((contract) => contract.id === DEFAULT_CONTRACT_ID) ?? BUILTIN_CONTRACTS[0];
  return { contract: fallback, source: "default" };
}

export function saveUserContract(userRoot: string, contract: StyleContract): { ok: boolean; error?: string; id?: string } {
  const id = sanitizeContractId(contract.id);
  if (!id) return { ok: false, error: "契约 id 只能用小写字母、数字、下划线和连字符" };
  const dir = contractsDir(userRoot);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    // 先写临时文件再改名：并发保存同一份契约时不会读到一个写了一半的 JSON
    const temp = path.join(dir, `.${id}.tmp-${process.pid}`);
    fs.writeFileSync(temp, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
    fs.renameSync(temp, file);
    return { ok: true, id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 从一份 .docx 反编译出契约并存盘 —— 这是「老师手上有范本」时的入口。
 * 反编译失败要给出明确原因（不是「上传失败」四个字），因为最常见的原因是文件不是 docx。
 */
export function importContractFromDocx(opts: {
  userRoot: string;
  id: string;
  name?: string;
  docx: Buffer;
}): { ok: boolean; contract?: StyleContract; error?: string } {
  const id = sanitizeContractId(opts.id);
  if (!id) return { ok: false, error: "契约 id 只能用小写字母、数字、下划线和连字符" };
  let contract: StyleContract;
  try {
    contract = contractFromDocx(opts.docx, { id, name: opts.name?.trim() || id });
  } catch (error) {
    return {
      ok: false,
      error: `无法从这份文件读出排版（它可能不是 .docx）：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const saved = saveUserContract(opts.userRoot, contract);
  return saved.ok ? { ok: true, contract } : { ok: false, error: saved.error };
}

/** pandoc 内嵌的默认参考样式（`--print-default-data-file reference.docx`），拿不到就返回错误让调用方降级。 */
export function defaultReferenceBytes(pandocBin: string): { ok: boolean; bytes?: Buffer; error?: string } {
  try {
    const result = spawnSync(pandocBin, ["--print-default-data-file", "reference.docx"], {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) return { ok: false, error: result.error.message };
    if (result.status !== 0 || !result.stdout || result.stdout.length === 0) {
      const message = String(result.stderr || "").split("\n")[0]?.trim();
      return { ok: false, error: message || `pandoc 退出码 ${result.status ?? "unknown"}` };
    }
    return { ok: true, bytes: result.stdout };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface CompiledReference {
  ok: boolean;
  /** 编译后的 reference.docx 绝对路径（ok=true 时必定存在） */
  path?: string;
  cached?: boolean;
  bytes?: number;
  /** 编译过程中实际改到的位置（写进任务日志，让「契约生效了」可核对） */
  applied?: string[];
  warnings?: string[];
  error?: string;
}

/**
 * 编译（或复用）参考样式。缓存命中条件是 `<id>-<hash12>.docx` 存在。
 *
 * baseDocx 传什么很关键：
 *   - 用户没上传模板 → pandoc 内置默认样式（defaultReferenceBytes 取）；
 *   - 用户上传了模板 → **在用户的模板上叠加契约**（保留他的页眉页脚/Logo/字体偏好，
 *     只覆盖契约声明要管的那些属性）。契约不该把用户自己的模板清空。
 */
export function ensureCompiledReference(opts: {
  contract: StyleContract;
  cacheRoot: string;
  baseDocx: Buffer;
}): CompiledReference {
  const hash = contractHash(opts.contract).slice(0, 12);
  const dir = path.join(opts.cacheRoot, "_contracts");
  const file = path.join(dir, `${opts.contract.id}-${hash}.docx`);
  const cachedStat = fs.statSync(file, { throwIfNoEntry: false });
  if (cachedStat?.isFile() && cachedStat.size > 0) {
    return { ok: true, path: file, cached: true, bytes: cachedStat.size };
  }
  let compiled: ReturnType<typeof compileReferenceDoc>;
  try {
    compiled = compileReferenceDoc(opts.baseDocx, opts.contract);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 同目录临时文件 + 原子改名：并发的两个任务同时编译同一份契约时，谁后到都不会读到半个文件
    const temp = path.join(dir, `.${opts.contract.id}-${hash}.tmp-${process.pid}${crypto.randomBytes(3).toString("hex")}.docx`);
    fs.writeFileSync(temp, compiled.buffer);
    fs.renameSync(temp, file);
  } catch (error) {
    return { ok: false, error: `无法写入编译后的参考样式：${error instanceof Error ? error.message : String(error)}` };
  }
  return {
    ok: true,
    path: file,
    cached: false,
    bytes: compiled.buffer.length,
    applied: compiled.report.applied,
    warnings: compiled.report.skipped,
  };
}
