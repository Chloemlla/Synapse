import type { IAuditLog } from "../models/auditLogModel";

/**
 * 审计日志「模块」与「角色」的**唯一事实源**。
 *
 * 为什么单独一个文件：模块清单此前被抄在三处 —— `models/auditLogModel.ts` 的类型联合、
 * `services/auditLogMetadata.ts` 的 `ALLOWED_AUDIT_MODULES`、前端 `AuditLogViewer` 的
 * `MODULE_LABELS`。三份清单一漂，管理端就会出现「库里明明有 lumen-config 记录，
 * 筛选器里却没有这一项」——而且选了也不会报错，只是静默返回全部日志（用户以为自己筛了）。
 * 现在清单只在这里维护，前端通过 `/api/admin/audit-logs/meta` 取中文名与分组。
 *
 * 新增模块时：先在 `models/auditLogModel.ts` 的类型联合里加值，再在 `AUDIT_MODULES`
 * 里加一条（中文名、分组、一句话说明）。`auditLogCatalog.test.ts` 会扫描源码里所有
 * `module: "..."` 字面量，漏登记直接红。
 */

/** 筛选器里的分组（顺序即下拉框里的展示顺序）。 */
export type AuditModuleGroup = "admin" | "account" | "security" | "config" | "content" | "service" | "other";

export interface AuditModuleDescriptor {
  value: IAuditLog["module"];
  /** 管理端展示名（中文）。 */
  label: string;
  group: AuditModuleGroup;
  /** 一句话说明这个模块记什么，用于筛选器提示（不写实现细节）。 */
  hint: string;
}

export const AUDIT_MODULE_GROUP_LABELS: Record<AuditModuleGroup, string> = {
  admin: "管理后台与权限",
  account: "认证与账户",
  security: "安全与风控",
  config: "系统与配置",
  content: "内容与运营",
  service: "业务服务",
  other: "其他",
};

export const AUDIT_MODULE_GROUP_ORDER: readonly AuditModuleGroup[] = [
  "admin",
  "account",
  "security",
  "config",
  "content",
  "service",
  "other",
];

/**
 * 模块目录。`label` 是管理端唯一的中文名来源，`hint` 只描述「记录什么」，
 * 不描述实现（界面不写实现原理）。
 */
export const AUDIT_MODULES: readonly AuditModuleDescriptor[] = [
  { value: "admin", label: "管理后台", group: "admin", hint: "管理端页面的访问与操作" },
  { value: "auth", label: "登录认证", group: "account", hint: "登录、令牌、二次验证与登出" },
  { value: "user", label: "用户管理", group: "account", hint: "账号资料、状态与权限变更" },
  { value: "oauth", label: "第三方登录", group: "account", hint: "OAuth 客户端与授权绑定" },
  { value: "security", label: "安全风控", group: "security", hint: "风控拦截、人机验证与设备信任" },
  { value: "ipban", label: "IP 封禁", group: "security", hint: "IP 封禁的增删与解封" },
  { value: "policy", label: "政策条款", group: "security", hint: "条款版本、同意记录与清理" },
  { value: "privacy", label: "隐私与取证", group: "security", hint: "数据导出、法律保留与取证" },
  { value: "system", label: "系统维护", group: "config", hint: "系统状态、缓存与维护动作" },
  { value: "config", label: "运行时配置", group: "config", hint: "可在线修改的运行参数" },
  { value: "env", label: "环境变量", group: "config", hint: "环境变量的增删改与密钥操作" },
  { value: "debug", label: "调试工具", group: "config", hint: "调试台与诊断入口" },
  { value: "announcement", label: "公告", group: "config", hint: "公告的发布、修改与删除" },
  { value: "lottery", label: "抽奖", group: "content", hint: "抽奖活动与奖品配置" },
  { value: "life", label: "生活服务", group: "content", hint: "生活服务类小功能" },
  { value: "social", label: "社交互动", group: "content", hint: "评论、分享等互动数据" },
  { value: "workspace", label: "工作区", group: "content", hint: "协作工作区与成员" },
  { value: "recommendation", label: "推荐位", group: "content", hint: "首页推荐与排序" },
  { value: "tts", label: "语音合成", group: "service", hint: "TTS 生成、试听与配额" },
  { value: "media", label: "媒体工具", group: "service", hint: "转写、下载等媒体处理" },
  { value: "cdk", label: "CDK 卡密", group: "service", hint: "卡密的生成、兑换与作废" },
  { value: "api", label: "开放接口", group: "service", hint: "对外 API 与密钥调用" },
  { value: "resource", label: "资源商店", group: "service", hint: "资源上架、购买与分发" },
  { value: "shorturl", label: "短链接", group: "service", hint: "短链创建、跳转与迁移" },
  { value: "ipfs", label: "IPFS 存储", group: "service", hint: "去中心化存储的上传与删除" },
  { value: "network", label: "网络与 IP", group: "service", hint: "IP 归属、出口与网络探测" },
  { value: "email", label: "邮件系统", group: "service", hint: "邮件配置、发送与退信" },
  { value: "modlist", label: "模组列表", group: "service", hint: "模组条目的增删改与批量操作" },
  { value: "geogebra", label: "GeoGebra 工作台", group: "service", hint: "GeoGebra 项目、协作与导出" },
  { value: "lumen-config", label: "Lumen 客户端配置", group: "service", hint: "客户端运行时配置项的下发与删除" },
  { value: "other", label: "其他", group: "other", hint: "尚未归类的接口调用" },
];

