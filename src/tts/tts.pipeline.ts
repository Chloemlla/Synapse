import crypto from "node:crypto";
import { EDGE_SUPPORTED_FORMATS, FISH_AUDIO_SUPPORTED_FORMATS } from "../config/ttsProviderConfig";
import { ContentFilterService, type ContentFilterResult } from "../services/contentFilterService";
import { AuditLogService } from "../services/auditLogService";
import {
  CURRENT_POLICY_VERSION,
  hasValidPolicyConsent,
  shouldRequireTtsPolicyConsent,
} from "../services/policyConsentService";
import { TurnstileService } from "../services/turnstileService";
import { readCaptchaChallenge } from "../services/turnstile/challenge";
import type { User } from "../utils/userStorage";
import { TtsRequestError } from "./tts.errors";
import { generationHistoryStore } from "./tts.history";
import type { GenerationHistoryStore, QuotaLedger, TtsSettingsStore } from "./tts.ports";
import { buildUsageSummaryFromSnapshot, quotaLedger } from "./tts.quota";
import { ttsSettingsStore } from "./tts.settings";
import type { TtsGovernanceSummary, TtsJobRequestPayload, TtsUsageSummary } from "./tts.storage";
import { TtsService } from "./tts.service";

export interface TtsSubmissionInput {
  text: unknown;
  model: unknown;
  voice: unknown;
  outputFormat: unknown;
  output_format: unknown;
  speed: unknown;
  fingerprint: unknown;
  generationCode: unknown;
  cfToken: unknown;
  /**
   * 本次人机验证令牌 + 供应商（三家共用一套下发链路）。
   * 兼容旧字段：captchaToken / turnstileToken / hcaptchaToken / capToken；
   * 供应商字段只用 captchaProvider / captchaType（裸 provider 是 TTS 提供商，含义不同）。
   */
  captchaToken?: unknown;
  captchaProvider?: unknown;
  /** 用户在前端选择的提供商；老客户端不带该字段。 */
  provider?: unknown;
}

export interface TtsSubmissionContext {
  input: TtsSubmissionInput;
  ip: string;
  currentUser: User | null;
  taskId?: string;
  requestId?: string;
  userAgent?: string;
  path?: string;
  method?: string;
  authenticatedByApiKey?: boolean;
}

export interface TtsSubmissionResult {
  requestPayload: TtsJobRequestPayload;
  ip: string;
  fingerprint: string;
  userId?: string;
  isAdmin?: boolean;
  usageSummary: TtsUsageSummary;
  governance: TtsGovernanceSummary;
  duplicateJobResult?: {
    fileName: string;
    audioUrl: string;
    audioFileId?: string;
    audioStorage?: "file" | "mongo";
    audioMimeType?: string;
    audioSize?: number;
    message: string;
    outputFormat: string;
    provider?: string;
    providerModel?: string;
    providerVoice?: string;
  };
}

export class TtsSubmissionPipeline {
  private readonly ttsService = new TtsService();

  constructor(
    private readonly settingsStore: TtsSettingsStore = ttsSettingsStore,
    private readonly historyStore: GenerationHistoryStore = generationHistoryStore,
    private readonly ledger: QuotaLedger = quotaLedger,
  ) {}

  public async buildUsageSummaryByUserId(userId?: string, isAdmin?: boolean): Promise<TtsUsageSummary> {
    if (!userId) {
      return buildUsageSummaryFromSnapshot(null, null);
    }

    if (isAdmin) {
      return {
        authenticated: true,
        isAdmin: true,
        dailyLimit: null,
        usedToday: null,
        remainingToday: null,
        reservedToday: null,
      };
    }

    const snapshot = await this.ledger.getUsageSnapshot(userId);
    return buildUsageSummaryFromSnapshot(snapshot.user, snapshot);
  }

