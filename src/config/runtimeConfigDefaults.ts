import {
  EDGE_DEFAULT_BASE_URL,
  EDGE_DEFAULT_VOICE,
  EDGE_MODEL_ID,
  FISH_AUDIO_DEFAULT_BASE_URL,
  FISH_AUDIO_DEFAULT_MODEL,
  normalizeFishAudioBaseUrl,
  normalizeTtsModelId,
  normalizeTtsProviderId,
  type TtsProviderRuntimeConfig,
} from "./ttsProviderConfig";

export interface IpqsRuntimeConfig {
  apiKeys: string[];
  scamalyticsUser?: string;
  enabled: boolean;
  strictness: number;
  allowPublicAccessPoints: boolean;
  lighterPenalties: boolean;
  timeoutMs: number;
  monthlyQuotaPerKey: number;
  challengeFraudScore: number;
  tokenTtlMinutes: number;
  failOpen: boolean;
}

export interface LinuxDoRuntimeConfig {
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  scopes: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userEndpoint: string;
  forumBaseUrl: string;
  callbackUrl: string;
  frontendCallbackUrl: string;
}

/** LINUX DO Credit (积分支付) merchant settings — separate from Connect OAuth. */
export interface LinuxDoCreditRuntimeConfig {
  enabled: boolean;
  pid: string;
  key: string;
  protocol: "epay" | "ldc";
  gatewayBase: string;
  privateKey: string;
  creditRate: number;
  maxMoney: number;
  notifyUrl: string;
  returnUrl: string;
}

export interface GoogleAuthRuntimeConfig {
  clientId: string;
}

export interface DeepLXRuntimeConfig {
  baseUrl: string;
  apiKey: string;
}

export interface NexaiRuntimeConfig {
  jwtSecret: string;
  jwtExpiresIn: string;
  refreshExpiresIn: string;
  google: {
    clientId: string;
  };
  github: {
    clientId: string;
    clientSecret: string;
  };
  frontendUrl: string;
}

export interface TtsRuntimeConfig {
  generationCode: string;
}

export interface EmailRuntimeConfig {
  enabled: boolean;
  resendDomain: string;
  resendApiKey: string;
  quotaTotal: number;
  outemailEnabled: boolean;
  outemailDomain: string;
  outemailApiKey: string;
  outemailCode: string;
  outemailQuotaTotal: number;
}

export interface AdminSecurityRuntimeConfig {
  /**
   * 运行时配置里的管理员口令。
   *
   * R3-06：后台写入的值一律以 **bcrypt 哈希**存在 `<x>Hash` 字段里，本字段只保留
   * 「来自环境变量/启动默认」的明文（未在后台改过时）以及旧版遗留的明文行。
   * 三个字段只被用于**比对**（不是一个需要还原发给别人的共享密钥），所以哈希化不影响能力，
   * 却能让「Mongo 备份/只读凭据泄露」不再等于「拿到管理员口令」——这是本仓 AGENTS.md
   * 「密码一律 bcrypt 哈希」的既有标准，之前只有这三个字段漏了。
   */
  operationPassword: string;
  operationPasswordHash?: string;
  serverStatusPassword: string;
  serverStatusPasswordHash?: string;
  publicShortUrlEnabled: boolean;
  publicShortUrlPassword: string;
  publicShortUrlPasswordHash?: string;
}

export interface SynapseAndroidRuntimeConfig {
  /** Android applicationId / package name for Digital Asset Links */
  packageName: string;
  /** Colon-separated SHA-256 cert fingerprints for release (and optional debug) */
  sha256CertFingerprints: string[];
  /**
   * Optional Google Web Client ID for Android Credential Manager SIWG serverClientId.
   * Empty means fall back to main googleAuth.clientId / GOOGLE_CLIENT_ID.
   */
  googleClientId: string;
  /** When true, assetlinks.json omits Synapse Android statements from this config */
  disabled: boolean;
}

/** Runtime-mutable settings consumed by the NexAI request-signature middleware. */
export interface NexaiSigningRuntimeConfig {
  mode: "off" | "soft" | "enforce";
  appSignSecret: string;
  appSignSecretPrev: string;
  maxDriftMs: number;
}

