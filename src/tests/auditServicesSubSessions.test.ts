const mockSession = { find: jest.fn(), findOne: jest.fn(), deleteMany: jest.fn() };
jest.mock("../models/lumen/index", () => ({ Session: mockSession }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn() } }));

const { listLumenDevices, revokeLumenDevice } = require("../services/lumen/session.service");
const { deriveLumenDeviceKey } = require("../utils/lumenClientIdentity");

beforeEach(() => jest.clearAllMocks());

it("bounds the recent session list while preserving an older current device", async () => {
  const row = { _id: "recent", userId: "u1", deviceInstallationId: "recent-device", createdAt: 1, expiresAt: new Date(Date.now() + 60_000) };
  const query: any = { sort: () => query, select: () => query, limit: jest.fn(() => query), lean: async () => [row] };
  mockSession.find.mockReturnValue(query);
  mockSession.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ ...row, _id: "current", deviceInstallationId: "old-device" }) }) });
  const devices = await listLumenDevices("u1", "current");
  expect(query.limit).toHaveBeenCalledWith(200);
  expect(devices.some((device: any) => device.current && device.deviceId === "old-device")).toBe(true);
});

it("streams legacy device sessions and deletes bounded batches", async () => {
  const cursor = {
    close: jest.fn(async () => undefined),
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index < 405; index++) {
        yield { _id: `session-${index}`, deviceInstallationId: "device" };
      }
    },
  };
  mockSession.find.mockReturnValue({ select: () => ({ lean: () => ({ cursor: () => cursor }) }) });
  mockSession.deleteMany.mockImplementation(async (filter) => ({ deletedCount: filter._id.$in.length }));
  const result = await revokeLumenDevice("u1", deriveLumenDeviceKey("u1", undefined, "device", undefined));
  expect(result).toEqual({ revoked: 405 });
  expect(mockSession.deleteMany.mock.calls.map(([filter]) => filter._id.$in.length)).toEqual([200, 200, 5]);
  expect(cursor.close).toHaveBeenCalledTimes(1);
});

it("refuses the current device before opening the revocation cursor", async () => {
  mockSession.findOne.mockReturnValue({ select: () => ({ lean: async () => ({ _id: "current", deviceInstallationId: "device" }) }) });
  await expect(revokeLumenDevice("u1", deriveLumenDeviceKey("u1", undefined, "device", undefined), "current"))
    .rejects.toMatchObject({ code: "CURRENT_SESSION_PROTECTED" });
  expect(mockSession.find).not.toHaveBeenCalled();
  expect(mockSession.deleteMany).not.toHaveBeenCalled();
});
