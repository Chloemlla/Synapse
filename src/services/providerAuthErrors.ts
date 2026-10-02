/**
 * 第三方登录/绑定流程里「账户已被封停」的统一信号。
 *
 * 为什么需要它：封停账户的拒绝在密码登录（`controllers/auth/loginHandlers.ts`）、
 * Passkey（`passkeyHandlers.ts`）、会话（`sessionHandlers.ts`）与鉴权中间件
 * （`middleware/auth.ts`、`middleware/authenticateToken.ts`）里统一是
 * `403 { error, code: "ACCOUNT_SUSPENDED", supportEmail }`，前端
 * `frontend/src/utils/penaltyAppeal.ts` 的 `classifyPenaltyAppeal` 据此弹出申诉入口。
 *
 * 但第三方（Google）登录与绑定流程此前只是 `throw new Error("账户已被封停")`：
 *   - 控制器一律按 400 返回、且不带 `code`，前端认不出这是封停，用户只看到一句通用错误、
 *     拿不到申诉通道；
 *   - 服务端把它当未预期异常打 `logger.error` + 完整堆栈，把线上日志刷成噪音。
 *
 * 这个模块让服务层与控制器共享同一份判据（类型优先、文案兜底），
 * 不再依赖各控制器各自 `message.includes("已封停")` 的散装判断。
 */

export const ACCOUNT_SUSPENDED_CODE = "ACCOUNT_SUSPENDED";
export const ACCOUNT_SUSPENDED_MESSAGE = "账户已被封停";
/** 与 loginHandlers / sessionHandlers / authenticateToken 等处保持同一个申诉邮箱。 */
export const ACCOUNT_SUSPENSION_SUPPORT_EMAIL = "support@chloemlla.com";

export class AccountSuspendedError extends Error {
  readonly code = ACCOUNT_SUSPENDED_CODE;
  readonly statusCode = 403;

  constructor(message: string = ACCOUNT_SUSPENDED_MESSAGE) {
    super(message);
    this.name = "AccountSuspendedError";
  }
}

/**
 * 兼容三种来源：本类的实例、历史遗留的裸 `Error`（文案为「账户已被封停」系列）、
 * 测试里被 mock 掉服务模块后抛出的普通 Error（拿不到类身份，只能按文案认）。
 */
export function isAccountSuspendedFailure(error: unknown): boolean {
  if (error instanceof AccountSuspendedError) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (
    message.includes(ACCOUNT_SUSPENDED_MESSAGE) ||
    message.includes("账户已暂停") ||
    message.includes("账户已被暂停")
  );
}

export interface AccountSuspendedBody {
  error: string;
  code: typeof ACCOUNT_SUSPENDED_CODE;
  supportEmail: string;
}

/**
 * 全仓统一的封停响应体（与 loginHandlers / sessionHandlers / authenticateToken 一致）；
 * 调用方只负责配 403、并把日志从 error 降到 warn。
 */
export function buildAccountSuspendedBody(message?: string): AccountSuspendedBody {
  return {
    error: (message || "").trim() || ACCOUNT_SUSPENDED_MESSAGE,
    code: ACCOUNT_SUSPENDED_CODE,
    supportEmail: ACCOUNT_SUSPENSION_SUPPORT_EMAIL,
  };
}
