import crypto from "node:crypto";
import { config } from "../config/config";

const MAX_PASSWORD_BYTES = 1024;

function timingSafeStringEqual(candidate: string, expected: string): boolean {
  const candidateLength = Buffer.byteLength(candidate, "utf8");
  const expectedLength = Buffer.byteLength(expected, "utf8");

  if (candidateLength > MAX_PASSWORD_BYTES) {
    return false;
  }

  const compareLength = Math.max(candidateLength, expectedLength);
  const candidateBuffer = Buffer.alloc(compareLength);
  const expectedBuffer = Buffer.alloc(compareLength);

  Buffer.from(candidate, "utf8").copy(candidateBuffer);
  Buffer.from(expected, "utf8").copy(expectedBuffer);

  return crypto.timingSafeEqual(candidateBuffer, expectedBuffer) && candidateLength === expectedLength;
}

export function isAdminOperationPasswordValid(candidate: unknown): boolean {
  if (typeof candidate !== "string" || !candidate) {
    return false;
  }

  if (config.adminOperationPassword && timingSafeStringEqual(candidate, config.adminOperationPassword)) {
    return true;
  }

  // SYN-01: 移除 `NODE_ENV==="test"` 万能口令后门（同 commandService G7-39）。此前该分支在
  // TEST_ADMIN_PASSWORD 未设时接受硬编码 "admin"，一旦生产被误配 NODE_ENV=test 即形成万能口令。
  // 测试改为通过 config.adminOperationPassword（由 setup.ts 的 ADMIN_PASSWORD / TEST_ADMIN_PASSWORD 提供）
  // 走上面这条真校验分支，不再需要单独的 test 兜底。
  return false;
}
