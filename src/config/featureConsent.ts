/**
 * 「按用户自己的同意开放功能」的功能 ↔ 政策文件映射（叶节点模块）。
 *
 * 为什么单独成文件、且只依赖 `./policyMeta`：功能门禁（`middleware/featureConsent.ts`）、
 * 同意服务（`services/policyConsentService.ts`）、路由与用例都要读同一份映射；写两处必然漂移。
 * 这里不 import mongoose / service，避免 `config → service → config` 的循环 import
 * （`config/policyMeta.ts` 已是同样的取舍）。
 *
 * 分类规则（判断某个功能该不该设门禁、该要求哪几份文件时按这张表走，别按「像不像敏感功能」拍脑袋）：
 *
 * - `content-upload`（用户内容上传到服务端处理）→ `usage` + `specific-terms`
 *   依据：usage 约定内容合规与禁止滥用；specific-terms 约定具体能力与配额/权限。
 * - `content-publish`（用户内容对外发布 / 分发）→ `usage` + `specific-terms`
 *   依据：specific-terms 点名了短链公共入口的义务；对外分发还需要 usage 的内容合规。
 * - `third-party-transfer`（内容交由第三方处理，含跨境）→ `usage` + `specific-terms`
 *   依据：specific-terms 的「TTS 文本与结果使用 / 接口调用方责任」与 terms 的
 *   「第三方服务与数据跨境」条款。
 * - `account-credential`（账号、凭据、开放接口与配额）→ `terms` + `specific-terms`
 *   依据：terms 的「账户、凭据与安全会话」责任归属 + specific-terms 的接口调用方合规责任。
 * - `personal-data`（采集 / 上报个人数据与风控）→ `terms` + `specific-terms`
 *   依据：terms 的隐私与数据处理章节 + specific-terms 的第三方处理。
 * - 纯本地 / 无个人数据的功能**不设门禁**：过度门禁会稀释机制 —— 用户在一连串无意义的勾选里
 *   学会闭眼点「同意」，真正重要的那一次门禁也就失去了作用。计算器这类功能不该出现在本文件里。
 *
 * 没有任何功能要求 `supported-regions`：那是平台级的可用地区声明，不是某个功能单独的用户义务，
 * 把它塞进门禁只会让「某功能在部分地区不可用」与「你是否同意条款」两件事混成一件事。别随手加上。
 */
import type { PolicyAgreementKey } from "./policyMeta";

/** 门禁分类：新增功能时先归类，再照分类规则取该要求的文件。 */
export const FEATURE_CONSENT_CATEGORIES = [
  "content-upload",
  "content-publish",
  "third-party-transfer",
  "account-credential",
  "personal-data",
] as const;
export type FeatureConsentCategory = (typeof FEATURE_CONSENT_CATEGORIES)[number];

/**
 * 分类 → 该分类要求勾选的文件。这是规则本身（上面注释的文字版），供配置自检对账：
 * 某个功能的 `agreements` 与它所属分类对不上时，用例要能直接报出来，而不是等用户发现门禁放错了。
 */
export const FEATURE_CONSENT_CATEGORY_AGREEMENTS: Record<FeatureConsentCategory, PolicyAgreementKey[]> = {
  "content-upload": ["usage", "specific-terms"],
  "content-publish": ["usage", "specific-terms"],
  "third-party-transfer": ["usage", "specific-terms"],
  "account-credential": ["terms", "specific-terms"],
  "personal-data": ["terms", "specific-terms"],
};

export const FEATURE_CONSENT_KEYS = [
  "doc-tool",
  "image-upload",
  "ipfs-upload",
  "transcribe",
  "tts-generate",
  "deeplx-translate",
  "shorturl",
  "api-access",
  "cdk-redeem",
  "data-report",
] as const;
export type FeatureConsentKey = (typeof FEATURE_CONSENT_KEYS)[number];

export interface FeatureConsentRequirement {
  key: FeatureConsentKey;
  /** 面向用户的短名（入口/chip 用） */
  label: string;
  /** 门禁分类，决定该功能要求哪几份文件（见文件头规则表） */
  category: FeatureConsentCategory;
  /** 该功能要求勾选的政策文件 */
  agreements: PolicyAgreementKey[];
  /** 一句话依据：为什么是这几份文件（含路由证据），前端在「详情」折叠区展示给用户 */
  rationale: string;
  /** 未同意时的中文说明：只讲「要做什么 / 现在什么状态」 */
  message: string;
}

