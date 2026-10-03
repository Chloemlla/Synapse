import crypto from "node:crypto";
import {
  CONSENT_VALIDITY_DAYS,
  CURRENT_POLICY_VERSION,
  type PolicyAgreementKey,
  policyAgreementAnchor,
} from "./policyMeta";
import {
  PRIVACY_DATASETS,
  PRIVACY_DATA_CATEGORY_ORDER,
  PRIVACY_DATA_MAP_UPDATED_AT,
  type PrivacyDataMapDataset,
} from "../generated/privacyDataMap";

// 服务条款与隐私政策的唯一来源：接口（GET /api/policy/document）与前端页面共用同一份条文，
// 避免「用户同意的是 2.x 版」与「页面上读到的条文」各写一份而悄悄分叉。
// 条文里涉及的数据实践必须与 docs/governance/privacy-data-map.json 对得上，
// 该文件由 check:privacy-contract 校验，改动任一侧时同步另一侧。
//
// 版本号 / 有效期 / 四份必读文件的键名来自 config/policyMeta（叶节点模块），
// 这样「条文指纹」（documentHash）可以在本文件里算出来而不引入循环 import。

export type PolicyEmphasis = "normal" | "notice" | "critical";

export type PolicyIconKey =
  | "info"
  | "service"
  | "account"
  | "conduct"
  | "privacy"
  | "third-party"
  | "retention"
  | "rights"
  | "cookies"
  | "enforcement"
  | "copyright"
  | "liability"
  | "changes"
  | "law"
  | "contact";

export interface PolicySection {
  /** 锚点 id，前端渲染为 #policy-<id>，改变它等于改变可分享链接 */
  id: string;
  title: string;
  summary: string;
  icon: PolicyIconKey;
  emphasis?: PolicyEmphasis;
  items: string[];
}

export interface PolicyHighlight {
  title: string;
  body: string;
  icon: PolicyIconKey;
}

export interface PolicyWarning {
  title: string;
  body: string;
  icon: PolicyIconKey;
}

export interface PolicyRevision {
  version: string;
  date: string;
  changes: string[];
}

export interface PolicyContact {
  label: string;
  email: string;
  scope: string;
}

/**
 * 数据清单条目 = 隐私数据地图里的 userFacing 内容（生成物）。
 *
 * 条文不再手写「我们收集哪些数据」这张表：手写就会与
 * `docs/governance/privacy-data-map.json` 漂移（契约写 60 天、页面写 90 天），
 * 而这份文档正是用户据此判断「要不要同意」的依据。
 */
export type PolicyDataInventoryEntry = PrivacyDataMapDataset;

// 登录/注册时必须逐项勾选的四份文件：key 与前端复选框、同意记录的 agreements 字段一致，
// anchor 是政策页上该文件的锚点（policy-agreement-<key>），sectionIds 指向它覆盖的正文章节。
export interface PolicyAgreement {
  key: PolicyAgreementKey;
  /** 复选框原文，前端按原样渲染，改动等于改变用户同意到的内容 */
  label: string;
  title: string;
  anchor: string;
  summary: string;
  points: string[];
  sectionIds: string[];
}

export interface PolicyProcedures {
  consentValidityDays: number;
  documentEndpoint: string;
  /** 条文存档副本（Markdown）入口：同一份内容，供用户离线保存 */
  documentArchiveEndpoint: string;
  versionEndpoint: string;
  recordConsentEndpoint: string;
  revokeConsentEndpoint: string;
  checkConsentEndpoint: string;
  /** 一次取回「版本 + 本设备同意状态」的合并端点 */
  statusEndpoint: string;
  /** 本设备的同意轨迹（历次同意与撤回） */
  historyEndpoint: string;
}

export interface PolicyDocument {
  version: string;
  /**
   * 条文指纹：对「章节正文 + 勾选项文案 + 重点提示」按稳定键序取的 SHA-256。
   * 同意记录会一并落库，用于事后证明用户同意的是哪一份文本。
   */
  documentHash: string;
  title: string;
  eyebrow: string;
  description: string;
  effectiveDate: string;
  lastUpdated: string;
  historyNote: string;
  procedures: PolicyProcedures;
  highlights: PolicyHighlight[];
  sections: PolicySection[];
  agreements: PolicyAgreement[];
  warnings: PolicyWarning[];
  revisions: PolicyRevision[];
  contacts: PolicyContact[];
  /** 逐项数据清单（来自隐私数据地图，随契约自动更新） */
  dataInventory: PolicyDataInventoryEntry[];
  /** 数据地图最后更新日，供页面标注「清单依据」 */
  dataInventoryUpdatedAt: string;
}

export const POLICY_EFFECTIVE_DATE = "2026-10-03";
export const POLICY_LAST_UPDATED = "2026-10-03";

// ---- 数据清单：由隐私数据地图生成，页面与条文共用同一份事实 ----

