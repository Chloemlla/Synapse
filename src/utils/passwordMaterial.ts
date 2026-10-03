/**
 * 「这个账号有没有密码材料」的单一判据。
 *
 * 为什么单独一个文件：这个判断散在至少两处（账号安全总览的自检清单、logShare 的管理员
 * 口令回退路径），而它同时规定了**要从库里取哪些字段**。两边任何一侧漏字段，结果都不是
 * 报错而是「静默判否」—— 用户会看到「当前账号没有设置密码」这种明显错误的告警
 * （安全总览此前正是如此：`getUserById` 的公开投影不含密码字段，于是有密码的用户也被
 * 判成没密码）。所以字段清单与判据必须同源。
 */
export const PASSWORD_MATERIAL_FIELDS = [
  "password",
  "passwordHash",
  "passwordCiphertext",
  "passwordIv",
  "passwordTag",
  "passwordWrappedDek",
] as const;

export type PasswordMaterialHolder = Partial<
  Record<(typeof PASSWORD_MATERIAL_FIELDS)[number], unknown>
>;

export function hasPasswordMaterial(user: PasswordMaterialHolder | null | undefined): boolean {
  if (!user) return false;
  return PASSWORD_MATERIAL_FIELDS.some((field) => Boolean(user[field]));
}
