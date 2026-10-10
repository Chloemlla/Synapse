// doc-tool 用户偏好持久化：一个用户一行（doc_tool_prefs），下次打开页面直接展示上次用的选项。
//
// 与 mediaTool/settingsStore.ts 的区别：那份是「全局单文档 + 密钥脱敏」，这份是「每用户一行 + 纯校验」，
// 所以没有 env 层、没有 merge 层，只有一个白名单化的 applyPrefs。
import { DocToolPrefsModel } from "../models/docToolModels";
import { sanitizeRelPath } from "./runtime";
import { DEFAULT_DOC_PREFS, normalizeConflict, normalizeOutMode, type DocPrefs } from "./types";

export interface DocSettingsStore {
  get(userId: string): Promise<DocPrefs>;
  update(userId: string, patch: Partial<DocPrefs>): Promise<DocPrefs>;
}

/**
 * 路径字段一律走 sanitizeRelPath：它会剔掉盘符、UNC、控制字符与任何 ".." 段（返回 null），
 * 结果永远是用户目录内的相对路径。非法值回落默认而不是抛错：偏好只是「下次打开展示为已填」，
 * 坏值不该让整个设置接口 400，更不该把一个越界路径留在库里等转换阶段才炸。
 */
const cleanOutDir = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return DEFAULT_DOC_PREFS.outDir;
  return sanitizeRelPath(value) ?? DEFAULT_DOC_PREFS.outDir;
};

const cleanReferenceDoc = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return DEFAULT_DOC_PREFS.referenceDoc;
  // 空串是合法值（= 不用参考样式）；只有「非空但非法」才回落默认
  if (value.trim() === "") return DEFAULT_DOC_PREFS.referenceDoc;
  return sanitizeRelPath(value) ?? DEFAULT_DOC_PREFS.referenceDoc;
};

/**
 * 白名单化：只认识 DocPrefs 的五个键，其余键（前端回传整个对象时多带的、或手工改库塞进去的）直接丢。
 * base 提供「本次没传的键」的取值 —— get 时是 DEFAULT_DOC_PREFS（老存档缺字段不炸），update 时是当前值。
 */
function applyPrefs(base: DocPrefs, raw: unknown): DocPrefs {
  const src = (raw ?? {}) as Partial<DocPrefs>;
  const outDir = cleanOutDir(src.outDir);
  const referenceDoc = cleanReferenceDoc(src.referenceDoc);
  return {
    conflict: src.conflict === undefined ? base.conflict : normalizeConflict(src.conflict),
    outMode: src.outMode === undefined ? base.outMode : normalizeOutMode(src.outMode),
    outDir: outDir ?? base.outDir,
    recursive: typeof src.recursive === "boolean" ? src.recursive : base.recursive,
    referenceDoc: referenceDoc ?? base.referenceDoc,
  };
}

export function createMongoDocSettingsStore(): DocSettingsStore {
  /** 读 + 校验，返回的永远是「可以直接发给前端」的完整偏好。 */
  const readPrefs = async (userId: string): Promise<DocPrefs> => {
    const doc = await DocToolPrefsModel.findOne({ userId }).lean().exec();
    return applyPrefs(DEFAULT_DOC_PREFS, doc?.prefs);
  };

  return {
    get: readPrefs,
    async update(userId: string, patch: Partial<DocPrefs>): Promise<DocPrefs> {
      const current = await readPrefs(userId);
      const next = applyPrefs(current, patch);
      await DocToolPrefsModel.updateOne(
        { userId },
        { $set: { userId, prefs: next, updatedAt: new Date() } },
        { upsert: true },
      ).exec();
      return next;
    },
  };
}
