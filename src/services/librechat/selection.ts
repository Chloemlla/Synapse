/**
 * Provider 选路(X3-01/X3-02)——纯函数层。
 *
 * 为什么要从 `libreChatService.buildProviderTryList()` 里抽出来:
 *  - 原来「按 weight 展开 + `shuffleInPlace()`」直接吃 `Math.random`,顺序不可断言,
 *    任何「某个 provider 被排除后走哪个」的行为都无法写单测钉住;
 *  - 能力位(vision)出现后,选路不再只是「随机轮询」,而是「按需求过滤 + 轮询」,
 *    这部分逻辑必须是纯的、可注入的,否则 fail-closed 判定(X1-06)也无处落脚。
 *
 * 本模块不发请求、不读 env/DB(与 `wire.ts` 同一套纪律)。
 */

import { normalizeWire, type ChatWireFormat } from "./wire";

/** 选路所需的最小 provider 形状;`apiKey` 故意不参与任何键计算。 */
export interface ProviderCandidate {
  baseUrl: string;
  apiKey?: string;
  model: string;
  wire?: string;
  enabled?: boolean;
  weight?: number;
  group?: string;
  vision?: boolean;
}

export interface ProviderRequirement {
  /** 需要能吃图的 provider(X1);为真时没有 vision 能力位的一律不入选。 */
  requireVision?: boolean;
  /** 只用该分组的 provider;空串/未给 = 不按分组过滤。 */
  group?: string;
  /** 排除这些 `providerKey()`(多票轮询里排掉已用过的,X3-07)。 */
  exclude?: readonly string[];
  /** 结果条数上限;未给 = 不限。 */
  limit?: number;
}

export interface ResolvedProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
  wire: ChatWireFormat;
  vision: boolean;
  /** 该条来自数据库还是环境变量兜底(诊断用,不参与选路判定)。 */
  source: "db" | "env";
}

/**
 * provider 的稳定标识:X3-04 之后的排除、X3-07 的「这票来自哪个模型」都靠它。
 *
 * 只含 host + model,**永不含 apiKey** —— 这个值会被塞进诊断对象、评测报告、
 * 也许还有管理端界面,凭据一旦进来就再也洗不干净了。
 */
export function providerKey(provider: Pick<ResolvedProvider, "baseUrl" | "model">): string {
  let host = String(provider.baseUrl || "").trim();
  try {
    host = new URL(host).host;
  } catch {
    host = host.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  }
  return `${String(provider.model || "").trim()}@${host}`;
}

/** weight 收敛到 [1,10]:与既有 `buildProviderTryList` 的口径保持一致,不改变现状分布语义。 */
function weightOf(provider: ProviderCandidate): number {
  const raw = Number(provider.weight ?? 1);
  if (!Number.isFinite(raw)) return 1;
  return Math.min(10, Math.max(1, Math.trunc(raw)));
}

/** 能力/分组/排除三重过滤 + 按 weight 展开成可抽签的池。 */
export function expandByWeight<T extends ProviderCandidate>(pool: readonly T[], requirement: ProviderRequirement = {}): T[] {
  const excluded = requirement.exclude?.length ? new Set(requirement.exclude) : null;
  const group = typeof requirement.group === "string" ? requirement.group.trim() : "";
  const eligible = pool.filter((provider) => {
    if (provider.enabled === false) return false;
    if (!provider.baseUrl || !provider.model) return false;
    if (requirement.requireVision && provider.vision !== true) return false;
    if (group && String(provider.group || "") !== group) return false;
    if (excluded && excluded.has(providerKey(provider as Pick<ResolvedProvider, "baseUrl" | "model">))) return false;
    return true;
  });
  const expanded: T[] = [];
  for (const provider of eligible) {
    const times = weightOf(provider);
    for (let i = 0; i < times; i += 1) expanded.push(provider);
  }
  return expanded;
}

/**
 * 注入式洗牌(X3-01):同种子 → 同顺序。
 *
 * 与旧 `shuffleInPlace()` 的区别是**不改动入参** —— 纯函数在测试里被反复调用时,
 * 原地打乱会让「同一输入第二次跑出不同顺序」这种污染极难定位。
 */
export function shuffleWithRandom<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const roll = Number(random());
    const j = Number.isFinite(roll) ? Math.min(i, Math.max(0, Math.floor(roll * (i + 1)))) : 0;
    const swap = result[i];
    result[i] = result[j];
    result[j] = swap;
  }
  return result;
}

function resolveOne(provider: ProviderCandidate, source: ResolvedProvider["source"]): ResolvedProvider {
  return {
    baseUrl: String(provider.baseUrl || "").replace(/\/+$/, ""),
    apiKey: String(provider.apiKey || ""),
    model: String(provider.model || ""),
    wire: normalizeWire(provider.wire),
    vision: provider.vision === true,
    source,
  };
}

/** 去重口径:同一 (host, model, wire) 只算一个候选,避免 weight 展开后连着试同一个模型。 */
function dedupeProviders(providers: ResolvedProvider[]): ResolvedProvider[] {
  const seen = new Set<string>();
  const out: ResolvedProvider[] = [];
  for (const provider of providers) {
    const fingerprint = `${providerKey(provider)}|${provider.wire}|${provider.source}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(provider);
  }
  return out;
}

export interface BuildTryListInput<T extends ProviderCandidate> {
  pool: readonly T[];
  /** 环境变量兜底 provider(没配就传 null)。 */
  envProvider?: T | null;
  /** true = env 排最前(老语义 `envFallbackFirst`)。 */
  envFirst?: boolean;
  requirement?: ProviderRequirement;
  random?: () => number;
}

/**
 * 构造一次调用的 provider 尝试序列。
 *
 * 先洗牌再按 `limit` 截断:反过来(limit 在前)会让"只要 N 票"时永远只看见池子里
 * 排在前面的那几个 provider,轮询与故障分担就失效了。
 */
export function buildTryList<T extends ProviderCandidate>(input: BuildTryListInput<T>): ResolvedProvider[] {
  const requirement = input.requirement || {};
  const shuffled = shuffleWithRandom(expandByWeight(input.pool, requirement), input.random);
  const dbProviders = shuffled.map((provider) => resolveOne(provider, "db"));
  const env =
    input.envProvider && input.envProvider.baseUrl && input.envProvider.apiKey && input.envProvider.model
      ? [resolveOne(input.envProvider, "env")]
      : [];
  const ordered = input.envFirst ? [...env, ...dbProviders] : [...dbProviders, ...env];
  const deduped = dedupeProviders(ordered);
  const limit = requirement.limit;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) return deduped.slice(0, limit);
  return deduped;
}

/** 池子里到底有没有能满足要求的候选 —— X1-06 的 fail-closed 判定用它,而不是靠请求失败反推。 */
export function hasCapableProvider<T extends ProviderCandidate>(pool: readonly T[], requirement: ProviderRequirement = {}): boolean {
  return expandByWeight(pool, requirement).length > 0;
}
