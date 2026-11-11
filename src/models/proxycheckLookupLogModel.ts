import { mongoose } from "../services/mongoService";

/**
 * 与 src/services/ipRiskService 的 IpRiskDecision 同形。这里逐字重声明而不 import 那边的类型：
 * model 依赖 service 会造出 models → services 的反向依赖。改一边必须同步改另一边。
 */
export interface ProxycheckLookupLogDecisionDoc {
  caller: "api" | "first_visit_gate" | "batch";
  action: "report" | "block" | "challenge" | "allow" | "fail_open" | "fail_closed";
  shouldChallenge: boolean;
  shouldBlock: boolean;
  reason: string;
  risk: number;
  level: "low" | "medium" | "high" | "critical";
  flags: string[];
  source: "cache" | "proxycheck" | "unavailable";
  threshold: number;
  blockThreshold: number;
  failOpen: boolean;
  closedOnFailure: boolean;
}

/**
 * 排障快照里一把密钥的形状。**只有长度与指纹，绝无明文** —— AGENTS.md §8
 * 「日志与接口响应里绝不出现密码、令牌、密钥」。指纹足以回答「是不是同一把」。
 * 与 src/services/proxycheckExchange.ts 的 ProxycheckKeyShape 同形，改一边必须同步改另一边。
 */
export interface ProxycheckDiagnosticKeyShapeDoc {
  present: boolean;
  length: number;
  fingerprint: string;
}

/**
 * 一次上游交互的排障快照（只在「失败」与「验签未过但按配置采信」时落库）。
 *
 * 用途是回答线上那句只有一行的报错：`proxycheck_signature_mismatch` 到底差在哪 ——
 * 上游回没回 http_x_signature、响应体是什么、status 写的是 auth 还是 ok、
 * 当前配置的密钥多长、是不是把 hmacSecret 填成了 payloadVerificationKey。
 *
 * 与 src/services/proxycheckExchange.ts 的 ProxycheckExchangeSnapshot 同形（models 不反向依赖 services，
 * 这里逐字重声明；改一边必须同步改另一边）。
 */
export interface ProxycheckLookupDiagnosticDoc {
  /** 本次交互的错误码；成功（验签未过但已采信）时为空串。 */
  errorCode: string;
  /** 验签未通过但按 PROXYCHECK.trustUnverifiedUpstream 采信了上游结论。 */
  trustedWithoutSignature: boolean;
  method: string;
  /** 已脱敏：`key` 参数只剩长度与指纹。 */
  url: string;
  requestHeaders: Record<string, string>;
  /** 批量端点的表单体（`key` 已脱敏）；单地址查询为 null。 */
  requestBody?: string | null;
  status: number | null;
  responseHeaders: Record<string, string>;
  /** 响应体展示副本（按字节截断，见 MAX_DIAGNOSTIC_BODY_BYTES）。 */
  body: string;
  bodyBytes: number;
  bodyTruncated: boolean;
  signature: {
    /** verified / header_missing / header_malformed / mismatch / not_configured / key_malformed / no_response */
    verdict: string;
    headerName: string;
    headerValue: string;
    expectedSignature: string | null;
    key: ProxycheckDiagnosticKeyShapeDoc;
  };
  keys: {
    apiKey: ProxycheckDiagnosticKeyShapeDoc;
    publicApiKey: ProxycheckDiagnosticKeyShapeDoc;
    payloadVerificationKey: ProxycheckDiagnosticKeyShapeDoc;
    hmacSecret: ProxycheckDiagnosticKeyShapeDoc;
    /** 2026-10-02 事故形态：payloadVerificationKey 被填成了 hmacSecret。 */
    payloadVerificationKeyMatchesHmacSecret: boolean;
  };
  durationMs: number;
  createdAt: Date;
}

export interface ProxycheckLookupLogDoc {
  ip: string;
  apiKeySlot: number;
  apiKeyHash: string;
  /**
   * 本次判定的来源。取值跟 src/services/proxycheckLogQuery.ts 的 LOOKUP_STATUSES 对齐：
   * ok / failed / deduped / quota_exhausted / not_configured / cache。
   * cache = 命中 proxycheck_risk_cache（零外呼、零配额，apiKeyHash 记 "cache" 哨兵）；
   * 一行就是一交「交给调用方的决策」，不是「一次外呼」。
   */
  status: string;
  ok: boolean;
  risk: number | null;
  deduped: boolean;
  durationMs: number;
  error: string;
  createdAt: Date;
  /** 这次查询交给前端的决策快照；旧行与「合并没有产出结论」的行没有该字段。 */
  decision?: ProxycheckLookupLogDecisionDoc;
  /**
   * 上游交互的排障快照。只有 status=failed（含配置错误）与「验签未过但已采信」的行才写，
   * 成功且验签通过的行不写：那是常态，写下来只会把集合撑大。旧行没有该字段。
   */
  diagnostics?: ProxycheckLookupDiagnosticDoc;
}

