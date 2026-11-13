import fs from "node:fs";
import path from "node:path";
import swaggerJSDoc from "swagger-jsdoc";
import logger from "../utils/logger";
import {
  AUDIT_LOG_ADAPTATION_STATUS,
  AUDIT_LOG_OPENAPI_EXTENSION,
  AUDIT_LOG_SOURCE,
  inferAuditModuleFromPath,
  isAuditLogRuntimeEnabled,
  isBackendApiPath,
} from "./auditLogMetadata";

interface OpenapiJsonCache {
  filePath: string;
  mtimeMs: number;
  content: string;
}

let openapiJsonCache: OpenapiJsonCache | null = null;
const GENERATED_OPENAPI_CACHE_KEY = "__generated_openapi__";
const OPENAPI_HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

type MutableOpenapiObject = Record<string, any>;

// glob 在所有平台都把 `\` 当转义符，所以 path.join 拼出的 Windows 路径会 0 命中，
// 运行时兜底生成的 spec 会变成空 paths。glob 模式必须始终用正斜杠。
const projectRoot = process.cwd().split(path.sep).join("/");

const runtimeSwaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Synapse API 文档",
      version: "1.0.0",
      description: "基于 OpenAPI 3.0 的接口文档",
    },
  },
  apis: [`${projectRoot}/src/routes/**/*.ts`, `${projectRoot}/dist/routes/**/*.js`],
};

export function getOpenapiJsonCandidates(): string[] {
  return [
    process.env.OPENAPI_JSON_PATH && path.resolve(process.env.OPENAPI_JSON_PATH),
    "/app/openapi.json",
    path.join(process.cwd(), "openapi.json"),
    path.join(__dirname, "../openapi.json"),
    path.join(process.cwd(), "dist/openapi.json"),
  ].filter(Boolean) as string[];
}

function formatOpenapiNotFoundError(candidates: string[], detail?: string): Error {
  const suffix = detail ? ` (${detail})` : "";
  return new Error(`openapi.json not found in: ${candidates.join(" | ")}${suffix}`);
}

function isRecord(value: unknown): value is MutableOpenapiObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 路径数量：0 表示这份 spec 不能用来渲染 API 文档（Swagger UI 只会显示空白页）。 */
function countOpenapiPaths(document: unknown): number {
  if (!isRecord(document) || !isRecord(document.paths)) return 0;
  return Object.keys(document.paths).length;
}

function buildAuditLogMetadata(openapiPath: string, method?: string): MutableOpenapiObject {
  const isApiPath = isBackendApiPath(openapiPath);

  return {
    enabled: isApiPath && isAuditLogRuntimeEnabled(),
    coverage: isApiPath ? "all-api-routes" : "not-applicable",
    adaptationStatus: isApiPath ? AUDIT_LOG_ADAPTATION_STATUS : "not-applicable",
    source: isApiPath ? AUDIT_LOG_SOURCE : "not-applicable",
    module: isApiPath ? inferAuditModuleFromPath(openapiPath) : "other",
    action: method ? `${method.toUpperCase()} ${openapiPath}` : undefined,
  };
}

export function addAuditLogMetadataToOpenapiDocument<T extends MutableOpenapiObject>(document: T): T {
  const mutableDocument: MutableOpenapiObject = document;

  mutableDocument[AUDIT_LOG_OPENAPI_EXTENSION] = {
    enabled: isAuditLogRuntimeEnabled(),
    coverage: "all-api-routes",
    adaptationStatus: AUDIT_LOG_ADAPTATION_STATUS,
    source: AUDIT_LOG_SOURCE,
    dynamic: true,
  };

  if (!isRecord(mutableDocument.paths)) {
    return document;
  }

  for (const [openapiPath, pathItem] of Object.entries(mutableDocument.paths)) {
    if (!isRecord(pathItem)) {
      continue;
    }

    pathItem[AUDIT_LOG_OPENAPI_EXTENSION] = buildAuditLogMetadata(openapiPath);

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!OPENAPI_HTTP_METHODS.has(method.toLowerCase()) || !isRecord(operation)) {
        continue;
      }

      operation[AUDIT_LOG_OPENAPI_EXTENSION] = buildAuditLogMetadata(openapiPath, method);
    }
  }

  return document;
}

function stringifyOpenapiDocument(document: MutableOpenapiObject): string {
  return `${JSON.stringify(addAuditLogMetadataToOpenapiDocument(document), null, 2)}\n`;
}

/**
 * 把候选文件的原文变成可下发的 spec；不可用时给出原因，由调用方决定是否换下一个候选。
 *
 * 零路径的 spec 一律判为不可用：历史上镜像里那份 205 字节的空 openapi.json 就是这么把
 * 「API 文档页空白」送到线上的——接口返回 200，前端却拿不到任何端点可渲染。
 */
type SpecContentResult = { ok: true; content: string } | { ok: false; reason: string };

function toUsableSpecContent(raw: string, source: string): SpecContentResult {
  let document: MutableOpenapiObject;
  try {
    document = JSON.parse(raw) as MutableOpenapiObject;
  } catch (_error) {
    logger.warn(`[openapi] ${source} 不是合法 JSON，跳过该候选`);
    return { ok: false, reason: `${source} is not valid JSON` };
  }

  const pathCount = countOpenapiPaths(document);
  if (pathCount === 0) {
    logger.warn(`[openapi] ${source} 的 paths 为空，跳过该候选`);
    return { ok: false, reason: `${source} declares zero paths` };
  }

  return { ok: true, content: stringifyOpenapiDocument(document) };
}

function generateOpenapiJson(): string {
  const swaggerSpec = swaggerJSDoc(runtimeSwaggerOptions) as MutableOpenapiObject;

  // 运行期兜底同样是 glob + minimatch 的受害者：扫不到注释时 swagger-jsdoc 只会
  // 吐空 spec。宁可让 /api/openapi.json 明确 500，也不要把空清单发给 Swagger UI。
  const pathCount = countOpenapiPaths(swaggerSpec);
  if (pathCount === 0) {
    throw new Error("generated openapi document declares zero paths");
  }

  return stringifyOpenapiDocument(swaggerSpec);
}

export async function readOpenapiJson(): Promise<string> {
  const candidates = getOpenapiJsonCandidates();
  const skipReasons: string[] = [];

  for (const candidate of candidates) {
    try {
      const stats = await fs.promises.stat(candidate);
      if (!stats.isFile()) {
        continue;
      }

      if (openapiJsonCache?.filePath === candidate && openapiJsonCache.mtimeMs === stats.mtimeMs) {
        return openapiJsonCache.content;
      }

      const result = toUsableSpecContent(await fs.promises.readFile(candidate, "utf-8"), candidate);
      if (!result.ok) {
        skipReasons.push(result.reason);
        continue;
      }

      openapiJsonCache = { filePath: candidate, mtimeMs: stats.mtimeMs, content: result.content };
      return result.content;
    } catch (_error) {
      // Try the next candidate path.
    }
  }

  try {
    if (openapiJsonCache?.filePath === GENERATED_OPENAPI_CACHE_KEY) {
      return openapiJsonCache.content;
    }

    const content = generateOpenapiJson();
    openapiJsonCache = { filePath: GENERATED_OPENAPI_CACHE_KEY, mtimeMs: 0, content };
    return content;
  } catch (error) {
    logger.error(`[openapi] 无法提供 OpenAPI 文档：${(error as Error).message}`);
    throw formatOpenapiNotFoundError(candidates, [...skipReasons, (error as Error).message].join("; "));
  }
}
