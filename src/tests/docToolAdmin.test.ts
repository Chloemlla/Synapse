import { beforeEach, describe, expect, it, jest } from "@jest/globals";

/**
 * `/api/admin/doc-tool/*` 的服务端契约（页面 `/admin/doc-tool`）。
 *
 * 三条边界必须钉住，否则运维面板会变成越权入口：
 *   1. 列表只回元数据，limit 钳到 200；
 *   2. 目录扫描跳过符号链接与越界路径（防顺链读出工作根之外）；
 *   3. 清理预演**不删任何东西**，真实执行才动磁盘。
 */

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFind = jest.fn();
const mockCount = jest.fn();
const mockDeleteMany = jest.fn();

jest.mock("../models/docToolModels", () => ({
  DocToolJobModel: {
    find: (...args: unknown[]) => mockFind(...args),
    countDocuments: (...args: unknown[]) => mockCount(...args),
    deleteMany: (...args: unknown[]) => mockDeleteMany(...args),
  },
}));

jest.mock("../docTool/runtime", () => ({
  probePandoc: () => ({ available: true, version: "pandoc 3.12", bin: "pandoc", error: undefined }),
  resolvePandocBin: () => "pandoc",
  resolveDocToolRoot: () => process.cwd(),
  resolveUserRoot: (userId: string, root?: string) => `${root ?? process.cwd()}/users/${userId}`,
  relInside: (root: string, target: string) => (target.startsWith(root) ? target.slice(root.length) : null),
}));

const mockPurge = jest.fn();
const mockSweep = jest.fn();
jest.mock("../docTool/jobs/docArtifactCleanup", () => ({
  purgeDocArtifacts: (...args: unknown[]) => mockPurge(...args),
  sweepExpiredArtifacts: (...args: unknown[]) => mockSweep(...args),
}));

jest.mock("../docTool/types", () => ({
  docLimitsFromEnv: () => ({
    maxUploadBytes: 1024,
    maxFileBytes: 512,
    maxFilesPerJob: 8,
    maxActiveJobs: 3,
    retentionDays: 7,
  }),
}));

jest.mock("../utils/userStorage", () => ({
  UserStorage: { getUsersByIds: jest.fn().mockResolvedValue([]) },
}));

import { DocToolAdminService } from "../docTool/admin/docToolAdminService";

function chain(result: unknown) {
  const handle: Record<string, jest.Mock> = {};
  for (const key of ["select", "sort", "skip", "limit", "lean"]) handle[key] = jest.fn().mockReturnValue(handle);
  handle.exec = jest.fn().mockResolvedValue(result);
  return handle;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("DocToolAdminService.listJobs", () => {
  it("limit 钳到 200，只投影元数据字段", async () => {
    mockCount.mockResolvedValue(1);
    mockFind.mockReturnValue(
      chain([
        {
          id: "job-1",
          userId: "u-1",
          status: "succeeded",
          progress: 100,
          total: 3,
          ok: 3,
          skipped: 0,
          failed: 0,
          createdAt: new Date("2026-11-01T00:00:00Z"),
        },
      ]),
    );

    const result = await DocToolAdminService.listJobs({ limit: 9999, offset: 40 });

    const chainHandle = mockFind.mock.results[0]!.value as Record<string, jest.Mock>;
    expect(chainHandle.limit).toHaveBeenCalledWith(200);
    expect(chainHandle.skip).toHaveBeenCalledWith(40);

    const projection = (chainHandle.select.mock.calls[0] as unknown[])[0] as string;
    expect(projection).not.toContain("items");
    expect(projection).not.toContain("logs");

    expect(result.total).toBe(1);
    expect(result.jobs[0]!.id).toBe("job-1");
    expect(result.jobs[0]!.createdAt).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("DocToolAdminService.runCleanup", () => {
  it("预演不删任何东西，也不调用清理实现", async () => {
    mockFind.mockReturnValue(
      chain([
        {
          id: "job-1",
          userId: "u-1",
          items: [
            { status: "ok", destRel: "out/a.docx" },
            { status: "skipped", destRel: "out/b.docx" },
          ],
        },
      ]),
    );

    const result = await DocToolAdminService.runCleanup({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.expiredJobs).toBe(1);
    expect(result.purgedFiles).toBe(1); // 只数 status=ok 且有 destRel 的
    expect(mockPurge).not.toHaveBeenCalled();
    expect(mockSweep).not.toHaveBeenCalled();
    expect(mockDeleteMany).not.toHaveBeenCalled();
  });

  it("真实执行走既有清理实现并删除过期任务记录", async () => {
    mockFind.mockReturnValue(chain([{ id: "job-1", userId: "u-1", items: [] }]));
    mockPurge.mockReturnValue(2);
    mockSweep.mockReturnValue(0);
    mockDeleteMany.mockReturnValue({ exec: jest.fn().mockResolvedValue({ deletedCount: 1 }) });

    const result = await DocToolAdminService.runCleanup({ dryRun: false });

    expect(result.dryRun).toBe(false);
    expect(mockPurge).toHaveBeenCalledWith(
      expect.objectContaining({ id: "job-1" }),
      expect.stringContaining("users/u-1"),
      { keepInputs: true },
    );
    expect(mockDeleteMany).toHaveBeenCalled();
  });
});

describe("DocToolAdminService.overview", () => {
  it("回引擎状态与限额，不回宿主绝对路径", () => {
    const result = DocToolAdminService.overview();
    expect(result.pandoc.available).toBe(true);
    expect(result.limits.retentionDays).toBe(7);
    // 只给「工作根是否绝对路径」这个布尔，不回原值。
    expect(typeof result.workRootIsAbsolute).toBe("boolean");
    expect(Object.keys(result.workRoot)).toEqual(["writable"]);
  });
});
