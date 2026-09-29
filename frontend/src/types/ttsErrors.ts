/**
 * TTS 后端结构化错误的可挽救错误码与承载类。
 *
 * 后端 sendStructuredError 在响应体 code 字段回传错误码；useTts 把它挂到抛出的
 * TtsApiError.code 上，调用方据此走补救流程（如政策同意门禁），而不是只弹文案。
 * 单独成模块，避免表单为识别错误码而依赖整个 useTts（含 axios 实例与拦截器）。
 */
export const TTS_POLICY_CONSENT_REQUIRED = "TTS_POLICY_CONSENT_REQUIRED";

export class TtsApiError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "TtsApiError";
    this.code = code;
  }
}
