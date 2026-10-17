import {
  TICKET_MESSAGE_FORMATS,
  TICKET_RELATED_SERVICES,
  TICKET_TYPES,
  type TicketMessageFormat,
  type TicketRelatedService,
  type TicketType,
} from "../models/ticketModel";

/**
 * 工单新增字段的解析与校验（纯函数，不依赖数据库）。
 *
 * 与既有状态/优先级/分类的写法保持一致：**非法值一律回退默认值而不是 400** —— 表单多一个
 * 下拉不该成为提交失败的来源（见 ticketController.createTicket 里对 category 的同款注释）。
 * 例外是显式给错的情况（管理端改字段、关联工单越界），那里必须报错，否则等于静默丢掉操作。
 */

/** 相关服务补充说明（具体任务 / 订单 / 资源 ID）的长度上限。 */
export const MAX_TICKET_SERVICE_REF_LEN = 120;
/** 单个工单可关联的其它工单条数上限。 */
export const MAX_TICKET_RELATED_TICKETS = 5;
/** 联系邮箱长度上限（RFC 5321 的实用上限）。 */
export const MAX_TICKET_CONTACT_EMAIL_LEN = 254;

/**
 * 邮箱格式：与注册链路同一套宽松规则（`src/controllers/auth/registrationHandlers.ts`）。
 * 这里刻意不复用 `EmailService.isValidEmail`：那个方法面向「可投递域名」白名单，
 * 而工单里的联系邮箱只是给客服回访看的联系方式，不该因为域名不在白名单就拒绝保存。
 */
const CONTACT_EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

export function asTicketType(value: unknown): TicketType | null {
  return typeof value === "string" && (TICKET_TYPES as readonly string[]).includes(value)
    ? (value as TicketType)
    : null;
}

/** 消息正文格式的缺省值：与历史行为一致（所有消息都按 Markdown 渲染）。 */
export const DEFAULT_TICKET_MESSAGE_FORMAT: TicketMessageFormat = "markdown";

/**
 * 消息正文格式解析：非法/缺省一律回退 markdown 而不是 400。
 *
 * 与 category/type 同口径 —— 多一个格式选择不该成为提交失败的来源；
 * 真选错了也只是渲染方式不同，正文本身一个字节都不会丢。
 */
export function asTicketMessageFormat(value: unknown): TicketMessageFormat | null {
  return typeof value === "string" && (TICKET_MESSAGE_FORMATS as readonly string[]).includes(value)
    ? (value as TicketMessageFormat)
    : null;
}

export function asTicketRelatedService(value: unknown): TicketRelatedService | null {
  return typeof value === "string" && (TICKET_RELATED_SERVICES as readonly string[]).includes(value)
    ? (value as TicketRelatedService)
    : null;
}

/** 相关服务补充说明：折算成单行、去首尾空白，空串归一为 null。 */
export function normalizeRelatedServiceRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.slice(0, MAX_TICKET_SERVICE_REF_LEN);
}

export type ContactEmailNormalization =
  | { ok: true; email: string | null }
  | { ok: false; error: string };

/**
 * 联系邮箱：空 / 缺省归一为 `null`（调用方再决定要不要用账号邮箱兜底），
 * 填了就必须是合法邮箱 —— 邮箱是唯一会被拿去回访的字段，格式错的后果是联系不上。
 */
export function normalizeContactEmail(value: unknown): ContactEmailNormalization {
  if (value === undefined || value === null) return { ok: true, email: null };
  if (typeof value !== "string") return { ok: false, error: "联系邮箱格式不正确" };
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, email: null };
  if (trimmed.length > MAX_TICKET_CONTACT_EMAIL_LEN) {
    return { ok: false, error: `联系邮箱不能超过 ${MAX_TICKET_CONTACT_EMAIL_LEN} 个字符` };
  }
  if (!CONTACT_EMAIL_PATTERN.test(trimmed)) return { ok: false, error: "联系邮箱格式不正确" };
  return { ok: true, email: trimmed };
}

/**
 * 关联工单 ID 列表：去重、去空、限定条数，只做「看起来像 ObjectId」的形态校验；
 * 「工单是否存在 / 是否属于同一属主」是数据库侧判定（见 ticketController.resolveRelatedTickets）。
 */
export function normalizeRelatedTicketIds(value: unknown): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, ids: [] };
  if (!Array.isArray(value)) return { ok: false, error: "关联工单参数格式不正确" };
  const ids: string[] = [];
  for (const item of value) {
    if (item === undefined || item === null || item === "") continue;
    if (typeof item !== "string" || !OBJECT_ID_PATTERN.test(item.trim())) {
      return { ok: false, error: "关联工单包含无效的工单 ID" };
    }
    const id = item.trim();
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > MAX_TICKET_RELATED_TICKETS) {
    return { ok: false, error: `最多关联 ${MAX_TICKET_RELATED_TICKETS} 个工单` };
  }
  return { ok: true, ids };
}
