import express from "express";
import request from "supertest";
import articles from "../routes/markdownArticleRoutes";
import { MarkdownArticleService } from "../services/markdownArticleService";
import { getPagesForUser } from "../services/adminScopeConfigService";

jest.mock("../services/markdownArticleService", () => ({
  MarkdownArticleService: {
    listPublished: jest.fn(), listAdmin: jest.fn(), getAdminById: jest.fn(), delete: jest.fn(),
  },
  createArticleSlug: jest.fn(),
}));
jest.mock("../services/adminScopeConfigService", () => ({ getPagesForUser: jest.fn() }));
jest.mock("../middleware/routeLimiters", () => ({ adminLimiter: (_req: any, _res: any, next: () => void) => next() }));
jest.mock("../middleware/authenticateToken", () => ({ authenticateToken: (req: any, _res: any, next: () => void) => {
  req.user = { id: "article-admin", role: req.headers["x-role"] || "admin" }; next();
} }));
jest.mock("../middleware/auth", () => ({
  isAdminRole: (role: string) => ["admin", "superadmin"].includes(role),
  authenticateAdmin: (_req: any, _res: any, next: () => void) => next(),
  authenticateSuperAdmin: (req: any, res: any, next: () => void) => req.user.role === "superadmin" ? next() : res.sendStatus(403),
}));
jest.mock("../middleware/auditLog", () => ({ auditLog: () => (_req: any, _res: any, next: () => void) => next() }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn() } }));

describe("article route scope and failure boundary", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/articles", articles);

  beforeEach(() => {
    jest.clearAllMocks();
    (getPagesForUser as jest.Mock).mockResolvedValue([]);
    (MarkdownArticleService.listAdmin as jest.Mock).mockResolvedValue([]);
  });

  it("denies an administrator without the article page before querying drafts", async () => {
    const response = await request(app).get("/api/articles/admin/all");
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("ADMIN_SCOPE_FORBIDDEN");
    expect(MarkdownArticleService.listAdmin).not.toHaveBeenCalled();
  });

  it("allows the same administrator after runtime page assignment", async () => {
    (getPagesForUser as jest.Mock).mockResolvedValue(["markdown-articles"]);
    await request(app).get("/api/articles/admin/all").expect(200);
    expect(MarkdownArticleService.listAdmin).toHaveBeenCalledTimes(1);
  });

  it("keeps public listing failures generic", async () => {
    (MarkdownArticleService.listPublished as jest.Mock).mockRejectedValue(new Error("internal-db-host-and-password"));
    const response = await request(app).get("/api/articles/");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, message: "获取文章失败" });
  });

  it("keeps superadmin deletion failures generic", async () => {
    (MarkdownArticleService.delete as jest.Mock).mockRejectedValue(new Error("internal-db-host-and-password"));
    const response = await request(app).delete("/api/articles/admin/example").set("x-role", "superadmin");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, message: "删除文章失败" });
  });
});
