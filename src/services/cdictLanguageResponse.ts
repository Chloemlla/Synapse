/** Supported gateway / SDK envelopes without discarding original metadata. */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i;
const LANGUAGE_PAIR = /^([a-z]{2,3}(?:-[a-z]{2,4})?)2([a-z]{2,3}(?:-[a-z]{2,4})?)$/i;

function entry(value: unknown): string | undefined {
  const node = record(value);
  return [typeof value === "string" ? value : undefined, node.code, node.lang, node.langCode, node.name]
    .find((candidate): candidate is string => typeof candidate === "string" &&
      (LANGUAGE_CODE.test(candidate.trim()) || LANGUAGE_PAIR.test(candidate.trim())));
}

function plainLanguageList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((item) => {
    const code = entry(item);
    return code !== undefined && LANGUAGE_CODE.test(code.trim()) && code.trim().toLowerCase() !== "auto";
  });
}

export function collectCdictLanguageCodes(value: unknown): string[] {
  const root = record(value);
  const data = record(root.data);
  const lists = [value, root.data, data.langs, data.list, data.languages, root.list, root.languages, root.langs];
  const codes = new Map<string, string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const code = entry(item);
      if (!code) continue;
      // TranslateContract also uses xx2yy direction entries; expose their language union.
      for (const part of code.trim().split("2")) {
        if (part.toLowerCase() === "auto") continue;
        const canonical = part.toLowerCase() === "zh" ? "zh-CHS" : part;
        if (!codes.has(canonical.toLowerCase())) codes.set(canonical.toLowerCase(), canonical);
      }
    }
  }
  return [...codes.values()];
}

export function normalizeCdictLanguageResponse(value: unknown): unknown[] | Record<string, unknown> {
  const root = record(value);
  for (const key of ["code", "retcode"] as const) {
    const code = root[key];
    if (code !== undefined && ((typeof code !== "string" && typeof code !== "number") || Number(code) !== 0)) {
      const diagnostic = Number.isFinite(Number(code)) ? String(Number(code)) : "invalid";
      throw new Error(`上游语言列表业务失败 ${key}=${diagnostic}`);
    }
  }
  if (root.success === false || root.error) throw new Error("上游语言列表返回失败结果");
  const codes = collectCdictLanguageCodes(value);
  if (!codes.length) throw new Error("上游语言列表为空或结构未知");
  if (Array.isArray(value)) return plainLanguageList(value) ? value : codes;
  // Older clients know top-level languages, but not the SDK data.langs array.
  return {
    ...root,
    success: true,
    languages: plainLanguageList(root.languages) ? root.languages : codes,
  };
}
