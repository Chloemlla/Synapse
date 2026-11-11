import { CDictLanguageRequestError, describeCDictLanguageResponse, type CDictLanguageDiagnostic } from "./cdictLanguageDiagnostics";
import { collectCdictLanguageCodes, normalizeCdictLanguageResponse } from "./cdictLanguageResponse";
import { fetchLanguageList } from "./cdictUpstreamService";

/**
 * CDict 语言列表的权威值与降级策略。
 *
 * 2026-11-11 实测：vivo 网关 `/translation/lang/list` 已不对第三方可用 ——
 * `GET` 固定 405，`POST` 固定返回 `200 + {"code":10000,"data":null,"msg":""}`（换了 appId、
 * imei/oaid/vaid、参数去重、`.com.cn` 域名、JSON 请求体、charset 全部同样结果），而同一网关上
 * `/translation/query` 仍 `code:0` 正常，说明不是凭据或网络问题，是语言列表这个接口自身下线/收紧。
 *
 * 语言集合本身是稳定事实，不能因为上游业务错误就让客户端拿不到列表（原行为是整条 502），
 * 所以这里保留上游为主（上游恢复即自愈），失败时回退到与网站翻译器同源的静态集合，
 * 并把降级事实写进响应的 `upstreamDegraded` 与日志，而不是静默吞掉。
 */

/** 与 `frontend/src/components/translate/translationModel.ts` 的 `CDICT_FALLBACK_LANGUAGES` 保持同源。 */
export const CDICT_FALLBACK_LANGUAGE_CODES: readonly string[] = Object.freeze([
  "zh-CHS", "en", "de", "es", "fr", "hi", "id", "it", "ja", "ko", "pt", "ru", "th", "vi",
]);

export type CdictLanguageSource = "upstream" | "fallback";

export interface CdictLanguageListResult {
  /** 已归一化的响应体：`upstream` 时来自上游且已通过业务校验，`fallback` 时为内置集合。 */
  payload: unknown;
  source: CdictLanguageSource;
  /** 最近一次上游响应/失败的诊断快照，用于日志与 CI 探针（不含凭据）。 */
  diagnostic?: CDictLanguageDiagnostic;
  /** 仅 `source === "fallback"`：原始失败原因（含上游业务码，调用方负责脱敏后落日志）。 */
  failureReason?: string;
}

/** 内置集合的响应体：同时给出老客户端认的 `languages` 与 SDK 风格 `data.langs`。 */
export function buildFallbackCdictLanguagePayload(): Record<string, unknown> {
  const codes = [...CDICT_FALLBACK_LANGUAGE_CODES];
  return {
    code: 0,
    retcode: 0,
    success: true,
    languages: codes,
    data: { langs: codes },
    upstreamDegraded: true,
  };
}

/**
 * 取语言列表：上游优先，业务失败/空列表/传输失败一律回退内置集合。
 * 依赖以参数注入，便于在没有网络与凭据的单测里覆盖两条分支。
 */
export async function resolveCdictLanguageList(
  fetcher: (onResponse?: (diagnostic: CDictLanguageDiagnostic) => void) => Promise<unknown> = fetchLanguageList,
): Promise<CdictLanguageListResult> {
  let diagnostic: CDictLanguageDiagnostic | undefined;
  let upstream: unknown;
  try {
    upstream = await fetcher((next) => { diagnostic = next; });
  } catch (error) {
    const details = error instanceof CDictLanguageRequestError
      ? error.diagnostic
      : diagnostic ?? describeCDictLanguageResponse(upstream, []);
    return {
      payload: buildFallbackCdictLanguagePayload(),
      source: "fallback",
      diagnostic: details,
      failureReason: error instanceof Error ? error.message : "上游语言列表请求失败",
    };
  }
  try {
    return { payload: normalizeCdictLanguageResponse(upstream), source: "upstream", diagnostic };
  } catch (error) {
    return {
      payload: buildFallbackCdictLanguagePayload(),
      source: "fallback",
      diagnostic: diagnostic ?? describeCDictLanguageResponse(upstream, []),
      failureReason: error instanceof Error ? error.message : "上游语言列表不可用",
    };
  }
}

/** 归一化后的列表非空校验，供控制器与 CI 探针共用。 */
export function hasUsableCdictLanguages(payload: unknown): boolean {
  return collectCdictLanguageCodes(payload).length > 0;
}
