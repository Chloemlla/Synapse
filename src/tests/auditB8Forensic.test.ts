/**
 * RC-35 / RC-58：取证审计集合与导出硬顶。
 *
 * 钉住：
 *  a) 两张取证表都没有 TTL 索引（普通 audit_logs 的 60 天不适用于取证事件）；
 *  b) 行数硬顶是「拒绝」而不是「截断」，且带稳定 code EXPORT_LIMIT_EXCEEDED；
 *  c) 导出源只带固定字段白名单，绝不包含密码/令牌等凭据字段；
 *  d) 取证事件同时写普通审计与取证集合；
 *  e) 未完成双人确认 / 非当事人不能下载。
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { mongoose } from "../services/mongoService";
import {
  ForensicAuditLogModel,
  ForensicExportRequestModel,
  type IForensicExportRequest,
} from "../models/forensicAuditModel";
import {
  EXPORT_LIMIT_EXCEEDED,
  ForensicExportLimitError,
  assertDownloadable,
  assertWithinExportCap,
  buildForensicExportSources,
  recordForensicEvent,
} from "../services/forensicAuditService";
import { AuditLogService } from "../services/auditLogService";

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../services/auditLogService", () => ({
  __esModule: true,
  AuditLogService: { log: jest.fn().mockResolvedValue(undefined) },
}));

function setReadyState(value: number): void {
  Object.defineProperty(mongoose.connection, "readyState", { configurable: true, value });
}

function hasTtlIndex(model: any): boolean {
  return model.schema.indexes().some((entry: any) => {
    const options = entry?.[1];
    return Boolean(options && "expireAfterSeconds" in options);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  setReadyState(1);
});

describe("不设 TTL 的取证集合", () => {
  it("forensic_audit_logs 没有 TTL 索引", () => {
    expect(hasTtlIndex(ForensicAuditLogModel)).toBe(false);
  });

  it("forensic_export_requests 没有 TTL 索引", () => {
    expect(hasTtlIndex(ForensicExportRequestModel)).toBe(false);
  });
});

describe("导出硬顶：拒绝而不是截断", () => {
  it("恰好 20000 行允许", () => {
    expect(assertWithinExportCap(20_000)).toBe(20_000);
  });

  it("超过 20000 行抛 EXPORT_LIMIT_EXCEEDED / 413", () => {
    try {
      assertWithinExportCap(20_001);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ForensicExportLimitError);
      const limitError = error as ForensicExportLimitError;
      expect(limitError.code).toBe(EXPORT_LIMIT_EXCEEDED);
      expect(limitError.statusCode).toBe(413);
      expect(limitError.totalRows).toBe(20_001);
      expect(limitError.message).toContain("未导出任何数据");
    }
  });

  it("非法计数按 503 拒绝，而不是当成 0 行放行", () => {
    expect(() => assertWithinExportCap(Number.NaN)).toThrow();
  });
});

describe("导出源字段白名单", () => {
  it("用户维度包含账户文档，但不含任何凭据字段", () => {
    const sources = buildForensicExportSources({
      scope: "user",
      value: "u1",
      from: null,
      to: null,
    });
    const users = sources.find((source) => source.collection === "user_datas");
    expect(users).toBeDefined();
    expect(users?.fields).toContain("username");
    const forbidden = ["password", "passwordHash", "totpSecret", "backupCodes", "passkeyCredentials", "token"];
    for (const field of forbidden) {
      expect(users?.fields).not.toContain(field);
    }
    // 固定字段顺序：第一列是 id，用于核对交付件的同一性。
    expect(users?.fields[0]).toBe("id");
  });

  it("IP 与指纹维度不复用账户文档集合", () => {
    const ipSources = buildForensicExportSources({ scope: "ip", value: "1.2.3.4", from: null, to: null });
    expect(ipSources.some((source) => source.collection === "user_datas")).toBe(false);
    const fpSources = buildForensicExportSources({ scope: "fingerprint", value: "fp1", from: null, to: null });
    expect(fpSources.some((source) => source.collection === "user_datas")).toBe(false);
  });
});

describe("取证事件双写", () => {
  it("同时写普通审计与不设 TTL 的取证集合", async () => {
    const createSpy = jest
      .spyOn(ForensicAuditLogModel, "create")
      .mockResolvedValue({ eventId: "fev_test" } as never);

    const result = await recordForensicEvent({
      action: "legal_hold.create",
      actor: { id: "admin-1", username: "admin", role: "superadmin" },
      caseRef: "CASE-1",
      scope: "user",
      subjectValue: "u1",
      reason: "warrant",
      request: { ip: "203.0.113.9", path: "/api/admin/legal-holds", method: "POST" },
    });

    expect(result).toEqual({ auditLogged: true, forensicLogged: true });
    expect(AuditLogService.log).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    const payload = createSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.action).toBe("legal_hold.create");
    expect(payload.caseRef).toBe("CASE-1");
    expect(payload.subjectValue).toBe("u1");
    expect(String(payload.eventId)).toMatch(/^fev_/);
    const auditEntry = (AuditLogService.log as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(auditEntry.module).toBe("security");
  });
});

describe("双人确认与下载权限", () => {
  function request(overrides: Partial<IForensicExportRequest> = {}): IForensicExportRequest {
    return {
      requestId: "fxr_1",
      requestedByUserId: "admin-a",
      requestedByUsername: "a",
      approvedByUserId: "admin-b",
      approvedByUsername: "b",
      caseRef: "CASE-1",
      reason: "warrant",
      scope: "user",
      subjectValue: "u1",
      from: null,
      to: null,
      status: "approved",
      expiresAt: new Date(Date.now() + 60_000),
      approvedAt: new Date(),
      downloadedAt: null,
      rowCount: 0,
      checksum: "",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  it("未批准的申请不能下载", () => {
    expect(() => assertDownloadable(request({ status: "pending" }), { id: "admin-a", username: "a", role: "superadmin" }))
      .toThrowError(/双人确认/);
  });

  it("非发起人/批准人不能下载", () => {
    expect(() => assertDownloadable(request(), { id: "admin-c", username: "c", role: "superadmin" }))
      .toThrowError(/发起人或批准人/);
  });

  it("过期申请不能下载", () => {
    expect(() =>
      assertDownloadable(request({ expiresAt: new Date(Date.now() - 1000) }), {
        id: "admin-a",
        username: "a",
        role: "superadmin",
      }),
    ).toThrowError(/过期/);
  });

  it("发起人或批准人可以下载", () => {
    expect(() => assertDownloadable(request(), { id: "admin-a", username: "a", role: "superadmin" })).not.toThrow();
    expect(() => assertDownloadable(request(), { id: "admin-b", username: "b", role: "superadmin" })).not.toThrow();
  });
});