export const AUDIT_MODULE_VALUES: readonly IAuditLog["module"][] = AUDIT_MODULES.map((item) => item.value);

/**
 * 可筛选模块的白名单。**必须**覆盖所有会被写进库的模块值：
 * `buildStaticFilter` 只接受白名单里的值，不在名单里的模块筛选会被**静默忽略**
 * （返回全部日志），这是最糟的一种失败方式 —— 用户以为筛了。
 */
export const ALLOWED_AUDIT_MODULES: ReadonlySet<IAuditLog["module"]> = new Set(AUDIT_MODULE_VALUES);

export const AUDIT_MODULE_LABELS: Record<string, string> = Object.fromEntries(
  AUDIT_MODULES.map((item) => [item.value, item.label]),
);

/** 角色代号 → 中文。`unknown` / `anonymous` 来自全局审计对未识别请求的兜底值。 */
export const AUDIT_ROLE_LABELS: Record<string, string> = {
  superadmin: "超级管理员",
  admin: "管理员",
  user: "普通用户",
  anonymous: "匿名访客",
  unknown: "未识别",
};

/**
 * 角色筛选器的取值顺序。不含 `anonymous`：全局审计对未识别请求写的是 `unknown`，
 * 把永远命中 0 条的选项放进下拉框只会让人以为「筛了但没数据」。
 */
export const AUDIT_ROLE_FILTER_ORDER: readonly string[] = ["superadmin", "admin", "user", "unknown"];

export const AUDIT_RESULT_LABELS: Record<string, string> = {
  success: "成功",
  failure: "失败",
};

/** 时间排序选项：默认最新在前（值班复盘最常看「刚刚发生了什么」）。 */
export const AUDIT_SORT_OPTIONS: ReadonlyArray<{ value: "desc" | "asc"; label: string }> = [
  { value: "desc", label: "最新在前" },
  { value: "asc", label: "最早在前" },
];

export function isAuditSortOrder(value: unknown): value is "desc" | "asc" {
  return value === "desc" || value === "asc";
}

export function auditModuleLabel(value: string): string {
  return AUDIT_MODULE_LABELS[value] || value;
}

export function auditRoleLabel(value: string): string {
  return AUDIT_ROLE_LABELS[value] || value;
}

export function auditResultLabel(value: string): string {
  return AUDIT_RESULT_LABELS[value] || value;
}
