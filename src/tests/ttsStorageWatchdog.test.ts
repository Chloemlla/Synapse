import { beforeEach, describe, expect, it, jest } from "@jest/globals";

// mongoose 替身：storage 模块在加载期 new Schema 并 mongoose.model(...)，这里让
// mongoose.models.TtsJob 直接等于我们的假模型，避免真连库。
const mockModel = {
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateMany: jest.fn(),
};

jest.mock("../services/mongoService", () => ({
  mongoose: {
    Schema: class {
      index() {
        return this;
      }
    },
    models: { TtsJob: mockModel },
    model: () => mockModel,
  },
}));

import { TTS_MAX_ATTEMPTS, ttsStorage } from "../tts/tts.storage";

const chainRows = (rows: unknown[]) => ({ select: () => ({ lean: () => ({ exec: async () => rows }) }) });
const chainDoc = (doc: unknown) => ({ lean: () => ({ exec: async () => doc }) });
const chainCount = (modifiedCount: number) => ({ exec: async () => ({ modifiedCount }) });

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ttsStorage 看门狗", () => {
  it("renewJobLease 只续自己持有的 processing 租约", async () => {
    mockModel.findOneAndUpdate.mockReturnValueOnce(chainDoc({ taskId: "t1", status: "processing" }));

    const renewed = await ttsStorage.renewJobLease("t1", "worker-1", 5000);

    expect(renewed).toMatchObject({ taskId: "t1" });
    const [filter, update] = mockModel.findOneAndUpdate.mock.calls[0] as unknown as [Record<string, unknown>, { $set: Record<string, unknown> }];
    expect(filter).toEqual({ taskId: "t1", status: "processing", processingOwner: "worker-1" });
    expect(typeof update.$set.leaseExpiresAt).toBe("string");
  });

  it("租约已失效时 renewJobLease 返回 null（旧 Worker 据此放弃终态提交）", async () => {
    mockModel.findOneAndUpdate.mockReturnValueOnce(chainDoc(null));
    await expect(ttsStorage.renewJobLease("t1", "worker-1", 5000)).resolves.toBeNull();
  });

  it("超时任务按「仍超时」条件原子死信化，竞态被抢先的不进 failed", async () => {
    mockModel.find.mockReturnValueOnce(chainRows([{ taskId: "t-over" }, { taskId: "t-race" }]));
    mockModel.findOneAndUpdate
      .mockReturnValueOnce(chainDoc({ taskId: "t-over", status: "failed", attempts: TTS_MAX_ATTEMPTS }))
      .mockReturnValueOnce(chainDoc(null)); // 已被续租/完成：条件不匹配，不改
    mockModel.updateMany.mockReturnValueOnce(chainCount(2));

    const result = await ttsStorage.recoverStaleJobs(1_000);

    expect(result.recovered).toBe(2);
    expect(result.failed.map((job) => job.taskId)).toEqual(["t-over"]);

    // 死信更新的条件里必须带 status/lease/attempts（原子条件更新），不能只按 taskId 更新。
    const [deadFilter, deadUpdate] = mockModel.findOneAndUpdate.mock.calls[0] as unknown as [
      Record<string, any>,
      { $set: Record<string, unknown> },
    ];
    expect(deadFilter).toMatchObject({
      taskId: "t-over",
      status: "processing",
      attempts: { $gte: TTS_MAX_ATTEMPTS },
    });
    expect(deadFilter.leaseExpiresAt.$lte).toBe(new Date(1_000).toISOString());
    expect(deadUpdate.$set).toMatchObject({ status: "failed", processingOwner: null, leaseExpiresAt: null });
  });

  it("未超限超时任务原子退回 queued，条件含 status/lease/attempts", async () => {
    mockModel.find.mockReturnValueOnce(chainRows([]));
    mockModel.updateMany.mockReturnValueOnce(chainCount(1));

    const result = await ttsStorage.recoverStaleJobs(2_000);

    expect(result).toEqual({ recovered: 1, failed: [] });
    const [filter, update] = mockModel.updateMany.mock.calls[0] as unknown as [Record<string, any>, { $set: Record<string, unknown> }];
    expect(filter).toMatchObject({ status: "processing", attempts: { $lt: TTS_MAX_ATTEMPTS } });
    expect(filter.leaseExpiresAt.$lte).toBe(new Date(2_000).toISOString());
    expect(update.$set).toMatchObject({ status: "queued", processingOwner: null, leaseExpiresAt: null });
  });
});