/**
 * Settings consumed by the CDict official-client signature middleware. Unlike
 * NexAI signing this never gates access — it only decides which rate-limit tier
 * a request lands in, so `soft` is the safe default for a public API.
 */
export interface CdictSigningRuntimeConfig {
  mode: "off" | "soft" | "enforce";
  appSignSecret: string;
  appSignSecretPrev: string;
  maxDriftMs: number;
}

/**
 * QQ 群纪律机器人 → Synapse 控制通道的共享 HMAC 密钥。
 * Mirror of QQ_GUARD_BOT_TOKEN / QQ_GUARD_SHARED_SECRET env; a stored QQ_GUARD_SIGNING
 * doc overrides the env-seeded default at runtime (see src/routes/qqGuardRoutes.ts).
 */
export interface QqGuardSigningRuntimeConfig {
  token: string;
  /** bot 离线/恢复告警收件邮箱（逗号分隔；空串 = 关闭邮件告警）。 */
  alertEmails: string;
}

/**
 * proxycheck.io IP 风险查询 + 客户端出口探测（HMAC 验签）配置。
 * 注意本配置里有**两把用途相反**的 HMAC 密钥，别混：
 * - `payloadVerificationKey`：proxycheck 官方 Dashboard 的 API Payload Verification Key
 *   （64 字符），用来校验**上游响应**的 `http_x_signature` 头，只进上游请求的验签环节。
 * - `hmacSecret`：本服务自建的主密钥，用来签发/校验**浏览器上报**的出口探测遥测。
 * 两者都只在服务端使用，绝不下发。
 * Mirror of the PROXYCHECK_* env vars; a stored PROXYCHECK doc overrides the
 * env-seeded defaults at runtime (see src/services/ipRiskService.ts).
 */
export interface ProxycheckRuntimeConfig {
  /** 总开关，默认 false（未配置 key 前不得外呼）。 */
  enabled: boolean;
  /** 服务端 key（4 段式），绝不下发到浏览器。 */
  apiKey: string;
  /** 浏览器/CORS key（public-######-######-######）。 */
  publicApiKey: string;
  /** proxycheck 官方的响应验签密钥（64 字符）；空串 = 不验签，只依赖 TLS。 */
  payloadVerificationKey: string;
  /** 自建 API payload 验签主密钥（校验浏览器上报，服务端专用，绝不下发）。 */
  hmacSecret: string;
  /** 同 IP 去重 TTL 小时数。 */
  cacheTtlHours: number;
  timeoutMs: number;
  /** 每把 key 的每日查询额度。 */
  dailyQuotaPerKey: number;
  /** 风险分达到该值即挑战（0..100）。 */
  challengeRiskScore: number;
  /**
   * 风险分达到该值直接阻断（0..100）。
   *
   * 高于 challengeRiskScore 时，首访闸门不再给人机验证的机会，而是把该 IP 写进
   * 封禁表（前后端一起被 ipBanCheck 拦住），只展示阻断页与申诉入口。
   */
  blockRiskScore: number;
  /** proxycheck 是辅助信号而非唯一闸门，默认上游失败时放行。 */
  failOpen: boolean;
  /** 是否把 publicApiKey 下发给前端做直连查询。 */
  usePublicKeyForClient: boolean;
}

/**
 * Runtime-mutable settings consumed by the Project Lumen subsystem
 * (src/config/lumen.ts). Mirror of the LUMEN_* environment variables; a stored
 * LUMEN doc overrides the env-seeded defaults at runtime (see runtimeConfigService).
 */
export interface LumenRuntimeConfig {
  /** Whether the /api/lumen routes are served. Deployment can force it via LUMEN_ENABLED. */
  enabled: boolean;
  adminUsername: string;
  adminPassword: string;
  adminAutomationToken: string;
  requestSigningSecret: string;
  requireRequestSigning: boolean;
  acceptUnverifiedPurchases: boolean;
  outemailApiKey: string;
  outemailApiUrl: string;
  appVersion: string;
  sessionTtlDays: number;
  loginCodeTtlSeconds: number;
  adminSessionTtlSeconds: number;
  adminRefreshTtlSeconds: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  devLoginCode: string;
  requestTimestampSkewSeconds: number;
  allowPublicReleaseCheck: boolean;
  outemailFrom: string;
  outemailDisplayName: string;
  outemailDomain: string;
  outemailTimeoutSeconds: number;
  outemailBaseUrl: string;
}