export const FEATURE_CONSENT_REQUIREMENTS: Record<FeatureConsentKey, FeatureConsentRequirement> = {
  "doc-tool": {
    key: "doc-tool",
    label: "文档转换（Markdown → Word）",
    category: "content-upload",
    agreements: ["usage", "specific-terms"],
    rationale: "你上传的 Markdown 会由服务端转换：usage 约定上传内容的合规与禁止滥用，specific-terms 约定这项能力与配额。路由：/api/doc-tool",
    message: "上传到服务端处理前，需要先同意使用政策与服务专项条款。",
  },
  "image-upload": {
    key: "image-upload",
    label: "图片上传与图床",
    category: "content-upload",
    agreements: ["usage", "specific-terms"],
    rationale: "图片会上传到服务端并由服务端入库：usage 约定上传内容的合规，specific-terms 约定这项能力与配额。路由：/api/image-data",
    message: "上传图片到服务端处理前，需要先同意使用政策与服务专项条款。",
  },
  "ipfs-upload": {
    key: "ipfs-upload",
    label: "IPFS 图床对外发布",
    category: "content-publish",
    agreements: ["usage", "specific-terms"],
    rationale: "上传到 IPFS 的图片会通过公开链接对外分发：usage 约定内容合规，specific-terms 约定公共入口的义务。路由：/api/ipfs/upload",
    message: "上传图片并生成对外链接前，需要先同意使用政策与服务专项条款。",
  },
  transcribe: {
    key: "transcribe",
    label: "语音转文本",
    category: "content-upload",
    agreements: ["usage", "specific-terms"],
    rationale: "音频会上传到服务端并交给识别模型处理：usage 约定上传内容的合规，specific-terms 约定这项能力与配额。路由：/api/transcribe",
    message: "上传音频交给服务端识别前，需要先同意使用政策与服务专项条款。",
  },
  "tts-generate": {
    key: "tts-generate",
    label: "文字转语音",
    category: "third-party-transfer",
    agreements: ["usage", "specific-terms"],
    rationale: "提交的文本与合成结果会交由第三方语音服务处理（含跨境）：usage 约定使用合规，specific-terms 约定文本与结果的使用方式。路由：/api/tts",
    message: "把文本交给第三方合成语音前，需要先同意使用政策与服务专项条款。",
  },
  "deeplx-translate": {
    key: "deeplx-translate",
    label: "DeepLX 翻译",
    category: "third-party-transfer",
    agreements: ["usage", "specific-terms"],
    rationale: "待翻译文本会发给第三方翻译服务：usage 约定使用合规，specific-terms 约定调用方责任与配额。路由：/api/deeplx",
    message: "把待翻译文本交给第三方翻译服务前，需要先同意使用政策与服务专项条款。",
  },
  shorturl: {
    key: "shorturl",
    label: "短链创建与跳转",
    category: "content-publish",
    agreements: ["usage", "specific-terms"],
    rationale: "短链会把内容以公开链接对外分发：specific-terms 点名了公共入口的义务，usage 约定分发内容的合规。路由：/api/shorturl",
    message: "创建对外分享的短链前，需要先同意使用政策与服务专项条款。",
  },
  "api-access": {
    key: "api-access",
    label: "开放接口（API Key / OAuth）",
    category: "account-credential",
    agreements: ["terms", "specific-terms"],
    rationale: "开放接口以账号与凭据为责任单位：terms 约定账户、凭据与安全会话的归属责任，specific-terms 约定接口调用方的合规责任与配额。路由：/api/apikeys、/api/oauth",
    message: "申请或使用开放接口前，需要先同意服务条款与服务专项条款。",
  },
  "cdk-redeem": {
    key: "cdk-redeem",
    label: "CDK 兑换与配额",
    category: "account-credential",
    agreements: ["terms", "specific-terms"],
    rationale: "兑换结果直接落到账号配额上：terms 约定账户与凭据的责任归属，specific-terms 约定配额与兑换规则。路由：/api/cdks",
    message: "兑换 CDK 前，需要先同意服务条款与服务专项条款。",
  },
  "data-report": {
    key: "data-report",
    label: "客户端数据上报",
    category: "personal-data",
    agreements: ["terms", "specific-terms"],
    rationale: "客户端上报的数据含设备与使用信息：terms 的隐私与数据处理章节说明采集范围，specific-terms 说明第三方处理。路由：/api/data-collection",
    message: "上报客户端数据前，需要先同意服务条款与服务专项条款。",
  },
};

export function isFeatureConsentKey(value: unknown): value is FeatureConsentKey {
  return typeof value === "string" && (FEATURE_CONSENT_KEYS as readonly string[]).includes(value);
}

/** 该功能要求勾选的文件。返回副本：调用方改返回值不该改到这张表。 */
export function requiredAgreementsFor(feature: FeatureConsentKey): PolicyAgreementKey[] {
  return [...FEATURE_CONSENT_REQUIREMENTS[feature].agreements];
}

/** 给前端的每功能状态（`GET /api/policy/feature-consent` 的元素，也是 403 body 的同源数据） */
export interface FeatureConsentView {
  key: FeatureConsentKey;
  label: string;
  category: FeatureConsentCategory;
  rationale: string;
  message: string;
  satisfied: boolean;
  requiredAgreements: PolicyAgreementKey[];
  /** 该用户还缺哪些（未同意 / 已过期 / 已撤销 / 未勾满） */
  missingAgreements: PolicyAgreementKey[];
  policyVersion: string;
  /** 有效同意记录的到期时间（无有效记录时 null） */
  expiresAt: string | null;
}