/** 账户删除时的处置：机器字段（delete.onUserDelete）→ 面向用户的一句话。 */
function describeDeleteOnUserDelete(value: string): string {
  switch (value) {
    case "delete_document":
      return "删除账户时一并删除";
    case "retain_until_expiry":
      return "按上述期限保留（不随账户删除，因为封禁针对来源）";
    case "retain_until_ttl":
      return "按上述期限保留（到期自动清理）";
    case "not_linked":
      return "与账户不直接关联，因此不会随账户删除而消失";
    case "not_applicable":
      return "按设备/事件而非账户保存，不适用账户级联删除";
    case "not_automated_today":
      return "应随账户删除，目前仍需人工/待补齐";
    case "gap":
      return "应随账户删除，目前仍有缺口（见下文「数据删除的边界」）";
    case "client_only":
      return "只存在于你的浏览器，由你自己清除";
    default:
      return "见下文章节说明";
  }
}

function describeExportable(value: PrivacyDataMapDataset["exportable"]): string {
  // 刻意不带「为什么不能导出」的括号说明：各类数据的原因不同（凭据密文 / 安全遥测 / 按设备保存），
  // 逐个塞进条目会写得似是而非；统一在章节开头与数据清单表下方解释一次。
  if (value === "full") return "可导出";
  if (value === "partial") return "可部分导出（不含凭据材料）";
  return "不提供自助导出";
}

/** 收集 → 用途 → 保存期限 → 导出/删除，一项数据一条。 */
function buildDataInventoryItems(): string[] {
  const items: string[] = [
    "下表逐项列出平台处理的信息：收集什么、为什么收集、保存多久、能否导出以及删除账户时会不会一并删除。它由隐私数据地图自动生成，与后端实际实现同步维护。",
  ];
  for (const category of PRIVACY_DATA_CATEGORY_ORDER) {
    const group = PRIVACY_DATASETS.filter((dataset) => dataset.category === category);
    if (group.length === 0) continue;
    items.push(`【${category}】共 ${group.length} 项。`);
    for (const dataset of group) {
      items.push(
        `${dataset.label}：收集${dataset.what} 用途：${dataset.why} 保存：${dataset.retention} ` +
          `${describeExportable(dataset.exportable)}；${describeDeleteOnUserDelete(dataset.deleteOnUserDelete)}。`,
      );
    }
  }
  items.push(
    `本清单依据隐私数据地图（最后更新 ${PRIVACY_DATA_MAP_UPDATED_AT}）；新增或调整数据实践会同步更新本清单与条文版本号。`,
  );
  return items;
}

export const POLICY_HIGHLIGHTS: PolicyHighlight[] = [
  {
    title: "安全与合规",
    body: "登录、注册、文字转语音与短链等入口都有独立的限流、风控与审计策略；异常行为会被记录，并可能触发自动处置。",
    icon: "enforcement",
  },
  {
    title: "用户权益",
    body: "你可以查阅、更正、导出、删除自己的个人信息，也可以随时撤回同意；具体路径与限制见「用户权利与行使方式」。",
    icon: "rights",
  },
  {
    title: "数据清单透明",
    body: "隐私政策内逐项列出每一类信息的收集内容、用途、保存期限与删除方式，并直接由后端的数据地图生成——页面与实际实现不会各写一份。",
    icon: "privacy",
  },
  {
    title: "责任边界",
    body: "违规内容、凭据泄露、第三方服务故障与不可抗力造成的后果由相应责任方承担；请自行备份重要数据。",
    icon: "liability",
  },
];