/**
 * 注册邀请码闸门。**仅由 env-manager 的「注册邀请码」分区维护**；REGISTRATION_INVITE_REQUIRED
 * 环境变量只作启动默认值（见 src/config/config.ts），运行期一律以本运行时配置为准。
 */
export interface RegistrationInviteRuntimeConfig {
  /** true = 本地账号注册必须提供有效邀请码；false = 邀请码可选（填了仍然校验）。 */
  required: boolean;
}

/**
 * 首访验证闸门（`config.enableFirstVisitVerification`）。**仅由 env-manager 的「首访验证闸门」分区维护**；
 * ENABLE_FIRST_VISIT_VERIFICATION 环境变量只作启动默认值（见 src/config/config.ts），
 * 运行期一律以本运行时配置为准。它同时是 proxycheck `first_visit_gate` 的前置开关：
 * 关闭后 `ipVerificationService.initializeSession` 直接放行，proxycheck 那条闸门也不再评估
 * （proxycheck 自身的开关在 PROXYCHECK 分区）。影响面比名字大：Turnstile/hCaptcha 校验、
 * 访问令牌签发、`/api/ip-verification` 中间件全部读同一个值。
 */
export interface FirstVisitVerificationRuntimeConfig {
  /** true = 首访需通过 IP/Turnstile 验证；false = 一律视为已验证（放行）。 */
  enabled: boolean;
}

/**
 * Play Integrity 设备证明（`sml_` 客户端登录令牌的 P2 层）。
 *
 * `mode` 默认 `off`：不开就是不校验，行为与 P1 完全一致，因此本分区可以随代码先落地、
 * 由运维在拿到 Google Cloud 服务账号后再逐级升到 `observe` → `enforce`。
 * 校验失败不走"拒绝登录"，而是降级：单代有效期压到 `downgradedTtlHours` 并在响应里
 * 带 `requiresVerification`，客户端据此提前轮换（见 docs/contracts/mobile-token-risk-control.md）。
 */
export interface MobileTokenIntegrityRuntimeConfig {
  /** off = 不校验；observe = 校验并记日志但不下发降级；enforce = 校验并决定降级。 */
  mode: "off" | "observe" | "enforce";
  /** 被证明的应用包名；必须与客户端 applicationId 一致。 */
  packageName: string;
  /** Google Cloud 项目号（Play Integrity 的 cloudProjectNumber）。 */
  cloudProjectNumber: string;
  /** 服务账号邮箱，用于换取 access token。 */
  serviceAccountEmail: string;
  /** 服务账号私钥（PEM）。属于机密，读取时一律掩码。 */
  serviceAccountPrivateKey: string;
  /** 要求的最低设备完整性等级。 */
  minDeviceIntegrity: "MEETS_BASIC_INTEGRITY" | "MEETS_DEVICE_INTEGRITY" | "MEETS_STRONG_INTEGRITY";
  /** 是否要求应用确实来自 Play（appRecognitionVerdict = PLAY_RECOGNIZED）。 */
  requirePlayRecognizedApp: boolean;
  /** 是否要求 Google Play 授权账号（appLicensingVerdict = LICENSED）。 */
  requireLicensedAccount: boolean;
  /** 一次性 nonce 的有效期；过期即判失败。 */
  nonceTtlSeconds: number;
  /** 调用 Google 判定接口的超时。 */
  timeoutMs: number;
  /** 校验链路自身故障（网络/配置缺失）时是否放行；默认 true，用降级换可用性。 */
  failOpen: boolean;
  /** 降级后的单代有效期（小时），取代 90 天。 */
  downgradedTtlHours: number;
  /** 视作"新鲜"的 token 时间戳窗口；超出即判失败。 */
  maxTokenAgeSeconds: number;
}

