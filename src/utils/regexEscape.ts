/**
 * 把用户输入转义成「字面量」再喂给 `$regex` / `new RegExp`。
 *
 * 为什么要有这个文件：仓库里散着 6 份各自为政的私有转义函数，于是同一类查询有的地方转了、
 * 有的地方没转（邮件溯源、B 站数据、B 站搜索记录四处直接 `{ $regex: 用户输入 }`）。
 * 未转义的后果有两层：
 *  - `.` `*` `+` 这类元字符会把「精确搜索」变成「任意匹配」，运营看到的结果与关键词不符；
 *  - 病态模式（如 `(a+)+$`）在长字段上触发灾难性回溯，把 mongod 的 CPU 打满 —— 一条只需
 *    登录管理员账号就能放的放大攻击。
 *
 * 这里刻意用 `replace` + 字符类（而不是 `RegExp(string)`）实现，避免二次转义歧义。
 */
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

export function escapeRegexLiteral(value: string): string {
  return value.replace(REGEX_METACHARACTERS, "\\$&");
}

/** 值可能缺失/不是字符串（query 参数形态不定）时的便捷入口。 */
export function escapeRegexLiteralOrEmpty(value: unknown): string {
  return typeof value === "string" ? escapeRegexLiteral(value) : "";
}
