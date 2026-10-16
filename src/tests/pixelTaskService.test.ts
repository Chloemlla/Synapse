/**
 * Pixel 任务服务用例（PIX-04…PIX-08 的核心安全属性）。
 *
 * 全部注入假实现：不连 Mongo、不发网络请求。重点断言：
 *   · 提交幂等：同一幂等键不会向上游发第二次；
 *   · 超时/5xx 记成 uncertain，不允许自动重发；
 *   · 跨用户隔离：上游按整卡返回的任务只保留本人的 task id；
 *   · 归属校验：不是本人的 task 一律 404 且不打上游；
 *   · 取消幂等：已取消不再打上游，正在运行一律拒绝；
 *   · 导出只含本人且有结果链接的账号。
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import {
  createPixelTaskService,
  type PixelSubmitInput,
  type PixelTaskServiceDeps,
} from "../pixel/taskService";
import type { PixelCdkMappingRecord } from "../pixel/cdkMappingService";
import type { PixelRuntimeLimits } from "../pixel/runtime";
import type { PixelTaskAccessRecord } from "../pixel/taskAccessStore";
import type { PixelUsageEntry } from "../pixel/usageLogService";
import type {
  PixelUpstreamCall,
  PixelUpstreamResult,
} from "../pixel/upstreamClient";
import { PixelDomainError, type PixelSettingsView } from "../pixel/types";

const LIMITS: PixelRuntimeLimits = {
  maxAccountsPerSubmission: 5,
  maxAccountLineChars: 512,
  maxAccountsTextBytes: 8_192,
  usageLogRetentionDays: 30,
  upstreamTimeoutMs: 5_000,
};

const SETTINGS: PixelSettingsView = {
  autoBindEnabled: true,
  autoBindOneDollarEnabled: false,
  services: [
    { type: "link_only", quotaCost: 0.5, enabled: true },
    { type: "link_and_bind", quotaCost: 1, enabled: true },
    { type: "link_and_bind_1usd", quotaCost: 1.5, enabled: false },
  ],
};

const MAPPING: PixelCdkMappingRecord = {
  mappingId: "pcm_1",
  distributionCdkHash: "hash-1",
  distributionCdkMasked: "dist...0001",
  upstreamCdkMasked: "upst...0002",
  note: "",
  enabled: true,
  createdByUserId: "admin-1",
  createdByUsername: "admin",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  upstreamCdkCiphertext: "cipher",
  upstreamCdkIv: "iv",
  upstreamCdkTag: "tag",
  upstreamCdkCryptoVersion: 1,
};

function result(data: unknown, over: Partial<PixelUpstreamResult> = {}): PixelUpstreamResult {
  return {
    status: 200,
    data,
    method: "POST",
    path: "/api/submit-task",
    requestBytes: 10,
    responseBytes: 20,
    durationMs: 5,
    ...over,
  };
}

function createHarness(options: {
  upstreamHandler?: (call: PixelUpstreamCall) => Promise<PixelUpstreamResult>;
  mapping?: PixelCdkMappingRecord | null;
} = {}) {
  type AccessDeps = PixelTaskServiceDeps["access"];
  const rows = new Map<string, PixelTaskAccessRecord>();
  let seq = 0;
  let handler = options.upstreamHandler ?? (async () => result({ task_id: "task-upstream-1", total_accounts: 2 }));
  const calls: PixelUpstreamCall[] = [];
  const usageEntries: PixelUsageEntry[] = [];

  const access: AccessDeps = {
    async createIdempotent(input) {
      for (const row of rows.values()) {
        if (row.userId === input.userId && row.idempotencyKey === input.idempotencyKey) {
          return { created: false, record: row };
        }
      }
      seq += 1;
      const record: PixelTaskAccessRecord = {
        accessId: `pxa_${seq}`,
        userId: input.userId,
        mappingId: input.mappingId,
        distributionCdkHash: input.distributionCdkHash,
        upstreamTaskId: "",
        serviceType: input.serviceType,
        accountCount: input.accountCount,
        submitState: "in_flight",
        submitOutcomeCode: "",
        status: "pending",
        idempotencyKey: input.idempotencyKey,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        lastPolledAt: null,
        subjectDeletedAt: 0,
      };
      rows.set(record.accessId, record);
      return { created: true, record };
    },
    async findByUserAndKey(userId, idempotencyKey) {
      for (const row of rows.values()) {
        if (row.userId === userId && row.idempotencyKey === idempotencyKey && row.subjectDeletedAt === 0) return row;
      }
      return null;
    },
    async findByTaskId(userId, upstreamTaskId) {
      for (const row of rows.values()) {
        if (row.userId === userId && row.upstreamTaskId === upstreamTaskId && row.subjectDeletedAt === 0) return row;
      }
      return null;
    },
    async listByCard(userId, distributionCdkHash) {
      return [...rows.values()].filter(
        (row) => row.userId === userId && row.distributionCdkHash === distributionCdkHash && row.subjectDeletedAt === 0,
      );
    },
    async listByUser(userId) {
      return [...rows.values()].filter((row) => row.userId === userId && row.subjectDeletedAt === 0);
    },
    async patch(accessId, patch) {
      const row = rows.get(accessId);
      if (row) Object.assign(row, patch);
    },
    async remove(accessId) {
      rows.delete(accessId);
    },
    async markUserDeleted(userId, deletedAt) {
      let count = 0;
      for (const row of rows.values()) {
        if (row.userId === userId && row.subjectDeletedAt === 0) {
          row.subjectDeletedAt = deletedAt;
          count += 1;
        }
      }
      return count;
    },
  };

  const service = createPixelTaskService({
    upstream: {
      async call(call) {
        calls.push(call);
        return handler(call);
      },
    },
    mappings: {
      async findByDistributionCdk() {
        return options.mapping === undefined ? MAPPING : options.mapping;
      },
      decryptUpstreamCdk() {
        return "upstream-cdk-secret";
      },
    },
    access,
    usage: {
      async record(entry) {
        usageEntries.push(entry);
      },
      async listForUser() {
        return [];
      },
      async deleteForUser() {
        return 0;
      },
    },
    settings: async () => SETTINGS,
    limits: LIMITS,
  });

  return {
    service,
    rows,
    calls,
    usageEntries,
    setHandler(next: (call: PixelUpstreamCall) => Promise<PixelUpstreamResult>) {
      handler = next;
    },
  };
}

function submitInput(over: Partial<PixelSubmitInput> = {}): PixelSubmitInput {
  return {
    card: "dist-card-0001",
    accountsText: "a@example.com----pass1----r@example.com----TOTP1",
    serviceType: "link_only",
    idempotencyKey: "idem-key-000001",
    ...over,
  };
}

describe("pixel 提交任务（幂等与失败语义）", () => {
  it("首次提交成功后落库为 accepted，并把上游 task id 写回", async () => {
    const harness = createHarness();
    const submitted = await harness.service.submitTask("u1", submitInput());
    expect(submitted).toMatchObject({ taskId: "task-upstream-1", totalAccounts: 2, status: "pending" });
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0].route).toBe("submitTask");
    const stored = [...harness.rows.values()][0];
    expect(stored.submitState).toBe("accepted");
    expect(stored.upstreamTaskId).toBe("task-upstream-1");
    // 库里没有账号文本：记录里只有计数
    expect(JSON.stringify(stored)).not.toContain("a@example.com");
    expect(JSON.stringify(stored)).not.toContain("pass1");
  });

  it("同一幂等键重复提交：只回放结论，不再打上游（不会重复扣额）", async () => {
    const harness = createHarness();
    await harness.service.submitTask("u1", submitInput());
    const replay = await harness.service.submitTask("u1", submitInput());
    expect(replay.taskId).toBe("task-upstream-1");
    expect(harness.calls.filter((call) => call.route === "submitTask")).toHaveLength(1);
  });

  it("上游 4xx（明确未受理）记成 rejected，重放同样报错且不再打上游", async () => {
    const harness = createHarness({
      upstreamHandler: async () => result({ detail: "卡密不存在" }, { status: 400 }),
    });
    await expect(harness.service.submitTask("u1", submitInput())).rejects.toMatchObject({
      code: "PIXEL_UPSTREAM_REJECTED",
      status: 400,
    });
    expect([...harness.rows.values()][0].submitState).toBe("rejected");
    const upstreamCalls = harness.calls.length;
    await expect(harness.service.submitTask("u1", submitInput())).rejects.toMatchObject({ status: 400 });
    expect(harness.calls).toHaveLength(upstreamCalls);
  });

  it("上游超时记成 uncertain：不回放成功、也不允许重发", async () => {
    const harness = createHarness();
    harness.setHandler(async () => {
      throw new PixelDomainError("上游响应超时，请稍后重试。", 504, "PIXEL_UPSTREAM_TIMEOUT");
    });
    await expect(harness.service.submitTask("u1", submitInput())).rejects.toMatchObject({
      code: "PIXEL_SUBMIT_UNCERTAIN",
      status: 502,
    });
    expect([...harness.rows.values()][0].submitState).toBe("uncertain");
    const upstreamCalls = harness.calls.length;
    await expect(harness.service.submitTask("u1", submitInput())).rejects.toMatchObject({
      code: "PIXEL_SUBMIT_UNCERTAIN",
    });
    expect(harness.calls).toHaveLength(upstreamCalls);
  });

  it("上游 5xx 同样记 uncertain，不伪造成功", async () => {
    const harness = createHarness({
      upstreamHandler: async () => result(null, { status: 503 }),
    });
    await expect(harness.service.submitTask("u1", submitInput())).rejects.toMatchObject({
      code: "PIXEL_SUBMIT_UNCERTAIN",
    });
    expect([...harness.rows.values()][0].submitState).toBe("uncertain");
  });

  it("上游 200 但拿不到 task id 也记 uncertain（不当作成功）", async () => {
    const harness = createHarness({ upstreamHandler: async () => result({ message: "ok" }) });
    await expect(harness.service.submitTask("u1", submitInput())).rejects.toMatchObject({
      code: "PIXEL_SUBMIT_UNCERTAIN",
    });
    expect([...harness.rows.values()][0].submitState).toBe("uncertain");
  });

  it("请求没送出去（上游未配置）时删掉占位，允许用同一幂等键重试", async () => {
    const harness = createHarness();
    harness.setHandler(async () => {
      throw new PixelDomainError("该服务当前不可用，请联系管理员。", 503, "PIXEL_UPSTREAM_NOT_CONFIGURED");
    });
    await expect(harness.service.submitTask("u1", submitInput())).rejects.toMatchObject({
      code: "PIXEL_UPSTREAM_NOT_CONFIGURED",
    });
    expect(harness.rows.size).toBe(0);

    harness.setHandler(async () => result({ task_id: "task-upstream-9", total_accounts: 1 }));
    const retried = await harness.service.submitTask("u1", submitInput());
    expect(retried.taskId).toBe("task-upstream-9");
  });

  it("后台关闭的服务在服务端也拒绝，且不落占位记录", async () => {
    const harness = createHarness();
    await expect(
      harness.service.submitTask("u1", submitInput({ serviceType: "link_and_bind_1usd" })),
    ).rejects.toMatchObject({ code: "PIXEL_SERVICE_DISABLED", status: 400 });
    expect(harness.rows.size).toBe(0);
    expect(harness.calls).toHaveLength(0);
  });

  it("缺幂等键 / 服务类型非法 / 卡密不存在都在打上游之前拒绝", async () => {
    const harness = createHarness();
    await expect(harness.service.submitTask("u1", submitInput({ idempotencyKey: "" }))).rejects.toMatchObject({
      code: "PIXEL_IDEMPOTENCY_KEY_REQUIRED",
    });
    await expect(harness.service.submitTask("u1", submitInput({ serviceType: "unknown" }))).rejects.toMatchObject({
      code: "PIXEL_SERVICE_TYPE_INVALID",
    });
    const noMapping = createHarness({ mapping: null });
    await expect(noMapping.service.submitTask("u1", submitInput())).rejects.toMatchObject({
      code: "PIXEL_CARD_NOT_FOUND",
      status: 404,
    });
    expect(harness.calls).toHaveLength(0);
  });

  it("卡密停用时拒绝（403），区分于「不存在」", async () => {
    const harness = createHarness({ mapping: { ...MAPPING, enabled: false } });
    await expect(harness.service.submitTask("u1", submitInput())).rejects.toMatchObject({
      code: "PIXEL_CARD_DISABLED",
      status: 403,
    });
  });

  it("溯源日志只记遮罩与计数，不出现账号文本", async () => {
    const harness = createHarness();
    await harness.service.submitTask("u1", submitInput());
    const entry = harness.usageEntries[harness.usageEntries.length - 1];
    // 明文卡密在 service 层传给记录器（它本来就在这次请求的内存里），由 usageLogService 负责遮罩；
    // 这里断言的是「除了计数与路径，没有任何账号内容被带下去」。
    expect(entry.requestedCdk).toBe("dist-card-0001");
    expect(entry.accountCount).toBe(1);
    expect(entry.path).toBe("/api/submit-task");
    expect(JSON.stringify(entry)).not.toContain("a@example.com");
    expect(JSON.stringify(entry)).not.toContain("pass1");
  });
});

describe("pixel 任务查询的归属边界", () => {
  it("不是本人的 task 一律 404，且不打上游", async () => {
    const harness = createHarness();
    await expect(harness.service.getTask("u1", "someone-elses-task")).rejects.toMatchObject({
      code: "PIXEL_TASK_NOT_FOUND",
      status: 404,
    });
    expect(harness.calls).toHaveLength(0);
  });

  it("本人的 task 详情归一化账号状态与取消数", async () => {
    const harness = createHarness();
    await harness.service.submitTask("u1", submitInput());
    harness.setHandler(async () =>
      result({
        task_id: "task-upstream-1",
        status: "running",
        total_accounts: 3,
        accounts: [
          { id: 1, line_number: 1, email: "a@example.com", status: "success", message: "处理成功", result_link: "https://l/1" },
          { id: 2, line_number: 2, email: "b@example.com", status: "cancelled", message: "" },
          { id: 3, line_number: 3, email: "c@example.com", status: "brand_new_status", message: "" },
        ],
      }),
    );
    const detail = await harness.service.getTask("u1", "task-upstream-1");
    expect(detail.status).toBe("running");
    expect(detail.totalAccounts).toBe(3);
    expect(detail.cancelledCount).toBe(1);
    expect(detail.accounts[2].status).toBe("unknown");
    expect(detail.accounts[0].resultLink).toBe("https://l/1");
  });

  it("上游被删掉的任务（404）在本地也报 404", async () => {
    const harness = createHarness();
    await harness.service.submitTask("u1", submitInput());
    harness.setHandler(async () => result({ detail: "任务不存在" }, { status: 404 }));
    await expect(harness.service.getTask("u1", "task-upstream-1")).rejects.toMatchObject({
      status: 404,
      code: "PIXEL_TASK_NOT_FOUND",
    });
  });
});

describe("pixel 按卡密查询：跨用户隔离", () => {
  it("只保留本人在该卡密下的 task id", async () => {
    const harness = createHarness();
    await harness.service.submitTask("u1", submitInput()); // u1 → task-upstream-1
    harness.setHandler(async () =>
      result({
        tasks: [
          { task_id: "task-upstream-1", total_accounts: 1, status: "completed", success: 1, failed: 0, created_at: "2026-01-02 10:00:00" },
          { task_id: "task-other-user", total_accounts: 5, status: "completed", success: 5, failed: 0, created_at: "2026-01-02 11:00:00" },
        ],
      }),
    );
    const listed = await harness.service.listTasksByCard("u1", { card: "dist-card-0001" });
    expect(listed.tasks.map((task) => task.taskId)).toEqual(["task-upstream-1"]);
    expect(JSON.stringify(listed)).not.toContain("task-other-user");
  });

  it("本人没有该卡密下的任务时返回空列表与明确文案", async () => {
    const harness = createHarness({ upstreamHandler: async () => result({ tasks: [] }) });
    const listed = await harness.service.listTasksByCard("u2", { card: "dist-card-0001" });
    expect(listed.tasks).toEqual([]);
    expect(listed.message).toContain("还没有你的历史任务");
  });

  it("查历史同样需要有效卡密（不存在 → 404）", async () => {
    const harness = createHarness({ mapping: null });
    await expect(harness.service.listTasksByCard("u1", { card: "nope" })).rejects.toMatchObject({
      code: "PIXEL_CARD_NOT_FOUND",
    });
  });
});

describe("pixel 导出", () => {
  it("单任务导出只含可导出状态且有结果链接的账号，文件名只留安全字符", async () => {
    const harness = createHarness();
    await harness.service.submitTask("u1", submitInput());
    harness.setHandler(async () =>
      result({
        task_id: "task-upstream-1",
        status: "completed",
        total_accounts: 3,
        accounts: [
          { id: 1, line_number: 1, email: "a@example.com", status: "success", result_link: "https://l/1" },
          { id: 2, line_number: 2, email: "b@example.com", status: "bind_success", result_link: "https://l/2" },
          { id: 3, line_number: 3, email: "c@example.com", status: "failed", result_link: "" },
        ],
      }),
    );
    const file = await harness.service.exportTaskText("u1", "task-upstream-1");
    expect(file.text).toBe("a@example.com----https://l/1\nb@example.com----https://l/2\n");
    expect(file.filename).toMatch(/^task_[a-z0-9]+_success\.txt$/);
  });

  it("不是本人的任务不能导出（归属校验在导出路径上也生效）", async () => {
    const harness = createHarness();
    await expect(harness.service.exportTaskText("u1", "task-other-user")).rejects.toMatchObject({
      status: 404,
    });
    expect(harness.calls).toHaveLength(0);
  });

  it("按卡密导出按本人 task id 过滤掉别人的行", async () => {
    const harness = createHarness();
    await harness.service.submitTask("u1", submitInput());
    harness.setHandler(async () =>
      result({
        accounts: [
          { task_id: "task-upstream-1", email: "mine@example.com", result_link: "https://l/mine" },
          { task_id: "task-other-user", email: "other@example.com", result_link: "https://l/other" },
        ],
      }),
    );
    const file = await harness.service.exportByCardText("u1", { card: "dist-card-0001" });
    expect(file.text).toBe("mine@example.com----https://l/mine\n");
    expect(file.text).not.toContain("other@example.com");
    expect(file.filename).toMatch(/^all_tasks_success_\d{8}_\d{6}\.txt$/);
  });

  it("上游导出口径不返回 task_id 时退化为「只导本人任务」，不跨用户下发", async () => {
    const harness = createHarness();
    await harness.service.submitTask("u1", submitInput());
    harness.setHandler(async (call) => {
      if (call.route === "exportByCard") {
        return result({ accounts: [{ email: "mine@example.com", result_link: "https://l/mine" }] });
      }
      return result({
        task_id: "task-upstream-1",
        status: "completed",
        total_accounts: 1,
        accounts: [{ id: 1, line_number: 1, email: "mine@example.com", status: "success", result_link: "https://l/mine" }],
      });
    });
    const file = await harness.service.exportByCardText("u1", { card: "dist-card-0001" });
    expect(file.text).toBe("mine@example.com----https://l/mine\n");
    expect(harness.calls.map((call) => call.route)).toContain("task");
  });
});

describe("pixel 取消排队", () => {
  function detailWith(status: string) {
    return result({
      task_id: "task-upstream-1",
      status: "running",
      total_accounts: 1,
      accounts: [{ id: 4, line_number: 1, email: "a@example.com", status, message: "" }],
    });
  }

  it("pending 账号会真的调上游取消", async () => {
    const harness = createHarness();
    await harness.service.submitTask("u1", submitInput());
    harness.setHandler(async (call) =>
      call.route === "cancelQueue" ? result({ message: "已取消" }) : detailWith("pending"),
    );
    const outcome = await harness.service.cancelQueuedAccount("u1", "task-upstream-1", 4);
    expect(outcome).toEqual({ cancelled: true, alreadyCancelled: false });
    expect(harness.calls.filter((call) => call.route === "cancelQueue")).toHaveLength(1);
  });

  it("已取消的账号重复取消幂等成功，且不再打上游", async () => {
    const harness = createHarness();
    await harness.service.submitTask("u1", submitInput());
    harness.setHandler(async (call) => {
      if (call.route === "cancelQueue") throw new Error("不该调用取消");
      return detailWith("cancelled");
    });
    const outcome = await harness.service.cancelQueuedAccount("u1", "task-upstream-1", 4);
    expect(outcome).toEqual({ cancelled: true, alreadyCancelled: true });
    expect(harness.calls.some((call) => call.route === "cancelQueue")).toBe(false);
  });

  it("已经在运行的账号拒绝取消（409），不打上游", async () => {
    const harness = createHarness();
    await harness.service.submitTask("u1", submitInput());
    harness.setHandler(async (call) => {
      if (call.route === "cancelQueue") throw new Error("不该调用取消");
      return detailWith("running");
    });
    await expect(harness.service.cancelQueuedAccount("u1", "task-upstream-1", 4)).rejects.toMatchObject({
      code: "PIXEL_ACCOUNT_NOT_CANCELLABLE",
      status: 409,
    });
    expect(harness.calls.some((call) => call.route === "cancelQueue")).toBe(false);
  });

  it("不属于本人的任务不能取消；账号不存在报 404", async () => {
    const harness = createHarness();
    await expect(harness.service.cancelQueuedAccount("u1", "task-other-user", 1)).rejects.toMatchObject({
      status: 404,
    });
    await harness.service.submitTask("u1", submitInput());
    harness.setHandler(async () => detailWith("pending"));
    await expect(harness.service.cancelQueuedAccount("u1", "task-upstream-1", 99)).rejects.toMatchObject({
      code: "PIXEL_ACCOUNT_NOT_FOUND",
      status: 404,
    });
  });

  it("上游取消失败时不谎报成功", async () => {
    const harness = createHarness();
    await harness.service.submitTask("u1", submitInput());
    harness.setHandler(async (call) =>
      call.route === "cancelQueue" ? result({ detail: "已开始" }, { status: 400 }) : detailWith("pending"),
    );
    await expect(harness.service.cancelQueuedAccount("u1", "task-upstream-1", 4)).rejects.toMatchObject({
      code: "PIXEL_ACCOUNT_NOT_CANCELLABLE",
      status: 409,
    });
  });
});

describe("pixel 数据副本与注销清理", () => {
  it("数据副本只有归属与脱敏字段，没有任何账号凭据", async () => {
    const harness = createHarness();
    await harness.service.submitTask("u1", submitInput());
    const exported = await harness.service.exportUserPixelData("u1");
    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain("a@example.com");
    expect(serialized).not.toContain("pass1");
    expect(serialized).not.toContain("TOTP1");
    expect(serialized).not.toContain("upstream-cdk-secret");
  });

  it("注销后任务记录不可见（软删除按 userId 生效）", async () => {
    const harness = createHarness();
    await harness.service.submitTask("u1", submitInput());
    const cleared = await harness.service.markUserPixelDataDeleted("u1", Date.now());
    expect(cleared.access).toBe(1);
    await expect(harness.service.getTask("u1", "task-upstream-1")).rejects.toMatchObject({ status: 404 });
  });
});
