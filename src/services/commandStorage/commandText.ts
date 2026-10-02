/**
 * 命令队列/历史共用的取值校验。
 *
 * 为什么要单独一个文件：这里有两类完全不同的字符串，之前被同一个 `sanitizeString` 混着用了
 * ——
 *  1. **会进 Mongo 查询条件的值**（`commandId`）：必须是字面量，含 `$` / `.` 的字符串可能被
 *     解释成操作符或字段路径，所以要按查询值净化；
 *  2. **只被当字面量写库的命令正文**：从不参与查询构造，所以只需要类型 + 长度边界。
 * 混用之后，能通过 `commandService.validateCommand` 的合法命令（如 `ls .`，参数里带 `.`）会在
 * Mongo 存根被以「命令内容非法」拒掉，而 `COMMAND_STORAGE=file` 存根却照收 —— 同一份代码在
 * 两个后端上行为不同，报错还指向错误的原因。
 */

/** 命令正文上限：与 `commandService` 的 100 字符白名单留出余量（参数可能拼长）。 */
export const COMMAND_TEXT_MAX_LENGTH = 512;

/** 命令 ID 上限：两个存根生成的形态都远短于此，超出只可能是伪造输入。 */
export const COMMAND_ID_MAX_LENGTH = 128;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 只做「能安全当查询字面量」的校验：空、含 Mongo 元字符、超长一律视为非法。 */
export function normalizeCommandId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > COMMAND_ID_MAX_LENGTH) return null;
  if (CONTROL_CHARS.test(trimmed)) return null;
  if (/[$.{}[\]]/.test(trimmed)) return null;
  return trimmed;
}

/** 命令正文（以及历史里的同名字段）：只校验类型、非空与长度，不剥离字符。 */
export function normalizeCommandText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > COMMAND_TEXT_MAX_LENGTH) return null;
  return trimmed;
}
