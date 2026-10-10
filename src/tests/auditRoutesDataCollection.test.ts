import express from "express";
import request from "supertest";
import adminRoutes from "../routes/dataCollectionAdminRoutes";
import { dataCollectionLimiter } from "../middleware/routeLimiters";
import { dataCollectionService } from "../services/dataCollectionService";

jest.mock("../services/dataCollectionService", () => ({ dataCollectionService: {
  getStats: jest.fn(), list: jest.fn(), getById: jest.fn(), decryptRawDetails: jest.fn(),
  deleteById: jest.fn(), deleteBatch: jest.fn(), deleteAllAction: jest.fn(),
} }));
jest.mock("../middleware/routeLimiters", () => ({ dataCollectionLimiter: (_req: any, res: any, next: () => void) => {
  res.locals.limiterHits = (res.locals.limiterHits || 0) + 1;
  res.set("x-test-limiter-hits", String(res.locals.limiterHits));
  next();
} }));
jest.mock("../middleware/authenticateToken", () => ({ authenticateToken: (_req: any, _res: any, next: () => void) => next() }));
jest.mock("../middleware/adminScope", () => ({ requireAdminScope: (_req: any, _res: any, next: () => void) => next() }));
jest.mock("../middleware/auth", () => ({
  authenticateAdmin: (_req: any, _res: any, next: () => void) => next(),
  authenticateSuperAdmin: (_req: any, _res: any, next: () => void) => next(),
}));
jest.mock("../middleware/auditLog", () => ({ auditLog: () => (_req: any, _res: any, next: () => void) => next() }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { error: jest.fn(), info: jest.fn() } }));

describe("data collection admin route boundaries", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/data-collection", dataCollectionLimiter);
  app.use("/api/data-collection/admin", adminRoutes);
  const failure = new Error("private database details");

  beforeEach(() => jest.clearAllMocks());

  it("charges the shared prefix limiter once per admin request", async () => {
    (dataCollectionService.getStats as jest.Mock).mockResolvedValue({ total: 0 });
    const response = await request(app).get("/api/data-collection/admin/stats");
    expect(response.status).toBe(200);
    expect(response.headers["x-test-limiter-hits"]).toBe("1");
  });

  it.each([
    ["get", "/stats", "getStats"],
    ["get", "/", "list"],
    ["get", "/item", "getById"],
    ["get", "/item/raw", "getById"],
    ["delete", "/item", "deleteById"],
    ["post", "/delete-batch", "deleteBatch"],
    ["delete", "/all", "deleteAllAction"],
  ] as const)("keeps %s %s database failures out of responses", async (method, path, serviceMethod) => {
    (dataCollectionService[serviceMethod] as jest.Mock).mockRejectedValue(failure);
    const response = await request(app)[method](`/api/data-collection/admin${path}`).send({ ids: ["item"], confirm: true });
    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
    expect(JSON.stringify(response.body)).not.toContain(failure.message);
    expect(response.headers["x-test-limiter-hits"]).toBe("1");
  });
});