export const POLICY_SECTIONS: PolicySection[] = [
  {
    id: "overview",
    title: "协议范围与生效",
    summary: "本页同时构成服务条款与隐私政策；注册、登录或使用任一功能即视为接受本协议。",
    icon: "info",
    items: [
      `本协议自 ${POLICY_EFFECTIVE_DATE} 起生效，当前版本为 ${CURRENT_POLICY_VERSION}，历次修订记录见本页末尾。`,
      "使用平台即表示你已阅读并同意本协议；若不同意，请停止使用并注销账户。",
      "你需要年满 13 周岁；未满 18 周岁应在监护人同意与指导下使用本服务。",
      "平台可能因合规、安全或业务调整变更条款，变更机制见「条款变更与通知」。",
      "本协议适用于网站、接口、移动客户端及平台提供的其他接入方式。",
    ],
  },
  {
    id: "service-scope",
    title: "服务内容与可用性",
    summary: "平台提供文字转语音、短链、资源与相关工具，并按业务需要持续调整能力范围。",
    icon: "service",
    items: [
      "核心功能包括文本转语音、语音参数调整、音频下载、短链创建与跳转、账户与安全设置。",
      "高级功能、资源、第三方集成与配额可能受账户状态、角色权限、运行时配置或外部服务限制。",
      "平台会尽合理努力维持服务可用，但不承诺不中断、无差错；计划内维护、上游故障或不可抗力可能导致暂停。",
      "平台可新增、调整或下线功能，重大调整会通过站内提示或公告说明。",
      "接口调用方需自行保证调用频率与用途合规，并遵守平台公布的限流与鉴权要求。",
    ],
  },
  {
    id: "account",
    title: "账户、凭据与安全会话",
    summary: "账户归注册人持有并对其下所有行为负责；敏感操作除登录态外还需要更强的验证。",
    icon: "account",
    emphasis: "notice",
    items: [
      "密码以 bcrypt 加盐哈希存储，平台不会以明文保存、也不会在接口响应中返回密码或哈希。",
      "平台支持多因素认证：动态验证码（TOTP）、通行密钥（Passkey / WebAuthn）、邮箱验证与备用恢复码。",
      "修改密码、双因素配置、管理员敏感操作等场景需要「安全会话」，即在登录态之外再完成一次真实第二因子验证。",
      "登录凭据通常以 HttpOnly Cookie 或 Bearer 令牌承载，默认有效期 24 小时；移动端长期令牌仅保存哈希，并支持按设备撤销。",
      "请妥善保管账户凭据；发现异常登录、令牌泄露或设备丢失，应立即改密并撤销会话。",
      "因用户自身保管不当、共享账户或授权他人使用导致的损失，由账户持有人承担。",
    ],
  },
  {
    id: "conduct",
    title: "使用规范与禁止行为",
    summary: "你需对上传、转换、创建与分享的内容负责，并不得破坏平台或其他用户的安全。",
    icon: "conduct",
    emphasis: "notice",
    items: [
      "不得生成或传播违法、侵权、色情暴力、恐怖主义、民族歧视、虚假误导或涉及政治敏感的内容。",
      "不得攻击、扫描、探测平台或第三方服务，不得绕过限流、WAF、内容安全、风控与防篡改机制。",
      "不得批量注册、恶意刷量、自动化滥用接口、转售未获授权的服务，或干扰其他用户正常使用。",
      "不得将文字转语音结果用于冒充他人、伪造证据、诈骗或其他侵害他人合法权益的场景。",
      "短链创建需遵守公共入口的口令与限流要求；不得用短链服务分发恶意、欺诈或侵权链接。",
      "发现漏洞请通过官方邮箱负责任地披露，不要在未获授权的情况下测试、利用或公开。",
    ],
  },
  {
    id: "data-collection",
    title: "我们收集与处理的信息",
    summary: "平台按「提供服务 + 安全风控 + 合规审计」的最小必要原则处理信息，不出售、不出租个人信息，也不将其用于第三方广告。",
    icon: "privacy",
    items: [
      "账户信息：用户名、邮箱、角色与权限、账户状态、认证方式配置（不含明文密码）、邮箱验证与双因素开关状态。",
      "登录与安全信息：登录时间、IP、设备与浏览器标识、设备指纹、异常登录与风控判定结果、封禁与限流处置记录。",
      "业务数据：文字转语音任务记录（任务号、发起时间、请求参数、状态与结果位置）、短链及其创建与访问数据、资源兑换与推荐反馈。",
      "合规记录：政策同意记录（版本、时间、条文指纹、勾选的文件与来源）、管理操作审计日志（操作人、动作、模块、IP、时间）。",
      "客户端本地数据：设备指纹缓存与上报去重信息保存在浏览器本地存储中，不随登出自动清除。",
      "安全遥测：为识别代理、VPN、自动化与篡改行为而产生的网络与设备信号（含第三方 IP 风险查询结果）。",
      "逐项清单见下一章「数据清单：我们到底存了什么」：每项均说明收集内容、用途、保存期限与删除方式。",
      "平台不会将上述信息用于第三方广告投放，也不会出售、出租个人信息；不会使用你的文本或音频去训练面向第三方的模型。",
    ],
  },
  {
    id: "data-inventory",
    title: "数据清单：我们到底存了什么",
    summary:
      "逐项列出每一类信息的收集内容、用途、保存期限、可否导出，以及删除账户时会不会一并删除；本清单由隐私数据地图自动生成。",
    icon: "privacy",
    emphasis: "notice",
    items: buildDataInventoryItems(),
  },
  {
    id: "data-use",
    title: "我们如何使用这些信息",
    summary: "只用于提供服务、保障安全、合规审计与产品改进四类目的；不用于广告画像，不向第三方出售。",
    icon: "privacy",
    items: [
      "提供服务：生成与交付语音、创建与解析短链、同步你主动绑定的第三方账号、记忆你的音色偏好（推荐反馈）。",
      "保障安全：识别异常登录、批量注册、自动化滥用、代理/VPN 与页面篡改，并执行限流、人机验证与必要时的临时封禁。",
      "合规与审计：保存政策同意记录（证明你同意的是哪一版条文）与管理操作审计日志（可追责、可复盘）。",
      "产品改进：以聚合或去标识形式了解功能使用与故障情况（例如失败率、耗时分布），不针对个人做营销推荐。",
      "我们不会：向第三方出售或出租你的个人信息；把你的文本/音频用于训练对外提供的模型；根据浏览内容向你投放第三方广告。",
      "发送到上游语音合成服务的只有完成任务所需的文本与语音参数；邮件发送只包含投递所需的收件人地址与正文。",
      "自动化判定会给出结论与依据（如风险分、命中规则）；由于自动处置可能误判，你可以按「风控、自动处置与申诉」申诉。",
    ],
  },
  {
    id: "data-sharing",
    title: "共享、委托处理与对外披露",
    summary: "信息只会交给完成功能必需的受托处理方，或按法律要求披露；我们不为营销目的共享个人信息。",
    icon: "third-party",
    items: [
      "人机验证（Cloudflare Turnstile / hCaptcha / 自建 Cap）：接收验证令牌与必要的请求上下文，用于判断请求是否来自真实用户。",
      "IP 风险识别（IPQS / proxycheck.io）：接收待判定的 IP，返回代理、VPN、Tor 与风险评分；查询结果会缓存以合并重复请求。",
      "邮件投递（Resend 等）：接收收件人地址、主题与正文，用于注册验证、找回密码、安全通知与公告；退信/投诉/退订会记入抑制名单。",
      "语音合成上游（可配置的 OpenAI 兼容接口）：接收待合成文本与音色参数，返回音频。选择哪家上游由部署配置决定。",
      "基础设施（云主机、对象存储、CDN、边缘节点）：承载运行与存储，可能位于中国大陆、美国或其他地区，因此可能发生跨境处理。",
      "法律要求：仅在收到合法有效的要求时依法提供必要范围内的信息，并在法律允许范围内告知你。",
      "主体变更：如发生合并、收购或资产转让，相关信息可能随之转移，我们会继续按本政策保护并提供变更通知。",
      "除上述情形外，未经你同意不会向第三方提供你的个人信息；第三方处理方受其自身条款与隐私政策约束，我们只提供完成该功能所必需的最小范围。",
    ],
  },
  {
    id: "security-measures",
    title: "我们如何保护信息",
    summary: "密码与凭据不以明文保存，敏感字段经加密后入库，密钥由主密钥派生并按用途隔离；权限、审计与保留期均有强制约束。",
    icon: "account",
    items: [
      "密码：一律 bcrypt 加盐哈希存储，接口响应与日志中不会出现密码或其哈希；管理员口令同样不以明文入库。",
      "凭据类数据：如 B 站登录凭据、数据采集原文等以 AES-256-GCM 加密后存储，密钥由单一主密钥按用途（HKDF）派生，轮换时保留上一把供存量解密。",
      "令牌：移动端长期登录令牌只存哈希并可单独撤销；一次性令牌（访问、验证、恢复码）短时有效且用后即废。",
      "后台管理口令仅在**比对**时使用，不再以明文落库，也不在接口中回传明文。",
      "访问控制：管理接口分档（普通管理员 / 超级管理员），页面授权由运行时配置决定；敏感操作需要额外的安全会话或操作口令，并写入审计日志。",
      "链路与外层：全站 HTTPS，请求依次经过 IP 封禁校验、WAF、限流、身份校验与防篡改检测；源代码与镜像不包含你的数据。",
      "保留期约束：可过期的数据由数据库 TTL 自动清理（详见「数据保存期限与删除」）；日志中的敏感字段在写入前经过脱敏与截断。",
      "安全事件：若发生可能影响你权益的数据安全事件，我们会依法采取措施并通过站内提示、公告或邮件告知你（包括影响范围、已采取的措施与你可以做什么）。",
      "安全是双方的事：请开启二次验证、不要在多个站点复用同一密码，并在发现异常登录时立即改密与撤销会话。",
    ],
  },
  {
    id: "minors",
    title: "未成年人保护",
    summary: "服务不面向 13 周岁以下儿童；未成年人在使用前应获得监护人同意，监护人可联系我们行使查阅与删除权利。",
    icon: "info",
    items: [
      "本服务面向年满 13 周岁且能独立承担相应民事责任的使用者；未满 18 周岁应在监护人同意与指导下使用。",
      "我们不会主动向未成年人收集超出服务必要范围的信息，也不会将其用于个性化营销。",
      "若监护人发现未成年人在未获同意的情况下注册或使用本服务，可通过支持邮箱申请查阅、更正或删除相关账户与数据。",
      "若发现账户由 13 周岁以下儿童注册，平台会限制或终止该账户并清理相应数据。",
    ],
  },
  {
    id: "third-party",
    title: "第三方服务与数据跨境",
    summary: "部分能力依赖第三方，必要的技术信息会由这些服务处理，其可用性与合规由其自行负责。",
    icon: "third-party",
    items: [
      "人机验证：Cloudflare Turnstile、hCaptcha 等，用于首访验证与注册保护。",
      "IP 风险识别：IPQS、proxycheck.io 等，用于判断代理、VPN、Tor 与高风险来源。",
      "邮件投递：Resend 等邮件服务，用于注册验证、找回密码与安全通知。",
      "语音合成上游：可配置的 OpenAI 兼容接口（含第三方代理），转语音所需文本会发送给对应服务方。",
      "基础设施：云主机、对象存储、CDN 与边缘节点，可能位于中国大陆、美国或其他地区，相关数据因此可能跨境处理与存储。",
      "平台仅向第三方提供完成该功能所必需的最小信息，并在选择处理方时考虑其安全与合规能力；第三方处理方受其自身条款与隐私政策约束。",
      "除「共享、委托处理与对外披露」列出的情形外，不会向第三方提供你的个人信息；也不会为营销目的共享。",
    ],
  },
  {
    id: "retention",
    title: "数据保存期限与删除",
    summary: "不同数据有不同的保存期限：可过期的按 TTL 自动清理，运营类数据保留至不再必要。",
    icon: "retention",
    emphasis: "notice",
    items: [
      "管理操作审计日志：保留 60 天，到期由数据库 TTL 自动清理（2026-10-03 起由 90 天收窄）。",
      "政策同意记录：默认有效期 30 天，过期后不再视为有效同意，并由 TTL 与清理任务回收；你也可主动撤回并删除本设备记录。",
      "首访与匿名验证数据（临时设备指纹、访问令牌、IP 验证令牌）：按各自有效期自动过期，通常从几分钟到一天。",
      "IP 风险缓存：按缓存有效期自动过期（默认 24 小时，部署可配置 1–168 小时），只为合并重复查询与判定依据。",
      "IP 封禁记录：保留至封禁到期；封禁针对来源而非个人，因此可能长于单个账户的生命周期。",
      "防篡改事件：默认保留 30 天（部署可配置 1–365 天）；同一 IP 一小时内触发 10 次事件会自动封禁。",
      "移动端长期登录令牌：每代 90 天到期清理；轮换超过 30 天的常规 IP 字段会被定期清除。",
      "设备指纹与最近登录信息：随账户保存，删除账户或管理员清空指纹时移除。",
      "文字转语音任务、行为采集与部分安全遥测：默认保留至完成故障排查、队列恢复与支持所需为止，尚未全部接入自动清理。",
      "部分安全遥测（例如第三方 IP 风险查询日志、客户端上报的网络出口探测）目前没有与账户关联的级联删除路径，平台正在补齐；如需强制删除，请通过支持邮箱提出。",
      "账户删除会移除账户文档与可关联的业务数据；审计、封禁等记录可能按上述期限继续保留，以满足安全与合规要求。逐项对应关系见「数据清单」章节。",
      "每类信息的具体期限均可在「数据清单」章节逐项查阅，该清单由隐私数据地图自动生成，与后端实际实现同步维护。",
    ],
  },
  {
    id: "rights",
    title: "用户权利与行使方式",
    summary: "你可以查阅、更正、导出、删除个人信息并撤回同意；平台会在核验身份后按法律要求响应。",
    icon: "rights",
    items: [
      "查阅与更正：可在个人中心查看资料与安全设置，并自行更正其中大部分信息；也可查看本设备的安全自检清单（含恢复码余量、Passkey 与设备数量）。",
      "导出：可通过支持邮箱申请数据副本；导出内容不包含密码哈希、安全令牌等凭据材料。部分数据（如安全遥测）仅供人工排查，不提供自助导出。",
      "删除：可通过支持邮箱申请删除账户或特定数据；删除账户不可恢复，请先自行备份需要的音频与链接。「数据清单」章节逐项标注了删除账户时会一并删除的信息，以及仍需按期限保留的部分。",
      "撤回同意：可在个人中心「隐私与同意」面板自助查看并撤回本设备的同意；也可调用同意撤销接口（需携带签发给你设备的同意凭据），或联系支持邮箱。同意按浏览器设备记录，换设备或清除站点数据后需在本设备重新勾选，或走支持邮箱。撤回后依赖同意的功能会停止处理，并可能需要删除账户。",
      "限制处理与投诉：对平台的处理方式有异议时，可先通过支持邮箱提出，平台会在合理期限内答复；对答复不满时你有权向有管辖权的监管机构投诉。",
      "响应期限：我们会在收到请求并完成身份核验后的合理期限内（通常 15 个工作日内）答复；如请求特别复杂会告知延期与原因。",
      "为保护账户安全，办理上述请求时平台可能要求身份核验、安全会话验证或补充必要信息；涉及他人权利或法律强制保留的部分可能无法删除，我们会告知具体理由。",
    ],
  },
  {
    id: "cookies",
    title: "Cookie 与本地存储",
    summary: "平台只用必要的存储维持登录与安全状态，不使用第三方广告 Cookie。",
    icon: "cookies",
    items: [
      "登录态 Cookie 为 HttpOnly 且带 SameSite 限制，用于维持会话，登出后失效。",
      "政策同意凭据 Cookie 用于证明设备与该同意记录的归属，有效期与同意记录一致。",
      "浏览器本地存储保存设备指纹缓存（缓存 30 天）、上报随机种子与阅读偏好等，用于减少重复验证与保持阅读体验；这些数据只在你自己的设备上，清除站点数据会一并清除。",
      "禁用必要 Cookie 或本地存储会导致无法登录、风控验证失败或功能不可用。",
      "平台不使用第三方广告或跨站追踪 Cookie。",
    ],
  },
  {
    id: "enforcement",
    title: "风控、自动处置与申诉",
    summary: "请求会依次经过封禁校验、WAF、限流、身份校验与防篡改检测，部分处置是自动执行的。",
    icon: "enforcement",
    emphasis: "critical",
    items: [
      "请求链路：IP 封禁校验 → WAF → 限流 → 跨域与身份校验 → 业务处理，各层可独立配置。",
      "首访验证与 IP 风险判定可能要求先完成人机验证；自动化客户端同样需要携带有效的验证令牌。",
      "触发限流、注入特征或篡改检测可能被自动拒绝、记录、临时封禁来源 IP，或限制账户功能。",
      "自动处置基于规则与评分，不排除误判；如果你认为处置有误，请通过支持邮箱说明时间与现象，平台会复核。",
      "平台保留对违规账户限制、暂停或终止服务的权利；严重违规时可能保留证据并依法配合调查。",
    ],
  },
  {
    id: "copyright",
    title: "知识产权与内容权利",
    summary: "平台资产归平台或权利人所有；你保留自有内容的权利，并授权平台为提供服务而必要处理。",
    icon: "copyright",
    items: [
      "平台名称、界面、代码、文档、音频素材与附加材料受著作权、商标权等法律保护。",
      "你上传或输入的文本、链接等内容仍归你或原权利人所有；你授权平台为提供服务、安全风控与故障排查而在必要范围内处理。",
      "生成结果的合法使用由你自行负责；如涉及第三方素材或声音权利，需事先取得授权。",
      "未经授权不得复制、分发、改编平台内容，或用于侵犯权利人的行为。",
      "平台仅接受技术问题反馈，不承诺接受对政策或服务管理的评论；侵权投诉请发送至平台管理邮箱，并附权利证明与定位信息。",
    ],
  },
  {
    id: "liability",
    title: "责任限制与免责",
    summary: "服务按现状提供；在法律允许的最大范围内，平台不对间接损失与第三方原因造成的损失负责。",
    icon: "liability",
    emphasis: "notice",
    items: [
      "服务按「现状」与「现有」提供，平台不对适销性、特定用途适用性或不侵权作默示担保。",
      "因不可抗力、网络故障、云服务或第三方接口中断、政策与监管要求导致的服务异常，平台不承担责任。",
      "平台不对用户生成内容的合法性、准确性负责，也不对用户之间的纠纷承担连带责任。",
      "请在本地妥善保存重要音频与数据；平台不承诺对任何数据提供永久保存或一定能恢复。",
      "在法律允许的最大范围内，平台对可归责损失的责任以你在争议发生前 12 个月内实际支付的服务费用为限。",
    ],
  },
  {
    id: "changes",
    title: "条款变更与通知",
    summary: "条文变更会更新版本号与生效日期，重大变更会在生效前通过站内提示或公告说明。",
    icon: "changes",
    items: [
      "平台会为每次实质修订更新版本号与生效日期，并在本页「历次修订」中列出变更要点。",
      "涉及数据处理范围、用户权利或责任边界的重大变更，会在生效前通过站内提示、公告或邮件通知。",
      "版本号变化意味着此前记录的同意不再覆盖新条文，依赖同意的功能会要求重新同意。",
      "变更生效后继续使用服务，视为你接受修订后的条款；不接受时可停止使用并申请注销账户。",
      "历史版本可在本页修订记录中查看；更早版本可通过支持邮箱索取。",
    ],
  },
  {
    id: "law",
    title: "适用法律与争议解决",
    summary: "本协议适用中华人民共和国大陆地区法律；争议先协商，协商不成按法定管辖处理。",
    icon: "law",
    items: [
      "本协议的订立、效力、解释与争议解决适用中华人民共和国大陆地区法律（不含冲突规范）。",
      "因本协议或服务产生的争议，双方应先友好协商；协商不成的，任一方可向平台运营方所在地有管辖权的法院提起诉讼。",
      "若某一条款被认定无效或不可执行，不影响其余条款的效力。",
      "本协议以中文版本为准；如提供其他语言译本，仅供理解参考。",
    ],
  },
];