/**
 * 客户端登录令牌的风险分级轮换（`sml_` 风控 P3 层）。
 *
 * 与 P2 的降级不同：P2 只处理"设备证明没过"，P3 处理"这一代看起来不太对劲"，
 * 手段都只是把下一次轮换提前（24h → 1h），不动单代有效期，也不拒绝任何请求。
 * 因此它在 `MOBILE_TOKEN_INTEGRITY.mode = observe` 时也能单独生效 —— 那正是把
 * "观察到的判定结果"变成实际动作的地方。
 */
export interface MobileTokenRotationRiskRuntimeConfig {
  /** 总开关，默认 false：不开时轮换节奏与 P2 完全一致。 */
  enabled: boolean;
  /** 命中任一风险信号后的轮换间隔（分钟），取代默认的 24 小时。 */
  elevatedIntervalMinutes: number;
  /** 是否把 IP 属地突变算作风险信号。 */
  geoJumpEnabled: boolean;
  /** 属地比对粒度：country 只看国家，region 连省/州一起看。 */
  geoJumpScope: "country" | "region";
  /** 新设备（该账号上首次出现的设备）在多长时间内算"新"。 */
  newDeviceTrustHours: number;
  /** 上一代是在设备证明未通过的情况下签发时，是否把后续代也压在提级节奏上。 */
  carryOverVerificationPending: boolean;
}

/**
 * 账户风险聚合与逐步验证（RC-06 / RC-12 / RC-02 / RC-03）。
 *
 * 阈值全部运行时可调：风控分档一旦写死，调一次阈值就得发版，而误报率必须在真实流量下反复校准
 * （方法论 §五-42 同族：先观察再收紧）。`enabled=false` 时聚合与升档都不发生，只保留字段。
 */
export interface AccountRiskRuntimeConfig {
  /** 总开关。关掉后 `evaluateAccountRisk` 直接返回、不写库、不升档（用于故障注入与观察期）。 */
  enabled: boolean;
  /** 是否在登录成功路径上顺带聚合一次（热路径只读缓存，不外呼上游）。 */
  evaluateOnLogin: boolean;
  /** 聚合窗口（天）：只统计该窗口内见过的登录 IP 信号。 */
  windowDays: number;
  /** `account_ip_signals` 的保留期（天）。取证保留语义，不用 Mongo TTL，由应用层清理任务执行。 */
  ipSignalRetentionDays: number;
  /** 单个登录 IP 的风险分达到该值即计为「高危 IP」。默认与 proxycheck 挑战阈值同口径。 */
  highRiskIpScore: number;
  /** 不同高危 IP 达到该数量才允许升档（单条高危 IP 可能是误报，不做单点判定）。 */
  minDistinctHighRiskIps: number;
  /** 风险分 ≥ 该值升 `watch`。 */
  watchScoreThreshold: number;
  /** 风险分 ≥ 该值升 `restricted`。 */
  restrictedScoreThreshold: number;
  /** 风险分 ≥ 该值建议 `danger`（自动升档不会真的升到 danger，见 `autoEscalationCap`）。 */
  dangerScoreThreshold: number;
  /** 自动升档上限：`watch` | `restricted`。`danger`/`banned` 必须人工确认（§3 升降级规则）。 */
  autoEscalationCap: "watch" | "restricted";
  /** 注册不足该天数的新号至少进 `watch`（§3 触发条件）。 */
  newAccountWatchDays: number;
  /** 升档时签发的 `stepUpUntil` 时长（秒）：到期未续期即退出逐步验证，避免永久卡死用户。 */
  stepUpTtlSeconds: number;
  /** 升档时默认的逐步验证范围（§4.4 / RC-09）。 */
  stepUpMode: "sensitive" | "all-writes" | "all";
  /**
   * 逐步验证闸门总开关，**默认 false**。
   *
   * 审计 §5 B3 明确要求：全站写请求都会过这道闸，豁免漏一个就是断服，
   * 因此必须先在运行时可配里默认关闭、再灰度打开（`true` 之前行为与改动前逐字节一致）。
   */
  stepUpEnabled: boolean;
  /** 挑战令牌有效期（秒，RC-03 建议 120）：过期即需重新弹窗。 */
  stepUpChallengeTtlSeconds: number;
  /** step-up grant 有效期（秒，D22 = 30）：只服务“已排队的那批请求”，排空即废。 */
  stepUpGrantTtlSeconds: number;
  /** 一枚 grant 最多兑换几次（D22：严格等于被阻断的合法票据数，且上限 5）。 */
  stepUpGrantMaxUses: number;
}

