import { NexaiSyncService, NexaiSyncVersionConflictError } from "../services/nexaiSyncService";
import { NexaiSyncModel } from "../models/nexaiSyncModel";

jest.mock("../models/nexaiSyncModel", () => ({
  NexaiSyncModel: { findOne: jest.fn(), updateOne: jest.fn(), findOneAndUpdate: jest.fn() },
}));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), error: jest.fn() } }));

const note = (id: string) => ({ id, title: id, content: id, isStarred: false, createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z" });
const snapshot = () => ({
  _id: "doc-1", userId: "user-1", version: 1, notes: [], conversations: [],
  translationHistory: [], savedPasswords: [], shortUrls: [], settings: {}, lastSyncedAt: new Date(),
});

describe("audit services 2: sync concurrency", () => {
  beforeEach(() => jest.clearAllMocks());

  it("remerges after another device commits and preserves both devices' notes", async () => {
    let stored: any = snapshot();
    (NexaiSyncModel.findOne as jest.Mock).mockImplementation(async () => structuredClone(stored));
    (NexaiSyncModel.updateOne as jest.Mock).mockImplementation(async (filter, update) => {
      if (filter.version !== stored.version) return { modifiedCount: 0 };
      stored = { ...stored, ...structuredClone(update.$set), version: stored.version + 1 };
      return { modifiedCount: 1 };
    });

    await Promise.all([
      NexaiSyncService.mergeIncrementalData("user-1", { notes: [note("device-a")] }, ""),
      NexaiSyncService.mergeIncrementalData("user-1", { notes: [note("device-b")] }, ""),
    ]);

    expect(stored.notes.map((entry: { id: string }) => entry.id).sort()).toEqual(["device-a", "device-b"]);
    expect(stored.version).toBe(3);
  });

  it("bounds retries and reports a conflict without falling back to an unconditional save", async () => {
    (NexaiSyncModel.findOne as jest.Mock).mockImplementation(async () => snapshot());
    (NexaiSyncModel.updateOne as jest.Mock).mockResolvedValue({ modifiedCount: 0 });
    await expect(NexaiSyncService.mergeIncrementalData("user-1", { notes: [note("a")] }, ""))
      .rejects.toBeInstanceOf(NexaiSyncVersionConflictError);
    expect(NexaiSyncModel.updateOne).toHaveBeenCalledTimes(3);
  });

  it("advances the same version when a category is replaced", async () => {
    (NexaiSyncModel.findOneAndUpdate as jest.Mock).mockResolvedValue(snapshot());
    await NexaiSyncService.patchSyncData("user-1", "notes", [note("a")]);
    expect(NexaiSyncModel.findOneAndUpdate).toHaveBeenCalledWith(
      { userId: "user-1" }, expect.objectContaining({ $inc: { version: 1 } }), expect.anything(),
    );
  });
});
