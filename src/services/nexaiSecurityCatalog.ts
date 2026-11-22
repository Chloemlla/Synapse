/**
 * NexAI 安全事件的**代号 → 中文**唯一事实源。
 *
 * 为什么需要它：`security_events` 是「多来源写入」的集合 —— 客户端上报的是
 * `root_detected` 这类小写下划线码，服务端风控写的是 `ACCOUNT_ABUSE_*` /
 * `SUPERADMIN_RISK_EXEMPT` 这类大写码。管理面板此前只认识其中一小部分，
 * 其余原样把代号铺在页面上，运维得先翻代码才知道那一行是什么。
 *
 * 这里的清单是**穷举**的：`nexaiSecurityCatalog.test.ts` 会扫描源码里所有
 * `eventType: "..."` 字面量，漏登记即红；同时校验客户端上报白名单是清单子集。
 * 新增事件类型时：先写码，再在这里加一条中文名与分组。
 */

export type SecurityEventGroup = "client" | "account" | "session" | "system" | "fingerprint";

export const SECURITY_EVENT_GROUP_LABELS: Record<SecurityEventGroup, string> = {
  client: "客户端设备检测",
  account: "账户风控",
  session: "会话与验证",
  system: "系统防护",
  fingerprint: "设备指纹",
};

export const SECURITY_EVENT_GROUP_ORDER: readonly SecurityEventGroup[] = [
  "client",
  "account",
  "session",
  "system",
  "fingerprint",
];

export interface SecurityEventCatalogEntry {
  value: string;
  label: string;
  group: SecurityEventGroup;
  groupLabel: string;
  /** `client` = 客户端上报白名单接受的值；`server` = 服务端内部写入。 */
  source: "client" | "server";
}

interface SecurityEventDefinition {
  value: string;
  label: string;
  group: SecurityEventGroup;
  source: "client" | "server";
}

const DEFINITIONS: readonly SecurityEventDefinition[] = [
  // 客户端上报（与控制器 ALLOWED_SECURITY_EVENT_TYPES 对齐）
  { value: "integrity_fail", label: "完整性校验失败", group: "client", source: "client" },
  { value: "root_detected", label: "检测到 Root", group: "client", source: "client" },
  { value: "debugger_detected", label: "检测到调试器", group: "client", source: "client" },
  { value: "emulator_detected", label: "检测到模拟器", group: "client", source: "client" },
  { value: "vpn_detected", label: "检测到 VPN / 代理", group: "client", source: "client" },
  { value: "hook_detected", label: "检测到 Hook 框架", group: "client", source: "client" },
  { value: "tamper_detected", label: "客户端被篡改", group: "client", source: "client" },
  { value: "anti_debug", label: "反调试命中", group: "client", source: "client" },
  { value: "frida_detected", label: "检测到 Frida", group: "client", source: "client" },
  { value: "xposed_detected", label: "检测到 Xposed", group: "client", source: "client" },
  { value: "login_anomaly", label: "登录行为异常", group: "client", source: "client" },
  { value: "device_switch", label: "设备切换", group: "client", source: "client" },
  { value: "heartbeat", label: "心跳上报", group: "client", source: "client" },
  { value: "custom", label: "自定义事件", group: "client", source: "client" },

  // 账户风控（服务端写入）
  { value: "ACCOUNT_ABUSE_CAPTCHA_FAILED", label: "登录人机验证失败", group: "account", source: "server" },
  {
    value: "ACCOUNT_ABUSE_STEP_UP_CAPTCHA_FAILED",
    label: "二次验证人机校验失败",
    group: "account",
    source: "server",
  },
  {
    value: "ACCOUNT_ABUSE_STEP_UP_TICKET_INVALID",
    label: "二次验证票据无效",
    group: "account",
    source: "server",
  },
  { value: "ACCOUNT_ABUSE_GEO_JUMP", label: "登录属地跳变", group: "account", source: "server" },
  { value: "ACCOUNT_ABUSE_MID_RISK_IP", label: "中风险 IP 登录", group: "account", source: "server" },
  { value: "ACCOUNT_ABUSE_IDC_EGRESS", label: "机房出口访问", group: "account", source: "server" },
  { value: "ACCOUNT_ABUSE_RISK_BLOCKED", label: "风控引擎拦截", group: "account", source: "server" },
  { value: "ACCOUNT_ABUSE_UNSPECIFIED", label: "账户滥用信号（未细分）", group: "account", source: "server" },
  { value: "AUTOMATION_TRACE", label: "自动化痕迹", group: "account", source: "server" },
  { value: "ACCOUNT_RISK_ACTION", label: "风险处置动作", group: "account", source: "server" },
  { value: "ACCOUNT_RISK_TIER_CHANGED", label: "风险档位变更", group: "account", source: "server" },

  // 会话与验证
  { value: "SECURITY_SESSION_IP_CHANGED", label: "安全会话 IP 变更", group: "session", source: "server" },
  { value: "SECURITY_SESSION_GEO_JUMP", label: "安全会话属地跳变", group: "session", source: "server" },
  { value: "TOTP_CODE_REPLAY", label: "动态口令重放", group: "session", source: "server" },

  // 系统防护
  { value: "HONEYPOT_HIT", label: "蜜罐命中", group: "system", source: "server" },
  { value: "SUPERADMIN_RISK_EXEMPT", label: "超管风控豁免", group: "system", source: "server" },

  // 设备指纹
  { value: "FP_COMPONENT_DRIFT", label: "设备指纹分量漂移", group: "fingerprint", source: "server" },
  {
    value: "FP_SHARED_ACROSS_ACCOUNTS",
    label: "设备指纹跨账号复用",
    group: "fingerprint",
    source: "server",
  },
];