/**
 * 安全会话（RC-40 / RC-41 / D18）。
 *
 * 审计要求把原来的 10 分钟 TTL 压到 3～5 分钟、并且**运行时可调**：
 * 管理员做一串敏感操作时会被更频繁地要求重新验证，这个频率必须能在线调，而不是发版。
 * 同时把「会话绑定什么」也做成可配：UA 严格绑定是防令牌被拿到另一环境重放的硬手段，
 * 但极端情况下（企业代理改 UA）可能需要关掉，必须留一个可审计的开关。
 */
export interface SecuritySessionRuntimeConfig {
  /** 安全会话 TTL（秒）。默认 300（5 分钟）；审计要求 3～5 分钟。 */
  ttlSeconds: number;
  /** UA 严格绑定（RC-41 裁决二）：不匹配立即失效，不允许在另一环境重放。 */
  bindUserAgent: boolean;
  /** IP 跨国家/省时是否终止会话（同城异网只记信号，见裁决二）。 */
  revokeOnGeoJump: boolean;
}

export interface RuntimeConfigDefaults {
  ipqs: IpqsRuntimeConfig;
  linuxdo: LinuxDoRuntimeConfig;
  linuxdoCredit: LinuxDoCreditRuntimeConfig;
  googleAuth: GoogleAuthRuntimeConfig;
  deeplx: DeepLXRuntimeConfig;
  nexai: NexaiRuntimeConfig;
  tts: TtsRuntimeConfig;
  ttsProvider: TtsProviderRuntimeConfig;
  email: EmailRuntimeConfig;
  adminSecurity: AdminSecurityRuntimeConfig;
  synapseAndroid: SynapseAndroidRuntimeConfig;
  nexaiSigning: NexaiSigningRuntimeConfig;
  cdictSigning: CdictSigningRuntimeConfig;
  qqGuardSigning: QqGuardSigningRuntimeConfig;
  proxycheck: ProxycheckRuntimeConfig;
  registrationInvite: RegistrationInviteRuntimeConfig;
  firstVisitVerification: FirstVisitVerificationRuntimeConfig;
  mobileTokenIntegrity: MobileTokenIntegrityRuntimeConfig;
  mobileTokenRotationRisk: MobileTokenRotationRiskRuntimeConfig;
  accountRisk: AccountRiskRuntimeConfig;
  securitySession: SecuritySessionRuntimeConfig;
  lumen: LumenRuntimeConfig;
}

