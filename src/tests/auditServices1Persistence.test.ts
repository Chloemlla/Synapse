import mongoose from "mongoose";
import { Writable } from "node:stream";

const mockCdkFindById = jest.fn();
const mockCdkUpdate = jest.fn();
const mockCdkFind = jest.fn();
const mockCdkCount = jest.fn();
jest.mock("node:fs", () => ({ ...jest.requireActual("node:fs"), createWriteStream: jest.fn() }));
jest.mock("../models/cdkModel", () => ({ __esModule: true, default: {
  findById: mockCdkFindById, findByIdAndUpdate: mockCdkUpdate, countDocuments: mockCdkCount, find: mockCdkFind,
} }));
jest.mock("../models/resourceModel", () => ({ __esModule: true, default: {} }));
jest.mock("../services/resourceService", () => ({ ResourceService: class {} }));
jest.mock("../services/transactionService", () => ({ TransactionService: {} }));
jest.mock("../utils/userStorage", () => ({ UserStorage: {} }));
jest.mock("../services/emailSender", () => ({ sendEmail: jest.fn() }));
jest.mock("../templates/emailTemplates", () => ({ generateCDKActivatedEmailHtml: jest.fn() }));
jest.mock("../middleware/auth", () => ({ isAdminRole: jest.fn() }));
jest.mock("../services/turnstileService", () => ({ TurnstileService: {} }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), error: jest.fn() } }));

const { CDKService } = require("../services/cdkService") as typeof import("../services/cdkService");
const { imageDataService } = require("../services/imageDataService") as typeof import("../services/imageDataService");
const mockWriteStream = require("node:fs").createWriteStream as jest.Mock;

describe("audit services 1: persistence operations", () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it("clears an explicitly null expiry and leaves an omitted expiry unchanged", async () => {
    const service = Object.create(CDKService.prototype) as import("../services/cdkService").CDKService;
    const id = "1234567890abcdef12345678";
    mockCdkFindById.mockResolvedValue({ isUsed: false });
    mockCdkUpdate.mockResolvedValue({ id });
    await service.updateCDK(id, { expiresAt: null });
    expect(mockCdkUpdate).toHaveBeenLastCalledWith(id, { $set: {}, $unset: { expiresAt: 1 } }, { returnDocument: "after" });
    await service.updateCDK(id, {});
    expect(mockCdkUpdate).toHaveBeenLastCalledWith(id, { $set: {} }, { returnDocument: "after" });
    const expiry = new Date(Date.now() + 60_000);
    await service.updateCDK(id, { expiresAt: expiry });
    expect(mockCdkUpdate).toHaveBeenLastCalledWith(id, { $set: { expiresAt: expiry } }, { returnDocument: "after" });
  });

  it("allocates distinct files for concurrent exports within the same second", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-07T12:00:00Z"), doNotFake: ["nextTick", "setImmediate"] });
    const service = Object.create(CDKService.prototype) as import("../services/cdkService").CDKService;
    Object.defineProperty(service, "EXPORT_DIR", { value: process.cwd() });
    mockCdkCount.mockResolvedValue(6);
    mockCdkFind.mockImplementation(() => ({
      sort: () => ({ select: () => ({ lean: () => ({ cursor: async function* () {
        for (let i = 0; i < 6; i++) yield { code: `code-${i}`, resourceId: "resource", createdAt: new Date() };
      } }) }) }),
    }));
    mockWriteStream.mockImplementation(() => new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
    const [first, second] = await Promise.all([service.exportCDKs(), service.exportCDKs()]);
    expect(first.mode).toBe("file");
    expect(second.mode).toBe("file");
    expect(first.filename).not.toBe(second.filename);
    expect(mockWriteStream.mock.calls[0][0]).not.toBe(mockWriteStream.mock.calls[1][0]);
  });

  it("atomically upserts image data and preserves the stored creation time", async () => {
    const priorEnv = process.env.NODE_ENV;
    const data = { imageId: "image12345", fileName: "file.png", fileSize: 1, fileHash: "hash", md5Hash: "md5", web2url: "https://example.com/file", cid: "cid", uploadTime: "2026-10-07" };
    const createdAt = new Date("2026-01-01");
    const upsert = jest.spyOn(mongoose.model("ImageData"), "findOneAndUpdate")
      .mockResolvedValue({ ...data, createdAt, updatedAt: new Date() } as any);
    try {
      process.env.NODE_ENV = "production";
      const saved = await imageDataService.recordImageData(data);
      expect(saved.createdAt).toEqual(createdAt);
      expect(upsert).toHaveBeenCalledWith(
        { imageId: data.imageId },
        { $set: expect.objectContaining({ fileName: data.fileName, updatedAt: expect.any(Date) }), $setOnInsert: { createdAt: expect.any(Date) } },
        { upsert: true, returnDocument: "after", runValidators: true },
      );
      expect((upsert.mock.calls[0][1] as any).$set.imageId).toBeUndefined();
    } finally {
      process.env.NODE_ENV = priorEnv;
    }
  });
});
