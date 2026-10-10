/**
 * 软删除的**纯判据**（RC-01 / RC-21）。
 *
 * 为什么单独一个叶子模块：鉴权中间件（`middleware/authenticateToken.ts`、
 * `middleware/auth.ts`、`services/wsAuthentication.ts`）都必须判断「这个账号是不是已软删除」。
 * 如果直接从 `services/userService` 取，就会把 `mongoService` 及其依赖图拉进中间件 ——
 * 而大量测试**只 mock `utils/userStorage`、不 mock `userService`**，
 * 一旦真实 userService 被拉进来，测试会连上真实 Mongo 模块（历史上这类“替身缺件”
 * 已被记为 G2 系列缺陷）。因此判据必须放在**零依赖**的位置。
 *
 * 字段名的唯一真相源也在这里：用户主档用 `deletedAt`，从属集合用 `subjectDeletedAt`
 * （见 `services/softDeleteService.ts` 的字段约定说明）。
 */

/** 用户主档（`user_datas`）的软删除时间戳字段：0 / 缺省 = 未删除；> 0 = 删除时刻（ms）。 */
export const USER_DELETED_FIELD = "deletedAt";

/** 从属集合的统一软删除时间戳字段。 */
export const SUBJECT_DELETED_FIELD = "subjectDeletedAt";

/**
 * 「未软删除」判据。
 *
 * 用 `$in: [0, null]` 而不是 `0`：Mongo 的 `{ field: 0 }` **不匹配缺失字段**，
 * 而线上存量文档全都没有这个字段。写成 `$in: [0, null]` 才能同时覆盖
 * 「新文档写了 0」与「存量文档没这个键」，否则上线当天全部历史用户会被判为已删除。
 */
export function activeRecordFilter(field: string = SUBJECT_DELETED_FIELD): Record<string, unknown> {
  return { [field]: { $in: [0, null] } };
}

/** 用户主档的「未删除」判据，等价于 activeRecordFilter(USER_DELETED_FIELD)。 */
export function activeUserFilter(): Record<string, unknown> {
  return activeRecordFilter(USER_DELETED_FIELD);
}

/** 「已软删除」判据。 */
export function deletedRecordFilter(field: string = SUBJECT_DELETED_FIELD): Record<string, unknown> {
  return { [field]: { $gt: 0 } };
}

/** 该时间戳是否表示「已软删除」。 */
export function isDeletedTimestamp(value: unknown): boolean {
  return typeof value === "number" && value > 0;
}

/** 记录是否处于软删除态。兼容 mongoose 文档与 lean 出来的普通对象。 */
export function isSoftDeleted(record: unknown, field: string = SUBJECT_DELETED_FIELD): boolean {
  if (!record || typeof record !== "object") return false;
  return isDeletedTimestamp((record as Record<string, unknown>)[field]);
}