export const POLICY_AGREEMENTS: PolicyAgreement[] = [
  {
    key: "terms",
    label: "我已阅读并同意服务条款与隐私政策",
    title: "服务条款与隐私政策",
    anchor: policyAgreementAnchor("terms"),
    summary:
      "本页正文同时构成服务条款与隐私政策：既约定协议范围、服务内容、账户与凭据责任、责任限制与争议解决，也说明我们收集哪些信息、为什么收集、保存多久、与谁共享，以及你如何查阅、导出、删除与撤回同意。",
    points: [
      "服务按「现状」与「现有」提供，平台可新增、调整或下线功能，重大调整会通过站内提示或公告说明。",
      "账户归注册人持有，账户下发生的行为、凭据保管与授权他人使用产生的后果由持有人承担。",
      "责任限制、免责范围与争议解决方式有独立章节，涉及你对损失承担的边界，请重点阅读。",
      "条款变更会更新版本号与生效日期；变更生效后继续使用服务视为接受修订后的条款。",
      "数据处理方式逐项列于「数据清单：我们到底存了什么」，该清单由隐私数据地图自动生成，与后端实际实现同步维护。",
      "你的权利（查阅、更正、导出、删除、撤回同意、申述）与行使路径见「用户权利与行使方式」。",
    ],
    sectionIds: [
      "overview",
      "service-scope",
      "account",
      "data-collection",
      "data-inventory",
      "data-use",
      "data-sharing",
      "security-measures",
      "retention",
      "rights",
      "cookies",
      "minors",
      "liability",
      "law",
    ],
  },
  {
    key: "usage",
    label: "我已阅读并同意使用政策",
    title: "使用政策",
    anchor: policyAgreementAnchor("usage"),
    summary:
      "约定你可以和不可以怎样使用平台：内容合规要求、禁止攻击与绕过安全机制、禁止批量滥用与转售，以及违规后的处置与申诉方式。",
    points: [
      "不得生成或传播违法、侵权、色情暴力、恐怖主义、民族歧视、虚假误导或涉及政治敏感的内容。",
      "不得攻击、扫描、探测平台或第三方服务，不得绕过限流、WAF、内容安全、风控与防篡改机制。",
      "不得批量注册、恶意刷量、自动化滥用接口、转售未获授权的服务，或干扰其他用户正常使用。",
      "违规可能导致功能受限、来源封禁或账户终止；自动处置不排除误判，可通过支持邮箱申诉。",
    ],
    sectionIds: ["conduct", "enforcement"],
  },
  {
    key: "specific-terms",
    label: "我已阅读并同意服务专项条款",
    title: "服务专项条款",
    anchor: policyAgreementAnchor("specific-terms"),
    summary:
      "针对具体能力的附加规则：文字转语音的文本与结果使用、短链公共入口的口令与限流、接口调用方的合规责任，以及配额与权限限制。",
    points: [
      "文字转语音：输入的文本须合法合规，需发送至上游语音服务的文本会按「第三方服务与数据跨境」处理。",
      "生成结果的合法使用由你自行负责；涉及第三方素材或声音权利时需事先取得授权，不得用于冒充他人或伪造证据。",
      "短链：创建需遵守公共入口的口令与限流要求，不得用短链服务分发恶意、欺诈或侵权链接。",
      "接口调用：调用方需自行保证调用频率与用途合规，并遵守平台公布的限流与鉴权要求。",
      "高级功能、资源、第三方集成与配额可能受账户状态、角色权限或运行时配置限制。",
    ],
    sectionIds: ["service-scope", "copyright", "third-party"],
  },
  {
    key: "supported-regions",
    label: "我已阅读并同意支持地区",
    title: "支持地区",
    anchor: policyAgreementAnchor("supported-regions"),
    summary:
      "服务面向可合法使用本服务的国家/地区提供：基础设施跨多个地区部署，相关数据可能跨境处理，部分国家/地区因法律或制裁限制不在服务范围内。",
    points: [
      "服务托管于中国大陆、美国等地的云主机、对象存储、CDN 与边缘节点，相关数据因此可能跨境处理与存储。",
      "因出口管制、制裁或当地法律限制，部分国家/地区无法使用本服务；平台可据此限制访问来源。",
      "你需要自行确认在当地使用本服务合法，并自行承担因违反当地法律产生的后果。",
      "跨境处理涉及的具体服务方与用途，见「第三方服务与数据跨境」。",
    ],
    sectionIds: ["third-party", "law"],
  },
];