  // provider 只用于冻结快照的选路，不进入 TtsJobRequestPayload 的既有契约（Mongo schema 会忽略多余键）。
  private buildRequestPayload(input: TtsSubmissionInput): TtsJobRequestPayload & { provider?: string } {
    const normalizedOutputFormat =
      typeof input.outputFormat === "string" && input.outputFormat.trim().length > 0
        ? input.outputFormat.trim()
        : typeof input.output_format === "string" && input.output_format.trim().length > 0
          ? input.output_format.trim()
          : "mp3";

    return {
      text: typeof input.text === "string" ? input.text : "",
      model: typeof input.model === "string" ? input.model : "",
      voice: typeof input.voice === "string" ? input.voice : "",
      outputFormat: this.ttsService.resolveOutputFormat(normalizedOutputFormat),
      speed: this.ttsService.resolveSpeed(input.speed),
      ...(typeof input.provider === "string" ? { provider: input.provider } : {}),
    };
  }

  private validateContentShape(text: string) {
    if (!text) {
      throw new TtsRequestError(400, "文本内容不能为空", "TTS_EMPTY_TEXT");
    }

    if (text.length > 4096) {
      throw new TtsRequestError(400, "文本长度不能超过4096个字符", "TTS_TEXT_TOO_LONG");
    }
  }

  private hashText(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex").slice(0, 24);
  }

  private buildContentSafetySummary(result: ContentFilterResult): NonNullable<TtsGovernanceSummary["contentSafety"]> {
    return {
      decision: result.decision,
      confidence: result.confidence,
      categories: result.categories,
      source: result.source,
      remoteChecked: result.remoteChecked,
      remoteUnavailable: result.remoteUnavailable,
    };
  }

  private async auditGovernanceEvent(params: {
    context: TtsSubmissionContext;
    action: string;
    result: "success" | "failure";
    errorMessage?: string;
    detail: Record<string, unknown>;
  }) {
    const user = params.context.currentUser;
    await AuditLogService.log({
      requestId: params.context.requestId,
      userId: user?.id || "anonymous",
      username: user?.username || "anonymous",
      role: user?.role || "anonymous",
      action: params.action,
      module: "tts",
      result: params.result,
      errorMessage: params.errorMessage,
      detail: params.detail,
      ip: params.context.ip,
      userAgent: params.context.userAgent,
      path: params.context.path,
      method: params.context.method,
    });
  }

  private async validatePolicyConsent(context: TtsSubmissionContext, fingerprint: string) {
    if (!shouldRequireTtsPolicyConsent()) {
      return;
    }

    if (context.currentUser?.role === "admin" || context.currentUser?.role === "superadmin") {
      return;
    }

    const hasConsent = await hasValidPolicyConsent(fingerprint, CURRENT_POLICY_VERSION);
    if (hasConsent) {
      return;
    }

    await this.auditGovernanceEvent({
      context,
      action: "tts.policy.consent_required",
      result: "failure",
      errorMessage: "Missing current policy consent",
      detail: {
        policyVersion: CURRENT_POLICY_VERSION,
        fingerprintHash: this.hashText(fingerprint),
      },
    });

    throw new TtsRequestError(
      403,
      "请先确认最新服务条款与隐私政策后再生成语音",
      "TTS_POLICY_CONSENT_REQUIRED",
    );
  }

