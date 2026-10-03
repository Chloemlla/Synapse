import crypto from "node:crypto";

/**
 * 常量时间字符串比较。
 *
 * 为什么单独一个文件：仓库里此前散着 3 份同实现（`utils/adminOperationPassword.ts`、
 * `services/operationalStatusService.ts`、`routes/shortUrlRoutes.ts`），它们各自维护
 * 「先补零再 timingSafeEqual + 比对长度」这套细节。这类实现一旦在某一处被改坏
 * （例如漏掉长度比较），只有那一处会退化成可被计时侧信道枚举，很难被发现。
 *
 * 两个细节不能省：
 *  - 长度不同也要做等长比较再以长度判定结果（否则提前 return 会泄露长度）；
 *  - 超过上限直接判否，避免用超长输入放大比较成本（这也是本仓对 1024 字节的既有约定）。
 */
const MAX_COMPARE_BYTES = 1024;

export function timingSafeStringEqual(candidate: string, expected: string): boolean {
  const candidateLength = Buffer.byteLength(candidate, "utf8");
  const expectedLength = Buffer.byteLength(expected, "utf8");

  if (candidateLength > MAX_COMPARE_BYTES || expectedLength > MAX_COMPARE_BYTES) {
    return false;
  }

  const compareLength = Math.max(candidateLength, expectedLength, 1);
  const candidateBuffer = Buffer.alloc(compareLength);
  const expectedBuffer = Buffer.alloc(compareLength);

  Buffer.from(candidate, "utf8").copy(candidateBuffer);
  Buffer.from(expected, "utf8").copy(expectedBuffer);

  return crypto.timingSafeEqual(candidateBuffer, expectedBuffer) && candidateLength === expectedLength;
}