export const POLICY_WARNINGS: PolicyWarning[] = [
  {
    title: "撤回同意与账户后果",
    body: "撤回政策同意后，依赖该同意处理数据的功能将停止工作；为彻底停止处理，通常需要一并注销账户。注销会移除账户文档与可关联数据，且不可恢复。",
    icon: "enforcement",
  },
  {
    title: "自动化风控处置",
    body: "限流、封禁与内容拦截由规则自动执行。误判可以申诉，但申诉不会立即解除处置；反复触发会延长封禁时间。",
    icon: "conduct",
  },
  {
    title: "数据删除的边界",
    body: "审计日志、IP 封禁与部分安全遥测不与账户级联删除，会按自身期限继续保留；账户删除不等于「所有相关记录立刻消失」。",
    icon: "retention",
  },
];

export const POLICY_REVISIONS: PolicyRevision[] = [
  {
    version: "2.2",
    date: POLICY_EFFECTIVE_DATE,
    changes: [
      "新增「数据清单：我们到底存了什么」：逐项列出 ${PRIVACY_DATASETS.length} 类信息的收集内容、用途、保存期限、可否导出，以及删除账户时会不会一并删除；该清单由隐私数据地图自动生成。",
      "新增「我们如何使用这些信息」「共享、委托处理与对外披露」「我们如何保护信息」「未成年人保护」四章，把用途、对外提供方、保护措施与未成年人规则写明。",
      "「服务条款」勾选项扩为「服务条款与隐私政策」，使隐私政策部分也落在逐项勾选的同意里（同意记录因此会带上该项）。",
      "修正保留期表述：管理操作审计日志由 90 天收窄为 60 天；补齐 IP 风险缓存、防篡改事件、移动端令牌与首次访问验证数据的逐项期限。",
      "「用户权利与行使方式」补充导出范围、响应期限与投诉渠道；「Cookie 与本地存储」写清本地缓存的用途与期限。",
    ],
  },
  {
    version: "2.1",
    date: POLICY_EFFECTIVE_DATE,
    changes: [
      "新增「数据保存期限与删除」「用户权利与行使方式」「Cookie 与本地存储」三章，把同意有效期、撤回路径与本地存储用途写明。",
      "新增「第三方服务与数据跨境」「风控、自动处置与申诉」两章，说明依赖的第三方、跨境处理与自动化处置的申诉方式。",
      "新增「条款变更与通知」「适用法律与争议解决」，明确变更生效机制与争议处理方式。",
      "新增登录与注册的四份必读文件（服务条款、使用政策、服务专项条款、支持地区），逐项勾选后才允许提交，同意记录带来源与勾选项留档。",
      "细化账户与凭据章节：补充多因素认证、安全会话、移动端令牌与设备撤销的说明。",
      "补充「责任限制与免责」与「知识产权与内容权利」的具体边界，并新增修订记录、生效日期与程序化接口说明。",
    ],
  },
];