  private async validateContentPolicy(
    text: string,
    context: TtsSubmissionContext,
  ): Promise<NonNullable<TtsGovernanceSummary["contentSafety"]>> {
    if (ContentFilterService.shouldSkipDetection()) {
      return {
        decision: "allow",
        confidence: 0,
        categories: [],
        source: "skipped",
        remoteChecked: false,
      };
    }

    const contentFilterResult = await ContentFilterService.detectProhibitedContent(text);
    if (contentFilterResult.error) {
      await this.auditGovernanceEvent({
        context,
        action: "tts.content_filter.unavailable",
        result: "failure",
        errorMessage: contentFilterResult.error,
        detail: {
          textHash: this.hashText(text),
          textLength: text.length,
          categories: contentFilterResult.categories,
          confidence: contentFilterResult.confidence,
          remoteUnavailable: contentFilterResult.remoteUnavailable,
          remoteError: contentFilterResult.remoteError,
        },
      });
      throw new TtsRequestError(500, contentFilterResult.error, "TTS_REMOTE_FILTER_UNAVAILABLE", true);
    }
    if (contentFilterResult.isProhibited) {
      await this.auditGovernanceEvent({
        context,
        action: "tts.content_filter.block",
        result: "failure",
        errorMessage: "Content safety policy blocked generation",
        detail: {
          textHash: this.hashText(text),
          textLength: text.length,
          decision: contentFilterResult.decision,
          categories: contentFilterResult.categories,
          confidence: contentFilterResult.confidence,
          source: contentFilterResult.source,
          findings: contentFilterResult.findings.map((finding) => ({
            source: finding.source,
            category: finding.category,
            severity: finding.severity,
            ruleId: finding.ruleId,
            variantHash: finding.variantHash,
          })),
        },
      });
      throw new TtsRequestError(403, "内容包含违禁词，无法生成语音", "TTS_CONTENT_PROHIBITED");
    }

    if (contentFilterResult.decision === "review") {
      await this.auditGovernanceEvent({
        context,
        action: "tts.content_filter.review",
        result: "success",
        detail: {
          textHash: this.hashText(text),
          textLength: text.length,
          categories: contentFilterResult.categories,
          confidence: contentFilterResult.confidence,
          source: contentFilterResult.source,
        },
      });
    }

    return this.buildContentSafetySummary(contentFilterResult);
  }

  private async validateGenerationCode(generationCode: unknown) {
    const expectedCode = await this.settingsStore.getGenerationCode();
    if (
      typeof generationCode !== "string" ||
      generationCode.length === 0 ||
      !expectedCode ||
      generationCode !== expectedCode
    ) {
      throw new TtsRequestError(403, "生成码无效", "TTS_INVALID_GENERATION_CODE");
    }
  }

  private async validateHumanCheck(input: TtsSubmissionInput, ip: string, userAgent?: string) {
    // 要不要验、验哪家都由管理端供应商配置（三家共用同一套下发链路）决定。
    const policy = await TurnstileService.getCaptchaRequestPolicy();
    if (!policy.required) {
      return;
    }

    const { token, provider } = readCaptchaChallenge(input);
    if (!token) {
      throw new TtsRequestError(403, "请先完成人机验证", "TTS_CAPTCHA_REQUIRED");
    }

    const verified = await TurnstileService.verifyCaptchaChallenge({ token, provider, remoteIp: ip, userAgent });
    if (verified) {
      return;
    }

    // 该家已被管理端下线（凭据可能已清掉）：不再把人卡死，与历史「开关关闭即放行」一致。
    if (!policy.enabledProviders.includes(provider)) {
      return;
    }

    throw new TtsRequestError(403, "人机验证失败，请重新验证", "TTS_CAPTCHA_FAILED");
  }

