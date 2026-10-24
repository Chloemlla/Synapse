import { collectCdictLanguageCodes, normalizeCdictLanguageResponse } from "../services/cdictLanguageResponse";

it("recognizes SDK data.langs and preserves gateway metadata while adding a legacy client alias", () => {
  const payload = { code: 0, retcode: 0, data: { langs: ["en", "zh-CHS"], expire: "86400" }, serviceRegion: "asia" };
  const result = normalizeCdictLanguageResponse(payload);
  expect(result).toEqual({ ...payload, success: true, languages: ["en", "zh-CHS"] });
  expect((result as Record<string, unknown>).data).toBe(payload.data);
  expect(payload).not.toHaveProperty("languages");
});

it("preserves successful legacy array and structured top-level language shapes", () => {
  const array = [{ langCode: "en", name: "English" }];
  expect(normalizeCdictLanguageResponse(array)).toBe(array);
  const languages = [{ code: "fr", name: "法语" }];
  expect(normalizeCdictLanguageResponse({ languages })).toEqual({ success: true, languages });
});

it.each([
  { code: 20000, data: null, msg: "参数非法", requestId: null, serviceRegion: "asia", success: true },
  { retcode: 10000, code: 0, data: { langs: ["en"] } },
  { code: "71001", data: { langs: ["en"] } },
  { code: 0, success: false, data: { langs: ["en"] } },
  { code: 0, error: "failure", data: { langs: ["en"] } },
  { code: null, data: { langs: ["en"] } },
  { code: "not-a-code", data: { langs: ["en"] } },
])("rejects gateway failure envelopes rather than declaring success (%j)", (payload) => {
  expect(() => normalizeCdictLanguageResponse(payload)).toThrow();
});

it.each([[], {}, { code: 0, data: null }, { code: 0, data: { langs: [] } }, { data: { en: "English" } }].map((payload) => ({ payload })))
  ("rejects empty or unknown language shapes (%j)", ({ payload }) => {
    expect(() => normalizeCdictLanguageResponse(payload)).toThrow("为空或结构未知");
  });

it("accepts every known envelope and removes invalid entries from the compatibility alias", () => {
  for (const payload of [
    { data: ["en"] }, { data: { list: ["en"] } }, { data: { languages: ["en"] } },
    { list: ["en"] }, { languages: ["en"] }, { langs: ["en"] },
  ]) expect(collectCdictLanguageCodes(payload)).toEqual(["en"]);
  expect(collectCdictLanguageCodes({ data: { langs: ["en", "EN", "auto", "https://secret.example", { code: "zh-CHS" }] } }))
    .toEqual(["en", "zh-CHS"]);
});

it("converts documented translation-direction entries into usable language codes", () => {
  const payload = { code: 0, data: { langs: ["en2zh", "zh-CHS2ja", "auto2en"] } };
  expect(normalizeCdictLanguageResponse(payload)).toEqual({ ...payload, success: true, languages: ["en", "zh-CHS", "ja"] });
  expect(normalizeCdictLanguageResponse(["en2zh"])).toEqual(["en", "zh-CHS"]);
});