export const POLICY_HISTORY_NOTE =
  "更早的条款版本未单独留档，如需历史版本或修订对照，请通过支持邮箱索取。";

export const POLICY_CONTACTS: PolicyContact[] = [
  {
    label: "用户支持",
    email: "support@chloemlla.com",
    scope: "账户问题、数据查阅/导出/删除请求、撤回同意、风控误判申诉",
  },
  {
    label: "平台管理",
    email: "admin@chloemlla.com",
    scope: "侵权投诉、法务与合规事项、安全漏洞披露",
  },
];

export const POLICY_PROCEDURES: PolicyProcedures = {
  consentValidityDays: CONSENT_VALIDITY_DAYS,
  documentEndpoint: "GET /api/policy/document",
  documentArchiveEndpoint: "GET /api/policy/document?format=md",
  versionEndpoint: "GET /api/policy/version",
  recordConsentEndpoint: "POST /api/policy/verify",
  revokeConsentEndpoint: "POST /api/policy/revoke",
  checkConsentEndpoint: "GET /api/policy/check",
  statusEndpoint: "GET /api/policy/status",
  historyEndpoint: "GET /api/policy/history",
};

/**
 * 条文指纹的可哈希载荷。只收「用户实际同意到的实质内容」：
 * 章节正文、四份文件的勾选文案与要点、重点风险提示，以及版本与生效日期。
 * revisions / historyNote / contacts / procedures 刻意不进哈希 —— 补记修订说明、
 * 调整联系方式或接口说明都不应该让存量同意作废。
 */
