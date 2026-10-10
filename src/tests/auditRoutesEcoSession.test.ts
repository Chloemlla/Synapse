import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import ecoEnchants from "../routes/ecoEnchantsRoutes";
import { config } from "../config/config";
import { assertActiveAuthSession, hashAuthCredential, touchAuthSession } from "../services/authSessionService";

jest.mock("../controllers/ecoEnchantsController", () => ({ EcoEnchantsController: new Proxy({}, {
  get: () => (_req: any, res: any) => res.json({ success: true }),
}) }));
jest.mock("../services/ecoEnchantsService", () => ({ ECO_ENCHANTS_PRODUCT_ID: "eco", verifyEcoEnchantsDownloadToken: jest.fn() }));
jest.mock("../middleware/routeLimiters", () => ({ createLimiter: () => (_req: any, _res: any, next: () => void) => next() }));
jest.mock("../middleware/auth", () => ({ isSuperAdmin: () => false }));
jest.mock("../utils/userStorage", () => ({ UserStorage: { getUserById: jest.fn(async () => ({ id: "eco-user", role: "user" })) } }));
jest.mock("../services/authSessionService", () => ({
  assertActiveAuthSession: jest.fn(), hashAuthCredential: jest.fn(() => "credential-hash"), touchAuthSession: jest.fn(),
}));

describe("EcoEnchants login session revocation", () => {
  const app = express();
  app.use("/eco", ecoEnchants);
  const token = jwt.sign({ userId: "eco-user" }, config.jwtSecret, { expiresIn: "1h" });

  beforeEach(() => jest.clearAllMocks());

  it("rejects a valid JWT whose session was revoked", async () => {
    (assertActiveAuthSession as jest.Mock).mockRejectedValue(new Error("revoked"));
    const response = await request(app).get("/eco/me/licenses").set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("unauthorized");
    expect(touchAuthSession).not.toHaveBeenCalled();
  });

  it("allows and refreshes an active login session", async () => {
    const session = { userAgent: "existing-client" };
    (assertActiveAuthSession as jest.Mock).mockResolvedValue(session);
    await request(app).get("/eco/me/licenses").set("Authorization", `Bearer ${token}`).expect(200);
    expect(hashAuthCredential).toHaveBeenCalledTimes(1);
    expect(assertActiveAuthSession).toHaveBeenCalledWith("eco-user", token, "credential-hash");
    expect(touchAuthSession).toHaveBeenCalledWith("eco-user", token, expect.any(Object), "credential-hash", session);
  });
});