export function buildRuntimeConfigDefaults(options: {
  baseUrl: string;
  frontendBaseUrl: string;
  jwtSecret: string;
  adminPassword: string;
  serverStatusPassword: string;
  publicShortUrlEnabled: boolean;
  publicShortUrlPassword?: string;
  generationCode: string;
  ttsProvider?: string;
  ttsDefaultModel?: string;
  openAiDefaultModel?: string;
  fishAudioApiKey?: string;
  fishAudioBaseUrl?: string;
  fishAudioReferenceId?: string;
  fishAudioModel?: string;
  email: EmailRuntimeConfig;
  googleClientId?: string;
  nexaiGoogleClientId?: string;
  synapseAndroidPackageName?: string;
  synapseAndroidSha256CertFingerprints?: string[];
  synapseAndroidGoogleClientId?: string;
  synapseAndroidDisabled?: boolean;
}): RuntimeConfigDefaults {
  const normalizedBaseUrl = options.baseUrl.replace(/\/+$/, "");
  const normalizedFrontendBaseUrl = options.frontendBaseUrl.replace(/\/+$/, "");
  const googleClientId = (options.googleClientId || "").trim();
  const nexaiGoogleClientId = (options.nexaiGoogleClientId || options.googleClientId || "").trim();
  const synapseAndroidSha256CertFingerprints =
    options.synapseAndroidSha256CertFingerprints?.map((item) => item.trim()).filter(Boolean) || [];
  const ttsProvider = normalizeTtsProviderId(options.ttsProvider, "openai");
  const providerModelFallback =
    ttsProvider === "fish"
      ? normalizeTtsModelId(options.fishAudioModel, FISH_AUDIO_DEFAULT_MODEL)
      : ttsProvider === "edge"
        ? EDGE_MODEL_ID
        : normalizeTtsModelId(options.openAiDefaultModel, "tts-1");
  const ttsDefaultModel = normalizeTtsModelId(
    options.ttsDefaultModel || (ttsProvider === "openai" ? options.openAiDefaultModel : undefined),
    providerModelFallback,
  );

  return {
    ipqs: {
    apiKeys: [],
      scamalyticsUser: "happyclovo",
      enabled: false,
      strictness: 1,
      allowPublicAccessPoints: false,
      lighterPenalties: true,
      timeoutMs: 8000,
      monthlyQuotaPerKey: 5000,
      challengeFraudScore: 75,
      tokenTtlMinutes: 40,
      failOpen: false,
    },
    linuxdo: {
      clientId: "",
      clientSecret: "",
      discoveryUrl: "https://connect.linux.do/.well-known/openid-configuration",
      scopes: "openid profile email",
      authorizationEndpoint: "https://connect.linux.do/oauth2/authorize",
      tokenEndpoint: "https://connect.linux.do/oauth2/token",
      userEndpoint: "https://connect.linux.do/api/user",
      forumBaseUrl: "https://linux.do",
      callbackUrl: `${normalizedBaseUrl}/api/auth/linuxdo/callback`,
      frontendCallbackUrl: `${normalizedFrontendBaseUrl}/auth/linuxdo/callback`,
    },
    linuxdoCredit: {
      enabled: false,
      pid: "",
      key: "",
      protocol: "epay",
      gatewayBase: "https://credit.linux.do/epay",
      privateKey: "",
      creditRate: 1,
      maxMoney: 10000,
      notifyUrl: `${normalizedBaseUrl}/api/linuxdo-credit/notify`,
      returnUrl: `${normalizedFrontendBaseUrl}/api-keys`,
    },
    googleAuth: {
      clientId: googleClientId,
    },
    deeplx: {
      baseUrl: "https://api.deeplx.org",
      apiKey: "",
    },
    nexai: {
      jwtSecret: `${options.jwtSecret}_nexai`,
      jwtExpiresIn: "2h",
      refreshExpiresIn: "30d",
      google: {
        clientId: nexaiGoogleClientId,
      },
      github: {
        clientId: "",
        clientSecret: "",
      },
      frontendUrl: normalizedFrontendBaseUrl,
    },
    tts: {
      generationCode: options.generationCode,
    },
    ttsProvider: {
      provider: ttsProvider,
      enabledProviders: [ttsProvider],
      defaultModel: ttsDefaultModel,
      fish: {
        apiKey: options.fishAudioApiKey?.trim() || "",
        baseUrl: normalizeFishAudioBaseUrl(options.fishAudioBaseUrl, FISH_AUDIO_DEFAULT_BASE_URL),
        referenceId: options.fishAudioReferenceId?.trim() || "",
        catalog: {},
      },
      edge: {
        baseUrl: EDGE_DEFAULT_BASE_URL,
        defaultVoice: EDGE_DEFAULT_VOICE,
        voices: [],
      },
    },
    email: {
      ...options.email,
    },
    adminSecurity: {
      operationPassword: options.adminPassword,
      operationPasswordHash: "",
      serverStatusPassword: options.serverStatusPassword,
      serverStatusPasswordHash: "",
      publicShortUrlEnabled: options.publicShortUrlEnabled,
      publicShortUrlPassword: options.publicShortUrlPassword || "",
      publicShortUrlPasswordHash: "",
    },
    synapseAndroid: {
      packageName: options.synapseAndroidPackageName?.trim() || "com.chloemlla.synapse.mobile",
      sha256CertFingerprints:
        synapseAndroidSha256CertFingerprints.length > 0
          ? synapseAndroidSha256CertFingerprints
          : ["E9:D8:5A:D2:52:C3:8D:86:C6:E4:B2:A8:C0:49:B8:B5:A9:FA:79:AC:6E:BB:11:8C:94:0A:83:03:B6:96:39:98"],
      googleClientId: options.synapseAndroidGoogleClientId?.trim() || "",
      disabled: options.synapseAndroidDisabled === true,
    },
    nexaiSigning: {
      mode: "soft",
      appSignSecret: "",
      appSignSecretPrev: "",
      maxDriftMs: 5 * 60 * 1000,
    },
    cdictSigning: {
      mode: "soft",
      appSignSecret: "",
      appSignSecretPrev: "",
      maxDriftMs: 5 * 60 * 1000,
    },
    qqGuardSigning: {
      token: "",
      alertEmails: "",
    },
    proxycheck: {
      enabled: false,
      // 空串 = 未配置。曾经写成字面量 "api"，会让 hasApiKey 误报为「已设置」，
      // 并绕过「!apiKey → not_configured」的判据，带着 key=api 真打上游换来 failed。
      apiKey: "",
      publicApiKey: "",
      payloadVerificationKey: "",
      hmacSecret: "",
      cacheTtlHours: 24,
      timeoutMs: 8000,
      dailyQuotaPerKey: 1000,
      challengeRiskScore: 66,
      blockRiskScore: 90,
      failOpen: true,
      usePublicKeyForClient: true,
    },
    // 默认关闭：存量部署未显式配置时不得凭空收紧注册入口（env 由 config.ts 覆盖）。
    registrationInvite: {
      required: false,
    },
    // 默认开启：与「ENABLE_FIRST_VISIT_VERIFICATION 未设置 = true」的历史默认值一致，
    // 存量部署未显式配置时不得凭空放宽首访验证（env 由 config.ts 覆盖）。
    firstVisitVerification: {
      enabled: true,
    },
    // 默认 off：没有 Google Cloud 服务账号的环境必须与 P1 行为完全一致，
    // 只有运维显式升到 observe / enforce 才会参与判定。
    mobileTokenIntegrity: {
      mode: "off",
      packageName: options.synapseAndroidPackageName?.trim() || "com.chloemlla.synapse.mobile",
      cloudProjectNumber: "",
      serviceAccountEmail: "",
      serviceAccountPrivateKey: "",
      minDeviceIntegrity: "MEETS_DEVICE_INTEGRITY",
      requirePlayRecognizedApp: true,
      requireLicensedAccount: false,
      nonceTtlSeconds: 300,
      timeoutMs: 5000,
      failOpen: true,
      downgradedTtlHours: 24,
      maxTokenAgeSeconds: 600,
    },
    // 默认开启聚合（配置阈值本身就等于“已打开”的现状），但自动升档的上限默认封在 watch：
    // 先观察真实误报率，再由运维显式放宽到 restricted（§5 B7 的 Shadow Mode 要求）。
    accountRisk: {
      enabled: true,
      evaluateOnLogin: true,
      windowDays: 30,
      ipSignalRetentionDays: 180,
      highRiskIpScore: 66,
      minDistinctHighRiskIps: 2,
      watchScoreThreshold: 50,
      restrictedScoreThreshold: 80,
      dangerScoreThreshold: 90,
      autoEscalationCap: "watch",
      newAccountWatchDays: 7,
      stepUpTtlSeconds: 3600,
      stepUpMode: "sensitive",
      // 默认关闭：闸门全站生效，漏一个豁免就是断服（§5 B3），必须先灰度。
      stepUpEnabled: false,
      stepUpChallengeTtlSeconds: 120,
      stepUpGrantTtlSeconds: 30,
      stepUpGrantMaxUses: 5,
    },
    // RC-40：从 10 分钟压到 5 分钟（审计要求 3～5 分钟）；UA 严格绑定默认开。
    securitySession: {
      ttlSeconds: 300,
      bindUserAgent: true,
      revokeOnGeoJump: true,
    },
    // 默认关：不配置就完全沿用 24 小时节奏，只有运维显式打开才会出现提级轮换。
    mobileTokenRotationRisk: {
      enabled: false,
      elevatedIntervalMinutes: 60,
      geoJumpEnabled: true,
      geoJumpScope: "country",
      newDeviceTrustHours: 24,
      carryOverVerificationPending: true,
    },
    lumen: {
      enabled: false,
      adminUsername: "admin",
      adminPassword: "",
      adminAutomationToken: "",
      requestSigningSecret: "",
      requireRequestSigning: false,
      acceptUnverifiedPurchases: false,
      outemailApiKey: "",
      outemailApiUrl: "",
      appVersion: "0.1.0",
      sessionTtlDays: 90,
      loginCodeTtlSeconds: 300,
      adminSessionTtlSeconds: 3600,
      adminRefreshTtlSeconds: 604800,
      accessTokenTtlSeconds: 7200,
      refreshTokenTtlSeconds: 2592000,
      devLoginCode: "",
      requestTimestampSkewSeconds: 300,
      allowPublicReleaseCheck: true,
      outemailFrom: "noreply",
      outemailDisplayName: "Project Lumen",
      outemailDomain: "",
      outemailTimeoutSeconds: 10,
      outemailBaseUrl: "https://chloemlla.com",
    },
  };
}

