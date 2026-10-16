import { normalizeIdempotencyKey, parsePixelAccountsText } from "./accountText";
import { pixelCdkMappingService, resolveEnabledCardMapping, type PixelResolvedCard } from "./cdkMappingService";
import { pixelCardService } from "./cardService";
import { pixelLimitsFromEnv, type PixelRuntimeLimits } from "./runtime";
import { pixelTaskAccessStore, type PixelTaskAccessRecord } from "./taskAccessStore";
import { pixelOutcomeFromError, pixelUpstreamStatusFromError, pixelUsageLogService, type PixelUsageEntry } from "./usageLogService";
import {
  isPixelPreflightFailure,
  mapUpstreamFailure,
  pixelUpstreamClient,
  type PixelUpstreamCall,
  type PixelUpstreamClient,
  type PixelUpstreamResult,
} from "./upstreamClient";
import {
  buildExportText,
  exportableAccounts,
  normalizeExportAccountRows,
  normalizeTaskDetail,
  normalizeTaskStatus,
  normalizeTaskSummaryList,
  readSubmittedAccountCount,
  readSubmittedTaskId,
  taskSlug,
  timestampSlug,
} from "./upstreamViews";
import {
  PixelDomainError,
  isPixelServiceType,
  type PixelExportFileView,
  type PixelSettingsView,
  type PixelSubmitResultView,
  type PixelTaskDetailView,
  type PixelTaskSummaryView,
} from "./types";

/**
 * Pixel 任务服务（PIX-04…PIX-08 的服务端一半）。
 *
 * 权限与幂等的三根柱子：
 *   1. **归属只看服务端**：所有任务查询先过 `pixel_task_access`（带 userId），
 *      上游 `/api/tasks-by-card` 返回的是整张卡密下的全部任务，必须收敛到本人的 task id 集合，
 *      否则同卡密的其他用户能看到别人的任务。
 *   2. **提交幂等**：客户端每次提交带一个幂等键，`{userId, idempotencyKey}` 唯一。
 *      重复请求直接回放第一次的结论，绝不对上游发第二次（不重复扣额）。
 *      超时/5xx 时记录为 uncertain，同样不允许自动重发——上游可能已经受理。
 *   3. **取消幂等**：只有 pending 账号能取消；已取消直接返回成功（不回补两次）；
 *      已开始运行的账号返回 409，绝不向上游发「取消一个正在跑的账号」。
 *
 * 凭据边界：账号文本只在 submitTask 的调用栈里存在（解析 → 归一化 → 放进上游请求体），
 * 之后失去引用；不落库、不进日志、不进队列、不进幂等键。
 */
export interface PixelTaskServiceDeps {
  upstream: Pick<PixelUpstreamClient, "call">;
  mappings: Pick<typeof pixelCdkMappingService, "findByDistributionCdk" | "decryptUpstreamCdk">;
  access: Pick<
    typeof pixelTaskAccessStore,
    | "createIdempotent"
    | "findByUserAndKey"
    | "findByTaskId"
    | "listByCard"
    | "listByUser"
    | "patch"
    | "remove"
    | "markUserDeleted"
  >;
  usage: Pick<typeof pixelUsageLogService, "record" | "listForUser" | "deleteForUser">;
  /** 读服务器开关（提交前校验选中服务是否被后台关闭）。 */
  settings: (userId: string, requestId?: string) => Promise<PixelSettingsView>;
  limits?: PixelRuntimeLimits;
}

export interface PixelSubmitInput {
  card: unknown;
  accountsText: unknown;
  serviceType: unknown;
  /** 客户端每次提交生成一次；缺失即拒绝（没有幂等键就无法保证不重复扣额）。 */
  idempotencyKey: unknown;
}

export interface PixelCardQueryInput {
  card: unknown;
  accountQuery?: unknown;
}

