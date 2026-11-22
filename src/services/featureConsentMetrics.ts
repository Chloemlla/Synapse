import { FEATURE_CONSENT_KEYS, type FeatureConsentKey } from "../config/featureConsent";

/**
 * 功能门禁拒绝计数（进程内，管理端只读视图）。
 *
 * 为什么要它：`/admin/policy-consents` 的「功能门禁」页签需要回答
 * 「现在哪个功能在挡人」，否则运维只能在用户报障后逐个试。
 *
 * 为什么**不**写库：
 *   1. 写库会把「用户没同意条款」变成安全事件 —— 它既不是攻击信号，也不该参与风险评分；
 *   2. 这是纯观测指标，丢了也不影响任何业务判定，不值得为它在热路径上加一次写入。
 * 代价：多实例各自计数、进程重启清零。页面必须如实标注这个口径，
 * 不能把「本进程计数」渲染成「全网人数」。
 */

const startedAt = Date.now();

interface Counter {
  count: number;
  lastAt: number;
}

const counters = new Map<string, Counter>();

/** 记录一次拒绝（在 403 分支调用；调用方负责不阻塞响应）。 */
export function recordFeatureConsentDenial(feature: string): void {
  const key = feature || "unknown";
  const current = counters.get(key);
  if (current) {
    current.count += 1;
    current.lastAt = Date.now();
    return;
  }
  counters.set(key, { count: 1, lastAt: Date.now() });
}

export interface FeatureConsentDenialSnapshot {
  /** 计数自哪个时刻开始（进程启动/首次加载本模块）。 */
  since: string;
  /** 全部拒绝次数（含未登记的功能键）。 */
  total: number;
  byFeature: Array<{ feature: string; count: number; lastAt: string | null }>;
  /** 口径说明：页面直接展示，避免把进程内计数误读成全网。 */
  note: string;
}

const KNOWN_KEYS = new Set<string>(FEATURE_CONSENT_KEYS);

export function getFeatureConsentDenialSnapshot(): FeatureConsentDenialSnapshot {
  const byFeature = [...counters.entries()]
    .map(([feature, counter]) => ({
      feature,
      count: counter.count,
      lastAt: counter.lastAt > 0 ? new Date(counter.lastAt).toISOString() : null,
      known: KNOWN_KEYS.has(feature),
    }))
    // 未登记的功能键排在最后（它们多半是拼错的名字，不该混进正常排序里误导排查），
    // 同组内按次数倒序。
    .sort((a, b) => Number(a.known) - Number(b.known) || b.count - a.count)
    .map(({ feature, count, lastAt }) => ({ feature, count, lastAt }));

  return {
    since: new Date(startedAt).toISOString(),
    total: byFeature.reduce((sum, item) => sum + item.count, 0),
    byFeature,
    note:
      "本进程自启动以来累计的「因缺少同意被拒」次数，按功能聚合；多实例各自计数、重启清零。" +
      "它是请求次数而不是人数（同一用户多次请求会重复计数），不能当作「有多少用户被挡」。",
  };
}

/** 仅供用例清理全局状态。 */
export function resetFeatureConsentDenialsForTests(): void {
  counters.clear();
}