export function cloneRuntimeConfigDefaults(config: RuntimeConfigDefaults): RuntimeConfigDefaults {
  return {
    ipqs: {
      ...config.ipqs,
      apiKeys: [...config.ipqs.apiKeys],
      scamalyticsUser: config.ipqs.scamalyticsUser,
    },
    linuxdo: {
      ...config.linuxdo,
    },
    linuxdoCredit: {
      ...config.linuxdoCredit,
    },
    googleAuth: {
      ...config.googleAuth,
    },
    deeplx: {
      ...config.deeplx,
    },
    nexai: {
      ...config.nexai,
      google: {
        ...config.nexai.google,
      },
      github: {
        ...config.nexai.github,
      },
    },
    tts: {
      ...config.tts,
    },
    ttsProvider: {
      ...config.ttsProvider,
      enabledProviders: [
        ...(config.ttsProvider.enabledProviders ?? [config.ttsProvider.provider]),
      ],
      fish: {
        ...config.ttsProvider.fish,
        catalog: {
          ...config.ttsProvider.fish.catalog,
          ...(config.ttsProvider.fish.catalog?.modelRequest
            ? { modelRequest: { ...config.ttsProvider.fish.catalog.modelRequest, headers: { ...config.ttsProvider.fish.catalog.modelRequest.headers } } }
            : {}),
          ...(config.ttsProvider.fish.catalog?.defaultVoicesRequest
            ? { defaultVoicesRequest: { ...config.ttsProvider.fish.catalog.defaultVoicesRequest, headers: { ...config.ttsProvider.fish.catalog.defaultVoicesRequest.headers } } }
            : {}),
        },
      },
      edge: {
        ...config.ttsProvider.edge,
        voices: config.ttsProvider.edge.voices.map((entry) => ({ ...entry })),
      },
    },
    email: {
      ...config.email,
    },
    adminSecurity: {
      ...config.adminSecurity,
    },
    synapseAndroid: {
      ...config.synapseAndroid,
      sha256CertFingerprints: [...config.synapseAndroid.sha256CertFingerprints],
    },
    nexaiSigning: {
      ...config.nexaiSigning,
    },
    cdictSigning: {
      ...config.cdictSigning,
    },
    qqGuardSigning: {
      ...config.qqGuardSigning,
    },
    proxycheck: {
      ...config.proxycheck,
    },
    registrationInvite: {
      ...config.registrationInvite,
    },
    firstVisitVerification: {
      ...config.firstVisitVerification,
    },
    mobileTokenIntegrity: {
      ...config.mobileTokenIntegrity,
    },
    mobileTokenRotationRisk: {
      ...config.mobileTokenRotationRisk,
    },
    accountRisk: {
      ...config.accountRisk,
    },
    securitySession: {
      ...config.securitySession,
    },
    lumen: {
      ...config.lumen,
    },
  };
}