/** 卡密导出聚合时的任务数上限：每次都向上游逐个取详情，必须封顶。 */
const EXPORT_TASK_LIMIT = 50;
/** 历史查询的账号关键字上限：只用于传给上游的模糊搜索，避免变成超长 payload。 */
const MAX_ACCOUNT_QUERY_CHARS = 100;

export function createPixelTaskService(deps: PixelTaskServiceDeps) {
  const limits = deps.limits ?? pixelLimitsFromEnv();

  /** 上游调用结果 + 传输层异常的统一封装：调用点因此不必区分「抛了异常」和「回了错误码」。 */
  async function callUpstream(
    call: PixelUpstreamCall,
  ): Promise<{ result: PixelUpstreamResult | null; error: unknown }> {
    try {
      return { result: await deps.upstream.call(call), error: null };
    } catch (error) {
      return { result: null, error };
    }
  }

  async function recordUsage(input: PixelUsageEntry): Promise<void> {
    await deps.usage.record(input);
  }

  /** 归属校验：拿不到本人记录时一律 404（不泄露他人任务是否存在）。 */
  async function requireOwnedTask(userId: string, taskId: unknown): Promise<PixelTaskAccessRecord> {
    const id = typeof taskId === "string" ? taskId.trim() : "";
    if (!id) throw new PixelDomainError("任务不存在。", 404, "PIXEL_TASK_NOT_FOUND");
    const access = await deps.access.findByTaskId(userId, id);
    if (!access || !access.upstreamTaskId) {
      throw new PixelDomainError("任务不存在。", 404, "PIXEL_TASK_NOT_FOUND");
    }
    return access;
  }

  /** 读一次上游任务详情，顺手把已知状态写回授权记录（轮询终止判据用）。 */
  async function fetchTaskDetail(
    access: PixelTaskAccessRecord,
    requestId?: string,
  ): Promise<PixelTaskDetailView> {
    const { result, error } = await callUpstream({ route: "task", taskId: access.upstreamTaskId });
    if (!result) {
      await recordUsage({
        userId: access.userId,
        mappingId: access.mappingId || null,
        matchedMapping: Boolean(access.mappingId),
        requestedCdk: null,
        method: "GET",
        path: "/api/task/:taskId",
        serviceType: access.serviceType,
        accountCount: access.accountCount,
        requestBytes: 0,
        responseBytes: null,
        upstreamStatus: pixelUpstreamStatusFromError(error),
        outcome: pixelOutcomeFromError(error),
        durationMs: 0,
        requestId,
      });
      throw error;
    }
    if (result.status === 404) {
      throw new PixelDomainError("任务不存在。", 404, "PIXEL_TASK_NOT_FOUND");
    }
    if (result.status < 200 || result.status >= 300) {
      throw mapUpstreamFailure(result.status);
    }
    const detail = normalizeTaskDetail(result.data, access.upstreamTaskId);
    await deps.access.patch(access.accessId, { status: detail.status, lastPolledAt: new Date() });
    await recordUsage({
      userId: access.userId,
      mappingId: access.mappingId || null,
      matchedMapping: Boolean(access.mappingId),
      requestedCdk: null,
      method: result.method,
      path: result.path,
      serviceType: access.serviceType,
      accountCount: detail.totalAccounts,
      requestBytes: result.requestBytes,
      responseBytes: result.responseBytes,
      upstreamStatus: result.status,
      outcome: "success",
      durationMs: result.durationMs,
      requestId,
    });
    return detail;
  }

  /** 幂等重放：把第一次的结论原样回答，不再打上游。 */
  function replaySubmission(record: PixelTaskAccessRecord): PixelSubmitResultView {
    if (record.submitState === "accepted" && record.upstreamTaskId) {
      return {
        taskId: record.upstreamTaskId,
        totalAccounts: record.accountCount,
        status: normalizeTaskStatus(record.status),
        message: "任务已提交，正在处理。",
      };
    }
    if (record.submitState === "rejected") {
      throw new PixelDomainError(
        "上一次提交未通过，请修改后重试。",
        400,
        record.submitOutcomeCode || "PIXEL_UPSTREAM_REJECTED",
      );
    }
    if (record.submitState === "in_flight") {
      throw new PixelDomainError("上一次提交仍在处理中，请稍后刷新。", 409, "PIXEL_SUBMIT_IN_PROGRESS");
    }
    throw new PixelDomainError(
      "上一次提交的结果不确定，请勿重复提交，请在历史任务中确认。",
      502,
      "PIXEL_SUBMIT_UNCERTAIN",
    );
  }

  async function resolveCardWithAccess(
    userId: string,
    card: unknown,
  ): Promise<{ resolved: PixelResolvedCard; ownedTaskIds: Set<string>; accessRows: PixelTaskAccessRecord[] }> {
    const resolved = await resolveEnabledCardMapping(deps.mappings, card);
    const accessRows = await deps.access.listByCard(userId, resolved.record.distributionCdkHash);
    const ownedTaskIds = new Set(
      accessRows.map((row) => row.upstreamTaskId).filter((id) => Boolean(id)),
    );
    return { resolved, ownedTaskIds, accessRows };
  }

  function normalizeAccountQuery(value: unknown): string {
    const text = typeof value === "string" ? value.trim() : "";
    // eslint-disable-next-line no-control-regex
    return text.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_ACCOUNT_QUERY_CHARS);
  }

  /**
   * 账号 id 只接受纯十进制正整数（来自路径参数，属不可信输入）：不用 parseInt——
   * 它会把 "4abc" 当成 4、把 " 4 " 后面的垃圾吃掉，而取消操作没有「尽力修一下」的余地。
   */
  function parseAccountId(value: unknown): number | null {
    const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
    if (!/^[0-9]{1,18}$/.test(text)) return null;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  /** 归属校验 + 读详情：getTask 与单任务导出共用（导出不能绕开归属检查）。 */
  async function loadOwnedTaskDetail(
    userId: string,
    taskId: unknown,
    requestId?: string,
  ): Promise<PixelTaskDetailView> {
    const access = await requireOwnedTask(userId, taskId);
    return fetchTaskDetail(access, requestId);
  }

  return {
    async submitTask(
      userId: string,
      input: PixelSubmitInput,
      requestId?: string,
    ): Promise<PixelSubmitResultView> {
      if (!isPixelServiceType(input.serviceType)) {
        throw new PixelDomainError("请选择要使用的服务。", 400, "PIXEL_SERVICE_TYPE_INVALID");
      }
      const serviceType = input.serviceType;
      const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
      // 账号文本只在这一行被解析；返回值里只有计数与归一化文本。
      const parsed = parsePixelAccountsText(input.accountsText, limits);
      const resolved = await resolveEnabledCardMapping(deps.mappings, input.card);

      const existing = await deps.access.findByUserAndKey(userId, idempotencyKey);
      if (existing) return replaySubmission(existing);

      // 后台关闭的服务在服务端也要拒绝：前端回退到 link_only 只是界面行为，不能当授权。
      const settings = await deps.settings(userId, requestId);
      const option = settings.services.find((item) => item.type === serviceType);
      if (option && !option.enabled) {
        throw new PixelDomainError("该服务当前已关闭，请选择其他服务。", 400, "PIXEL_SERVICE_DISABLED");
      }

      // 先占一行（in_flight）：同一个幂等键只有一行，后续无论成败都不再向上游发第二次提交。
      const reservation = await deps.access.createIdempotent({
        userId,
        mappingId: resolved.record.mappingId,
        distributionCdkHash: resolved.record.distributionCdkHash,
        serviceType,
        accountCount: parsed.accountCount,
        idempotencyKey,
      });
      if (!reservation.created) return replaySubmission(reservation.record);

      const accessId = reservation.record.accessId;
      const logBase = {
        userId,
        mappingId: resolved.record.mappingId,
        matchedMapping: true,
        requestedCdk: resolved.card,
        method: "POST",
        path: "/api/submit-task",
        serviceType,
        accountCount: parsed.accountCount,
        requestId,
      } as const;

      const { result, error } = await callUpstream({
        route: "submitTask",
        body: {
          card_key: resolved.upstreamCdk,
          service_type: serviceType,
          accounts_text: parsed.normalizedText,
        },
      });

      if (!result) {
        if (isPixelPreflightFailure(error)) {
          // 请求根本没发出去：删掉占位，让用户能用同一个幂等键重试（否则一次配置故障会永久烧掉这个键）。
          await deps.access.remove(accessId);
          await recordUsage({
            ...logBase,
            requestBytes: 0,
            responseBytes: null,
            upstreamStatus: pixelUpstreamStatusFromError(error),
            outcome: pixelOutcomeFromError(error),
            durationMs: 0,
          });
          throw error;
        }
        // 超时 / 连接中断：上游可能已经受理，绝不能自动重发。
        await deps.access.patch(accessId, {
          submitState: "uncertain",
          submitOutcomeCode: pixelOutcomeFromError(error),
          status: "pending",
        });
        await recordUsage({
          ...logBase,
          requestBytes: 0,
          responseBytes: null,
          upstreamStatus: pixelUpstreamStatusFromError(error),
          outcome: pixelOutcomeFromError(error),
          durationMs: 0,
        });
        throw new PixelDomainError(
          "提交结果不确定，请勿重复提交，请在历史任务中确认。",
          502,
          "PIXEL_SUBMIT_UNCERTAIN",
        );
      }

      if (result.status < 200 || result.status >= 300) {
        const failure = mapUpstreamFailure(result.status);
        // 4xx = 上游明确没受理：记成 rejected（改参数后可以换新幂等键重试）。
        // 429/5xx = 可能已经受理：记成 uncertain，不允许用同一幂等键重发。
        const definitive = result.status >= 400 && result.status < 500 && result.status !== 429;
        await deps.access.patch(accessId, definitive
          ? { submitState: "rejected", submitOutcomeCode: failure.code, status: "failed" }
          : { submitState: "uncertain", submitOutcomeCode: failure.code, status: "pending" });
        await recordUsage({
          ...logBase,
          requestBytes: result.requestBytes,
          responseBytes: result.responseBytes,
          upstreamStatus: result.status,
          outcome: pixelOutcomeFromError(failure),
          durationMs: result.durationMs,
        });
        if (definitive) throw failure;
        throw new PixelDomainError(
          "提交结果不确定，请勿重复提交，请在历史任务中确认。",
          502,
          "PIXEL_SUBMIT_UNCERTAIN",
          { upstreamStatus: result.status },
        );
      }

      const upstreamTaskId = readSubmittedTaskId(result.data);
      if (!upstreamTaskId) {
        // 200 但拿不到 task id：与超时同性质——不知道上游怎么处理了。
        await deps.access.patch(accessId, {
          submitState: "uncertain",
          submitOutcomeCode: "PIXEL_UPSTREAM_RESPONSE_INVALID",
          status: "pending",
        });
        await recordUsage({
          ...logBase,
          requestBytes: result.requestBytes,
          responseBytes: result.responseBytes,
          upstreamStatus: result.status,
          outcome: "upstream_error",
          durationMs: result.durationMs,
        });
        throw new PixelDomainError(
          "提交结果不确定，请勿重复提交，请在历史任务中确认。",
          502,
          "PIXEL_SUBMIT_UNCERTAIN",
        );
      }

      const totalAccounts = readSubmittedAccountCount(result.data) ?? parsed.accountCount;
      await deps.access.patch(accessId, {
        upstreamTaskId,
        submitState: "accepted",
        submitOutcomeCode: "",
        status: "pending",
        accountCount: totalAccounts,
      });
      await recordUsage({
        ...logBase,
        requestBytes: result.requestBytes,
        responseBytes: result.responseBytes,
        upstreamStatus: result.status,
        outcome: "success",
        durationMs: result.durationMs,
      });
      return {
        taskId: upstreamTaskId,
        totalAccounts,
        status: "pending",
        message: "任务已提交，正在处理。",
      };
    },

    async getTask(userId: string, taskId: unknown, requestId?: string): Promise<PixelTaskDetailView> {
      return loadOwnedTaskDetail(userId, taskId, requestId);
    },

    async listTasksByCard(
      userId: string,
      input: PixelCardQueryInput,
      requestId?: string,
    ): Promise<{ tasks: PixelTaskSummaryView[]; total: number; message: string }> {
      const { resolved, ownedTaskIds } = await resolveCardWithAccess(userId, input.card);
      const accountQuery = normalizeAccountQuery(input.accountQuery);
      const { result, error } = await callUpstream({
        route: "tasksByCard",
        body: { card_key: resolved.upstreamCdk, account_query: accountQuery },
      });
      if (!result) {
        await recordUsage({
          userId,
          mappingId: resolved.record.mappingId,
          matchedMapping: true,
          requestedCdk: resolved.card,
          method: "POST",
          path: "/api/tasks-by-card",
          serviceType: null,
          accountCount: null,
          requestBytes: 0,
          responseBytes: null,
          upstreamStatus: pixelUpstreamStatusFromError(error),
          outcome: pixelOutcomeFromError(error),
          durationMs: 0,
          requestId,
        });
        throw error;
      }
      if (result.status < 200 || result.status >= 300) {
        const failure = mapUpstreamFailure(result.status);
        await recordUsage({
          userId,
          mappingId: resolved.record.mappingId,
          matchedMapping: true,
          requestedCdk: resolved.card,
          method: "POST",
          path: "/api/tasks-by-card",
          serviceType: null,
          accountCount: null,
          requestBytes: result.requestBytes,
          responseBytes: result.responseBytes,
          upstreamStatus: result.status,
          outcome: pixelOutcomeFromError(failure),
          durationMs: result.durationMs,
          requestId,
        });
        throw failure;
      }
      const tasks = normalizeTaskSummaryList(result.data)
        // 上游按整张卡密返回：只保留属于当前用户的 task id（PRD 3.1「不从客户端传入的 userId 建立权限」）。
        .filter((task) => ownedTaskIds.has(task.taskId));
      await recordUsage({
        userId,
        mappingId: resolved.record.mappingId,
        matchedMapping: true,
        requestedCdk: resolved.card,
        method: result.method,
        path: result.path,
        serviceType: null,
        accountCount: null,
        requestBytes: result.requestBytes,
        responseBytes: result.responseBytes,
        upstreamStatus: result.status,
        outcome: "success",
        durationMs: result.durationMs,
        requestId,
      });
      return {
        tasks,
        total: tasks.length,
        message: tasks.length ? "查询成功。" : "当前卡密下还没有你的历史任务。",
      };
    },

    async exportTaskText(userId: string, taskId: unknown, requestId?: string): Promise<PixelExportFileView> {
      const detail = await loadOwnedTaskDetail(userId, taskId, requestId);
      return {
        filename: `task_${taskSlug(detail.taskId)}_success.txt`,
        text: buildExportText(exportableAccounts(detail)),
      };
    },

    async exportByCardText(
      userId: string,
      input: PixelCardQueryInput,
      requestId?: string,
    ): Promise<PixelExportFileView> {
      const { resolved, ownedTaskIds } = await resolveCardWithAccess(userId, input.card);
      const filename = `all_tasks_success_${timestampSlug()}.txt`;

      const { result, error } = await callUpstream({
        route: "exportByCard",
        body: { card_key: resolved.upstreamCdk, account_query: normalizeAccountQuery(input.accountQuery) },
      });
      if (!result) {
        await recordUsage({
          userId,
          mappingId: resolved.record.mappingId,
          matchedMapping: true,
          requestedCdk: resolved.card,
          method: "POST",
          path: "/api/tasks/export-by-card",
          serviceType: null,
          accountCount: null,
          requestBytes: 0,
          responseBytes: null,
          upstreamStatus: pixelUpstreamStatusFromError(error),
          outcome: pixelOutcomeFromError(error),
          durationMs: 0,
          requestId,
        });
        throw error;
      }
      if (result.status < 200 || result.status >= 300) {
        const failure = mapUpstreamFailure(result.status);
        await recordUsage({
          userId,
          mappingId: resolved.record.mappingId,
          matchedMapping: true,
          requestedCdk: resolved.card,
          method: "POST",
          path: "/api/tasks/export-by-card",
          serviceType: null,
          accountCount: null,
          requestBytes: result.requestBytes,
          responseBytes: result.responseBytes,
          upstreamStatus: result.status,
          outcome: pixelOutcomeFromError(failure),
          durationMs: result.durationMs,
          requestId,
        });
        throw failure;
      }

      const items = normalizeExportAccountRows(result.data);
      await recordUsage({
        userId,
        mappingId: resolved.record.mappingId,
        matchedMapping: true,
        requestedCdk: resolved.card,
        method: result.method,
        path: result.path,
        serviceType: null,
        accountCount: items.length,
        requestBytes: result.requestBytes,
        responseBytes: result.responseBytes,
        upstreamStatus: result.status,
        outcome: "success",
        durationMs: result.durationMs,
        requestId,
      });

      // 上游契约里 task_id 是可选字段（openapi 草案）。没有它就无法把一行归属到某个用户，
      // 因此**不能**直接下发整张卡密的结果（那会跨用户泄露）。此时退化为「只导本人任务」：
      // 逐个取本人任务的详情再聚合（有上限），这是唯一能保证权限正确又不丢行的做法。
      if (items.length > 0 && items.every((item) => !item.taskId)) {
        const rows: Array<{ email: string; resultLink: string }> = [];
        const ownedIds = [...ownedTaskIds].slice(0, EXPORT_TASK_LIMIT);
        for (const ownedId of ownedIds) {
          const access = await deps.access.findByTaskId(userId, ownedId);
          if (!access) continue;
          const detail = await fetchTaskDetail(access, requestId);
          rows.push(...exportableAccounts(detail));
        }
        return { filename, text: buildExportText(rows) };
      }

      return {
        filename,
        text: buildExportText(items.filter((item) => item.taskId && ownedTaskIds.has(item.taskId))),
      };
    },

    async cancelQueuedAccount(
      userId: string,
      taskId: unknown,
      accountId: unknown,
      requestId?: string,
    ): Promise<{ cancelled: boolean; alreadyCancelled: boolean }> {
      const access = await requireOwnedTask(userId, taskId);
      const id = parseAccountId(accountId);
      if (id === null) {
        throw new PixelDomainError("账号标识无效。", 400, "PIXEL_ACCOUNT_ID_INVALID");
      }
      const detail = await fetchTaskDetail(access, requestId);
      const account = detail.accounts.find((item) => item.id === id);
      if (!account) {
        throw new PixelDomainError("没有找到该账号。", 404, "PIXEL_ACCOUNT_NOT_FOUND");
      }
      // 已经取消：幂等返回成功，且**不再**打上游（重复取消不该再回补一次额度）。
      if (account.status === "cancelled") {
        return { cancelled: true, alreadyCancelled: true };
      }
      // 只有排队中的账号可取消：已经跑起来的账号取消会与上游执行竞态，直接拒绝。
      if (account.status !== "pending") {
        throw new PixelDomainError("该账号已经在处理中，无法取消排队。", 409, "PIXEL_ACCOUNT_NOT_CANCELLABLE");
      }

      const { result, error } = await callUpstream({
        route: "cancelQueue",
        taskId: access.upstreamTaskId,
        accountId: id,
      });
      if (!result) {
        if (isPixelPreflightFailure(error)) throw error;
        await recordUsage({
          userId,
          mappingId: access.mappingId || null,
          matchedMapping: Boolean(access.mappingId),
          requestedCdk: null,
          method: "POST",
          path: "/api/task/:taskId/account/:accountId/cancel-queue",
          serviceType: access.serviceType,
          accountCount: 1,
          requestBytes: 0,
          responseBytes: null,
          upstreamStatus: pixelUpstreamStatusFromError(error),
          outcome: pixelOutcomeFromError(error),
          durationMs: 0,
          requestId,
        });
        throw new PixelDomainError(
          "取消结果不确定，请稍后刷新任务状态确认。",
          502,
          "PIXEL_CANCEL_UNCERTAIN",
        );
      }
      if (result.status < 200 || result.status >= 300) {
        const failure = mapUpstreamFailure(result.status);
        await recordUsage({
          userId,
          mappingId: access.mappingId || null,
          matchedMapping: Boolean(access.mappingId),
          requestedCdk: null,
          method: "POST",
          path: "/api/task/:taskId/account/:accountId/cancel-queue",
          serviceType: access.serviceType,
          accountCount: 1,
          requestBytes: result.requestBytes,
          responseBytes: result.responseBytes,
          upstreamStatus: result.status,
          outcome: pixelOutcomeFromError(failure),
          durationMs: result.durationMs,
          requestId,
        });
        // 竞争取消/竞态已开始运行：上游回 4xx，按「不可取消」回答，不谎报成功。
        if (result.status >= 400 && result.status < 500) {
          throw new PixelDomainError("该账号已经在处理中，无法取消排队。", 409, "PIXEL_ACCOUNT_NOT_CANCELLABLE");
        }
        throw failure;
      }
      await recordUsage({
        userId,
        mappingId: access.mappingId || null,
        matchedMapping: Boolean(access.mappingId),
        requestedCdk: null,
        method: result.method,
        path: result.path,
        serviceType: access.serviceType,
        accountCount: 1,
        requestBytes: result.requestBytes,
        responseBytes: result.responseBytes,
        upstreamStatus: result.status,
        outcome: "success",
        durationMs: result.durationMs,
        requestId,
      });
      return { cancelled: true, alreadyCancelled: false };
    },

    /** 用户数据副本：只有任务归属与脱敏溯源，没有任何账号凭据。 */
    async exportUserPixelData(userId: string): Promise<Record<string, unknown>> {
      const [rows, usage] = await Promise.all([
        deps.access.listByUser(userId),
        deps.usage.listForUser(userId),
      ]);
      return {
        exportedAt: new Date().toISOString(),
        tasks: rows.map((row) => ({
          accessId: row.accessId,
          mappingId: row.mappingId,
          upstreamTaskId: row.upstreamTaskId,
          serviceType: row.serviceType,
          accountCount: row.accountCount,
          submitState: row.submitState,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
        })),
        usageLogs: usage,
      };
    },

    /**
     * 账号注销：任务归属软删除（与 geogebra 系列同一约定），脱敏溯源直接删除
     * （纯遥测 + 带 TTL，没有为已注销用户长期保留的理由）。
     */
    async markUserPixelDataDeleted(
      userId: string,
      deletedAt: number,
    ): Promise<{ access: number; usage: number }> {
      const access = await deps.access.markUserDeleted(userId, deletedAt);
      const usage = await deps.usage.deleteForUser(userId);
      return { access, usage };
    },
  };
}

export type PixelTaskService = ReturnType<typeof createPixelTaskService>;

export const pixelTaskService = createPixelTaskService({
  upstream: pixelUpstreamClient,
  mappings: pixelCdkMappingService,
  access: pixelTaskAccessStore,
  usage: pixelUsageLogService,
  settings: (userId, requestId) => pixelCardService.getSettings(userId, requestId),
});