  public async validateAndBuild(context: TtsSubmissionContext): Promise<TtsSubmissionResult> {
    const rawRequestPayload = this.buildRequestPayload(context.input);
    const providerExecution = await this.ttsService.resolveProviderExecution(
      rawRequestPayload.model,
      rawRequestPayload.voice,
      undefined,
      rawRequestPayload.provider,
    );
    const requestPayload: TtsJobRequestPayload = {
      ...rawRequestPayload,
      model: providerExecution.model,
      voice: providerExecution.voice,
      speed: this.ttsService.resolveSpeed(rawRequestPayload.speed, providerExecution),
      providerExecution,
    };
    const fingerprint =
      typeof context.input.fingerprint === "string" && context.input.fingerprint.trim().length > 0
        ? context.input.fingerprint.trim()
        : "unknown";
    const userId = context.currentUser?.id;
    const isAdmin =
      context.currentUser?.role === "admin" || context.currentUser?.role === "superadmin";

    this.validateContentShape(requestPayload.text);
    if (
      providerExecution.providerId === "fish" &&
      !(FISH_AUDIO_SUPPORTED_FORMATS as readonly string[]).includes(requestPayload.outputFormat)
    ) {
      throw new TtsRequestError(
        400,
        "Fish Audio 当前仅支持 MP3 输出格式",
        "TTS_OUTPUT_FORMAT_UNSUPPORTED",
      );
    }
    if (
      providerExecution.providerId === "edge" &&
      !(EDGE_SUPPORTED_FORMATS as readonly string[]).includes(requestPayload.outputFormat)
    ) {
      throw new TtsRequestError(
        400,
        "微软内置语音当前仅支持 MP3 输出格式",
        "TTS_OUTPUT_FORMAT_UNSUPPORTED",
      );
    }
    if (!context.authenticatedByApiKey) {
      // 管理员豁免与 validatePolicyConsent 一致：能在后台改生成码的人不需要再自证。
      if (!isAdmin) {
        await this.validateGenerationCode(context.input.generationCode);
      }
      await this.validateHumanCheck(context.input, context.ip, context.userAgent);
    }

    if (!userId) {
      // TTS 仅登录可用：匿名通道连同它的日额度台账一起停用，历史记录不再产生 anonymous 作用域。
      throw new TtsRequestError(401, "请登录后使用语音生成", "TTS_AUTH_REQUIRED");
    }

    await this.validatePolicyConsent(context, fingerprint);
    const contentSafety = await this.validateContentPolicy(requestPayload.text, context);
    const governance: TtsGovernanceSummary = {
      policyVersion: CURRENT_POLICY_VERSION,
      contentSafety,
    };

    const contentIdentity = {
      text: requestPayload.text,
      voice: requestPayload.voice,
      model: requestPayload.model,
      speed: requestPayload.speed,
      outputFormat: requestPayload.outputFormat,
      providerExecution,
    };
    const contentHashCandidates = this.ttsService.generateContentHashCandidates(contentIdentity);

    // 管理员不受每日额度约束，直接入队（与停用前的匿名/管理员路径同构）。
    if (isAdmin) {
      if (!context.taskId) {
        throw new TtsRequestError(500, "任务标识缺失", "TTS_TASK_ID_MISSING");
      }

      return {
        requestPayload,
        ip: context.ip,
        fingerprint,
        userId,
        isAdmin,
        usageSummary: buildUsageSummaryFromSnapshot(context.currentUser, null),
        governance,
      };
    }

    const snapshot = await this.ledger.getUsageSnapshot(userId);
    const usageSummary = buildUsageSummaryFromSnapshot(context.currentUser, snapshot);
    if ((snapshot.remainingToday || 0) <= 0) {
      throw new TtsRequestError(429, "您今日的使用次数已达上限", "TTS_USAGE_LIMIT_REACHED");
    }

    const duplicate = await this.historyStore.findDuplicateForUser({
      userId,
      text: requestPayload.text,
      voice: requestPayload.voice,
      model: requestPayload.model,
      speed: requestPayload.speed,
      outputFormat: requestPayload.outputFormat,
      contentHashes: contentHashCandidates,
    });

    const reusableFileName = duplicate?.fileName
      ? await this.ttsService.findExistingFile(duplicate.contentHash, requestPayload.outputFormat)
      : null;

    if (duplicate && reusableFileName) {
      return {
        requestPayload,
        ip: context.ip,
        fingerprint,
        userId,
        isAdmin,
        usageSummary,
        governance,
        duplicateJobResult: {
          fileName: reusableFileName,
          audioUrl: this.ttsService.buildAudioUrl(reusableFileName),
          audioFileId: duplicate.audioFileId,
          audioStorage: duplicate.audioStorage,
          audioMimeType: duplicate.audioMimeType,
          audioSize: duplicate.audioSize,
          message: "检测到重复内容，已返回已有音频。",
          outputFormat: duplicate.outputFormat,
          provider: duplicate.provider,
          providerModel: duplicate.providerModel,
          providerVoice: duplicate.providerVoice,
        },
      };
    }

    if (!context.taskId) {
      throw new TtsRequestError(500, "任务标识缺失", "TTS_TASK_ID_MISSING");
    }

    const reservation = await this.ledger.reserve(userId, context.taskId);
    if (!reservation.success) {
      throw new TtsRequestError(429, "您今日的使用次数已达上限", "TTS_USAGE_LIMIT_REACHED");
    }

    return {
      requestPayload,
      ip: context.ip,
      fingerprint,
      userId,
      isAdmin,
      usageSummary: buildUsageSummaryFromSnapshot(context.currentUser, reservation.snapshot),
      governance,
    };
  }
}