const ProxycheckLookupLogDecisionSchema = new mongoose.Schema<ProxycheckLookupLogDecisionDoc>(
  {
    caller: { type: String, required: true },
    action: { type: String, required: true },
    shouldChallenge: { type: Boolean, required: true, default: false },
    // 旧行的 decision 没有这两个字段，default 保证反序列化时不会是 undefined。
    shouldBlock: { type: Boolean, required: true, default: false },
    // 见下面 `error` 的说明：Mongoose 的 String required 会把 "" 判为缺失。
    reason: { type: String, default: "" },
    risk: { type: Number, required: true, default: 0 },
    level: { type: String, required: true },
    flags: { type: [String], default: [] },
    source: { type: String, required: true },
    threshold: { type: Number, required: true, default: 0 },
    blockThreshold: { type: Number, required: true, default: 0 },
    failOpen: { type: Boolean, required: true, default: false },
    closedOnFailure: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

// 头信息是任意键名的字符串映射（上游随时可能加 cf-ray 这类头），用 Mixed 而不是逐字段声明。
// 密钥形状（长度 + 指纹）反复出现 5 次，用工厂避免手抄四遍漏一个字段。
// 不用子文档 Schema：嵌套定义与现有 mismatch 子对象同一种写法，类型推导最稳。
const keyShapeDefinition = () => ({
  present: { type: Boolean, default: false },
  length: { type: Number, default: 0 },
  fingerprint: { type: String, default: "" },
});

const ProxycheckLookupDiagnosticSchema = new mongoose.Schema<ProxycheckLookupDiagnosticDoc>(
  {
    // 同下面的 error：错误码可能是空串（验签未过但已采信），不能加 required。
    errorCode: { type: String, default: "" },
    trustedWithoutSignature: { type: Boolean, default: false },
    method: { type: String, default: "GET" },
    url: { type: String, default: "" },
    requestHeaders: { type: mongoose.Schema.Types.Mixed, default: {} },
    requestBody: { type: String, default: null },
    status: { type: Number, default: null },
    responseHeaders: { type: mongoose.Schema.Types.Mixed, default: {} },
    body: { type: String, default: "" },
    bodyBytes: { type: Number, default: 0 },
    bodyTruncated: { type: Boolean, default: false },
    signature: {
      verdict: { type: String, default: "" },
      headerName: { type: String, default: "" },
      // 上游没回签名头时就是空串，同样不能 required。
      headerValue: { type: String, default: "" },
      expectedSignature: { type: String, default: null },
      key: keyShapeDefinition(),
    },
    keys: {
      apiKey: keyShapeDefinition(),
      publicApiKey: keyShapeDefinition(),
      payloadVerificationKey: keyShapeDefinition(),
      hmacSecret: keyShapeDefinition(),
      payloadVerificationKeyMatchesHmacSecret: { type: Boolean, default: false },
    },
    durationMs: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ProxycheckLookupLogSchema = new mongoose.Schema<ProxycheckLookupLogDoc>(
  {
    ip: { type: String, required: true },
    apiKeySlot: { type: Number, required: true },
    apiKeyHash: { type: String, required: true },
    status: { type: String, required: true },
    ok: { type: Boolean, required: true, default: false },
    risk: { type: Number, default: null },
    deduped: { type: Boolean, required: true, default: false },
    durationMs: { type: Number, required: true, default: 0 },
    // 绝不加 required：Mongoose 对 String 的 required 判据是「非空字符串」
    // （SchemaString._checkRequired = v => ... && v.length），而「成功」「命中缓存」
    // 这两条主路径的 error 本来就是 ""。加上 required 会让 logLookup 的 create() 抛
    // ValidationError，被 catch 吞成一行 warn —— 表现为「每次外呼都没落库」。
    error: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    // 单嵌套子文档而非 Mixed：管理端面板要按字段展示 decision，类型必须显式。
    // default: undefined = 该行没有决策时字段根本不落库（旧行也不受影响）。
    decision: { type: ProxycheckLookupLogDecisionSchema, default: undefined },
    diagnostics: { type: ProxycheckLookupDiagnosticSchema, default: undefined },
  },
  {
    collection: "proxycheck_lookup_logs",
    timestamps: false,
  },
);

// 该集合不再是只写集合：新增的 admin 日志面板会按 createdAt 倒序翻页读它（「api 请求日志」页），
// 所以补一条 { createdAt: -1 } 支撑排序与分页。保留期不在这里改：TTL 仍然待 owner 定，
// 本集合刻意不加 expireAfterSeconds（写放大只多了这一个索引）。
ProxycheckLookupLogSchema.index({ createdAt: -1 });

// 概览页的「按 status + 时间窗计数」（近 24h 的 ok/failed/cache 行数）以及「最近一条 status=failed」
// 都走这条复合索引：{createdAt:-1} 单独用不上 status 等值条件，而 status 无索引时 count 会退化成
// 整表扫描（本集合刻意不加 TTL，行数随查询持续增长）。
ProxycheckLookupLogSchema.index({ status: 1, createdAt: -1 });

// 「最近失败的请求」页按 verdict 筛选（header_missing / mismatch / …）并固定 createdAt 倒序，
// 单独用 {createdAt:-1} 用不上 verdict 等值条件，会给这个排障页做整表扫描。
ProxycheckLookupLogSchema.index({ "diagnostics.signature.verdict": 1, createdAt: -1 });

export const ProxycheckLookupLogModel =
  (mongoose.models.ProxycheckLookupLog as mongoose.Model<ProxycheckLookupLogDoc>) ||
  mongoose.model<ProxycheckLookupLogDoc>("ProxycheckLookupLog", ProxycheckLookupLogSchema);
