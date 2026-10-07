import { fbiWantedController } from "../controllers/fbiWantedController";
import FBIWantedModel from "../models/fbiWantedModel";

jest.mock("../models/fbiWantedModel", () => ({ __esModule: true, default: { deleteMany: jest.fn() } }));
jest.mock("../services/ipfsService", () => ({ IPFSService: {} }));
jest.mock("../middleware/auth", () => ({ isAdminRole: jest.fn() }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), error: jest.fn() } }));

function response() {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("FBI bulk deletion confirmation contract", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    {}, { filter: [] }, { filter: {} }, { filter: {}, confirmAll: "true" },
    { filter: { foo: 1 }, confirmAll: true },
    { filter: { status: "invalid" }, confirmAll: true },
    { filter: { beforeDate: "invalid" }, confirmAll: true },
    { filter: { isActive: true, beforeDate: "invalid" } },
    { filter: { afterDate: "2026-02-01", beforeDate: "2026-01-01" } },
  ])("rejects invalid or unconfirmed deletion: %j", async (body) => {
    const res = response();
    await fbiWantedController.deleteMultiple({ body } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(FBIWantedModel.deleteMany).not.toHaveBeenCalled();
  });

  it("allows an explicitly confirmed empty filter", async () => {
    (FBIWantedModel.deleteMany as jest.Mock).mockResolvedValue({ deletedCount: 4 });
    const res = response();
    await fbiWantedController.deleteMultiple({ body: { filter: {}, confirmAll: true } } as any, res);
    expect(FBIWantedModel.deleteMany).toHaveBeenCalledWith({});
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("retains valid false filters without full-delete confirmation", async () => {
    (FBIWantedModel.deleteMany as jest.Mock).mockResolvedValue({ deletedCount: 1 });
    await fbiWantedController.deleteMultiple({ body: { filter: { isActive: false } } } as any, response());
    expect(FBIWantedModel.deleteMany).toHaveBeenCalledWith({ isActive: false });
  });
});
