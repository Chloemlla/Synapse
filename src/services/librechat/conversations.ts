import crypto from "node:crypto";
import { deriveUserOwnerKey } from "./history";

/**
 * 系统内部服务的会话命名规范。
 *
 * 背景：LibreChat 侧一个「会话」= 一个 canonical ownerKey（`user:<sha256>`），摘要不可逆。
 * 内部服务（工单言论审查、QQ 群纪律审查、工单 AI 助手）过去直接用固定身份写历史：
 *  - 每次审查都往同一个会话里追加，模型读到的是**别的工单/别人的历史**（跨工单串味），
 *    而且上一轮内容里的注入语料会长期驻留、持续影响后续判定；
 *  - 管理端只能看到一串 sha256，看不出这条会话属于哪个内部服务。
 *
 * 这里的约定：
 *  - 会话名一律以**组件名开头**：`<组件名>:<用途>:<标识>`；
 *  - 每次「一次性审查」都带唯一标识 ⇒ 每次都是全新会话，绝不复用上一轮的上下文；
 *  - 需要跨轮保留上下文的场景（工单 AI 助手）显式传稳定标识（如工单 ID），仍然一工单一会话。
 */
export const INTERNAL_SERVICE_COMPONENTS = {
  moderation: "工单言论审查",
  "qq-guard": "QQ 群纪律审查",
  "ticket-ai": "工单 AI 助手",
} as const;

export type InternalServiceComponent = keyof typeof INTERNAL_SERVICE_COMPONENTS;

export interface InternalConversation {
  /** 会话可读名，组件名开头：`<组件名>:<用途>:<标识>`。 */
  name: string;
  /** 会话所属组件，管理端按它分组。 */
  component: InternalServiceComponent;
  /** 该会话在 LibreChat 侧的 canonical ownerKey（sha256 摘要，不可逆）。 */
  ownerKey: string;
}

export function isInternalServiceComponent(value: unknown): value is InternalServiceComponent {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(INTERNAL_SERVICE_COMPONENTS, value);
}

export function internalServiceLabel(component: InternalServiceComponent): string {
  return INTERNAL_SERVICE_COMPONENTS[component];
}

/** 会话名只允许安全字符，长度收敛（进历史文档的展示字段，也可能是搜索关键词）。 */
function sanitizeSegment(value: string): string {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .slice(0, 64);
  return cleaned || "unknown";
}

/**
 * 创建（或按稳定标识复用）一个内部服务会话。
 *
 * 不传 `conversationId` ⇒ 每次调用都生成新标识，得到全新会话（一次性审查必须走这条）；
 * 传稳定标识（如工单 ID）⇒ 同一标识始终映射到同一会话，供需要连续上下文的场景使用。
 */
export function createInternalConversation(
  component: InternalServiceComponent,
  purpose: string,
  conversationId?: string,
): InternalConversation {
  const id = conversationId ? sanitizeSegment(conversationId) : crypto.randomBytes(6).toString("hex");
  const name = `${component}:${sanitizeSegment(purpose)}:${id}`;
  return {
    name,
    component,
    ownerKey: deriveUserOwnerKey(`system:${name}`),
  };
}

/**
 * 改造前用固定身份写入的历史遗留会话：摘要不可逆，只能按当时写死的身份反推。
 * （工单 AI 助手当年的身份带工单 ID，无法枚举，故不在表内。）
 */
const LEGACY_INTERNAL_CONVERSATIONS: ReadonlyArray<readonly [string, InternalServiceComponent, string]> = [
  ["system:moderation:check", "moderation", "moderation:check:legacy"],
  ["system:moderation:reason", "moderation", "moderation:reason:legacy"],
  ["system:qq-guard:moderate", "qq-guard", "qq-guard:moderate:legacy"],
];

const LEGACY_LOOKUP = new Map(
  LEGACY_INTERNAL_CONVERSATIONS.map(([identity, component, name]) => [
    deriveUserOwnerKey(identity),
    { component, name },
  ]),
);

/** 命中则返回遗留会话的可读名与组件，未命中返回 null。 */
export function lookupLegacyInternalConversation(
  ownerKey: string,
): { component: InternalServiceComponent; name: string } | null {
  return LEGACY_LOOKUP.get(ownerKey) ?? null;
}

/** 遗留会话的 ownerKey 列表，供管理端筛选出「系统内部服务」时一并纳入。 */
export function listLegacyInternalOwnerKeys(): string[] {
  return [...LEGACY_LOOKUP.keys()];
}