export const SECURITY_EVENT_CATALOG: readonly SecurityEventCatalogEntry[] = DEFINITIONS.map((item) => ({
  ...item,
  groupLabel: SECURITY_EVENT_GROUP_LABELS[item.group],
}));

export const SECURITY_EVENT_LABELS: Record<string, string> = Object.fromEntries(
  SECURITY_EVENT_CATALOG.map((item) => [item.value, item.label]),
);

/** 客户端上报事件类型（控制器白名单的镜像，供筛选器「客户端检测」分组使用）。 */
export const CLIENT_REPORTED_EVENT_TYPES: readonly string[] = SECURITY_EVENT_CATALOG.filter(
  (item) => item.source === "client",
).map((item) => item.value);

/** 未知代号的展示名。原文仍由调用方按需放进「详情」，不在主界面铺代码。 */
export const UNKNOWN_SECURITY_EVENT_LABEL = "未登记事件类型";

export function securityEventLabel(value: string): string {
  return SECURITY_EVENT_LABELS[value] || UNKNOWN_SECURITY_EVENT_LABEL;
}

/** 设备风险等级（设备台账的 riskLevel 枚举）。 */
export const RISK_LEVEL_LABELS: Record<string, string> = {
  SAFE: "安全",
  LOW: "低风险",
  MEDIUM: "中风险",
  HIGH: "高风险",
  CRITICAL: "极高风险",
};

/** 账户风险档位（`AccountRiskTier`）。 */
export const ACCOUNT_RISK_TIER_LABELS: Record<string, string> = {
  normal: "正常",
  watch: "观察",
  restricted: "受限",
  danger: "高危",
};

/** 账户风险判据旗标（`AccountRiskFlag`）。 */
export const ACCOUNT_RISK_FLAG_LABELS: Record<string, string> = {
  HIGH_RISK_LOGIN_IP: "高风险登录 IP",
  MULTI_HIGH_RISK_IPS: "多个高风险 IP",
  DATACENTER_LOGIN_IP: "机房出口登录",
  NEW_ACCOUNT: "新注册账号",
  COMPROMISED_DEVICE: "疑似失陷设备",
  ACCOUNT_ABUSE_EVENTS: "账户滥用事件",
  GEO_JUMP: "登录属地跳变",
  AUTOMATION_HINT: "自动化痕迹",
  PROBE_EXIT_MISMATCH: "出口不一致（探测）",
  ACCOUNT_SHARING_SUSPECTED: "疑似账号共享",
};

/** 人工/自动风险处置动作（`AccountRiskAction`）。 */
export const ACCOUNT_RISK_ACTION_LABELS: Record<string, string> = {
  mark_watch: "标记观察",
  restrict: "限制功能",
  require_step_up: "要求二次验证",
  suspend: "封停账户",
  unban: "解除封停",
  clear_flags: "清除风险标记",
};