function buildPolicyHashPayload(): string {
  return JSON.stringify({
    version: CURRENT_POLICY_VERSION,
    effectiveDate: POLICY_EFFECTIVE_DATE,
    lastUpdated: POLICY_LAST_UPDATED,
    agreements: POLICY_AGREEMENTS.map((agreement) => ({
      key: agreement.key,
      label: agreement.label,
      title: agreement.title,
      summary: agreement.summary,
      points: agreement.points,
      sectionIds: agreement.sectionIds,
    })),
    sections: POLICY_SECTIONS.map((section) => ({
      id: section.id,
      title: section.title,
      summary: section.summary,
      emphasis: section.emphasis ?? "normal",
      items: section.items,
    })),
    warnings: POLICY_WARNINGS.map((warning) => ({ title: warning.title, body: warning.body })),
  });
}

export const POLICY_DOCUMENT_HASH = crypto
  .createHash("sha256")
  .update(buildPolicyHashPayload(), "utf8")
  .digest("hex");

export const POLICY_DOCUMENT: PolicyDocument = {
  version: CURRENT_POLICY_VERSION,
  documentHash: POLICY_DOCUMENT_HASH,
  title: "服务条款与隐私政策",
  eyebrow: "Terms And Privacy",
  description:
    "Synapse - 综合服务平台的使用规则、数据处理方式、用户权利、安全限制与联系方式，集中说明于本页。",
  effectiveDate: POLICY_EFFECTIVE_DATE,
  lastUpdated: POLICY_LAST_UPDATED,
  historyNote: POLICY_HISTORY_NOTE,
  procedures: POLICY_PROCEDURES,
  highlights: POLICY_HIGHLIGHTS,
  sections: POLICY_SECTIONS,
  agreements: POLICY_AGREEMENTS,
  warnings: POLICY_WARNINGS,
  revisions: POLICY_REVISIONS,
  contacts: POLICY_CONTACTS,
  dataInventory: PRIVACY_DATASETS.map((dataset) => ({ ...dataset })),
  dataInventoryUpdatedAt: PRIVACY_DATA_MAP_UPDATED_AT,
};