/** 超管风控豁免的判据范围（`RiskExemptionScope`）。 */
export const RISK_EXEMPTION_SCOPE_LABELS: Record<string, string> = {
  accountRisk: "账户风险分级",
  stepUp: "逐步验证",
  pow: "人机验证工作量",
  crossModule: "跨模块联动处罚",
  quotaLadder: "配额阶梯",
  loginBackoff: "登录退避",
  honeypot: "蜜罐",
  tarpit: "慢速限流",
  sessionKick: "全站踢出会话",
  regionGuard: "地域守卫",
  apiKeyPenalty: "API 密钥处罚",
};

/** 设备环境特征（设备台账上的布尔位）。 */
export const DEVICE_FLAG_LABELS: Record<string, string> = {
  isRoot: "Root 权限",
  isDebugger: "调试器",
  isEmulator: "模拟器",
  isVpn: "VPN / 代理",
  isAdbEnabled: "ADB 调试",
  isDevelopmentSettingsEnabled: "开发者选项",
  isDebugBuild: "调试包",
  isTracerAttached: "调试器附着",
};

/** 自动化痕迹信号（`AUTOMATION_TRACE` 的 `eventData.signals`）。 */
export const AUTOMATION_SIGNAL_LABELS: Record<string, string> = {
  webdriver: "浏览器自动化标记",
  ua_ch_missing: "缺少 UA-CH 特征",
};

/** 风控处置策略（`RiskStrategy`）与上报接口回给客户端的动作。 */
export const RISK_STRATEGY_LABELS: Record<string, string> = {
  NORMAL: "正常",
  MONITOR: "监控",
  RESTRICT: "限制",
  HONEYPOT: "蜜罐",
  BLOCK: "拦截",
  monitor: "监控",
  restrict: "限制",
  honeypot: "蜜罐",
  block: "拦截",
};

/** 事件 `eventData` 里的字段名 → 中文（详情面板按这个顺序与名称展示）。 */
export const SECURITY_EVENT_DATA_LABELS: Record<string, string> = {
  scope: "豁免范围",
  fromTier: "原风险档位",
  toTier: "现风险档位",
  riskScore: "风险分",
  flags: "命中判据",
  reasons: "判定原因",
  reason: "处理理由",
  action: "处置动作",
  operatorId: "操作人",
  exempt: "是否豁免",
  source: "来源",
  signals: "自动化信号",
  traces: "痕迹明细",
  note: "备注",
  anonymous: "匿名来源",
};

/** 事件详情字段的展示顺序（未列出的字段排在后面）。 */
export const SECURITY_EVENT_DATA_ORDER: readonly string[] = [
  "scope",
  "action",
  "fromTier",
  "toTier",
  "riskScore",
  "flags",
  "reasons",
  "reason",
  "operatorId",
  "exempt",
  "signals",
  "traces",
  "note",
  "anonymous",
  "source",
];

/** 一次性把面板需要的全部标签发给前端（同一份事实源，不在前端再抄一遍）。 */
export function getSecurityCatalog() {
  return {
    eventTypes: SECURITY_EVENT_CATALOG,
    eventGroups: SECURITY_EVENT_GROUP_ORDER.map((group) => ({
      value: group,
      label: SECURITY_EVENT_GROUP_LABELS[group],
    })),
    riskLevels: Object.entries(RISK_LEVEL_LABELS).map(([value, label]) => ({ value, label })),
    riskTiers: Object.entries(ACCOUNT_RISK_TIER_LABELS).map(([value, label]) => ({ value, label })),
    riskFlags: Object.entries(ACCOUNT_RISK_FLAG_LABELS).map(([value, label]) => ({ value, label })),
    riskActions: Object.entries(ACCOUNT_RISK_ACTION_LABELS).map(([value, label]) => ({ value, label })),
    exemptionScopes: Object.entries(RISK_EXEMPTION_SCOPE_LABELS).map(([value, label]) => ({ value, label })),
    deviceFlags: Object.entries(DEVICE_FLAG_LABELS).map(([value, label]) => ({ value, label })),
    strategies: Object.entries(RISK_STRATEGY_LABELS).map(([value, label]) => ({ value, label })),
    automationSignals: Object.entries(AUTOMATION_SIGNAL_LABELS).map(([value, label]) => ({ value, label })),
    eventDataLabels: SECURITY_EVENT_DATA_LABELS,
    eventDataOrder: SECURITY_EVENT_DATA_ORDER,
  };
}
