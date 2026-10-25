import type { Request, Response } from "express";
import logger from "../utils/logger";
import { normalizeCdictLanguageResponse } from "../services/cdictLanguageResponse";
import { toBrowserCdictAudio } from "./cdictWebAudio";
import {
  CDictMicrosoftSpeechError,
  normalizeMicrosoftSpeechLocale,
  synthesizeMicrosoftSpeech,
} from "../services/cdictMicrosoftSpeechService";
import {
  type CDictAudio,
  fetchDictionaryVoice,
  fetchLanguageList,
  synthesizeSpeech,
  translateText,
} from "../services/cdictUpstreamService";

/**
 * CDict Android 客户端专用代理控制器。
 *
 * 客户端只允许请求本服务，因此这里保持上游的响应结构（retcode / code / data）不变，
 * 失败时必须返回非零 code —— 客户端把 code === 0 视为成功，缺失会被误判为空译文。
 */

const MAX_TRANSLATE_CHARS = 5000;
const MAX_SPEECH_CHARS = 300;
const LANGUAGE_CODE = /^(auto|[A-Za-z]{2,3}(-[A-Za-z]{2,4})?)$/;

const SOURCE_ENGINE = "engine";
const SOURCE_DICTIONARY = "youdao";

function firstString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item : "")).join("\n");
  return "";
}

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ success: false, code: status, error: message, message });
}

export class CDictController {
  /** POST /api/cdict/translate —— 表单或 JSON 均可：text / from / to。 */
  public static async translate(req: Request, res: Response): Promise<void> {
    const text = firstString(req.body?.text);
    const from = firstString(req.body?.from).trim() || "auto";
    const to = firstString(req.body?.to).trim();
    if (!text.trim()) {
      fail(res, 400, "缺少待翻译文本");
      return;
    }
    if (text.length > MAX_TRANSLATE_CHARS) {
      fail(res, 413, `文本超过 ${MAX_TRANSLATE_CHARS} 字上限`);
      return;
    }
    if (!LANGUAGE_CODE.test(from) || !LANGUAGE_CODE.test(to)) {
      fail(res, 400, "语言代码不合法");
      return;
    }
    try {
      const upstream = await translateText({ text, from, to });
      res.json({ success: true, ...upstream });
    } catch (error) {
      const message = error instanceof Error ? error.message : "翻译失败";
      logger.warn("[CDict] 翻译请求失败", { from, to, message });
      fail(res, 502, "上游服务暂时不可用");
    }
  }

  /** GET /api/cdict/languages —— 透传上游支持的语言集合。 */
  public static async languages(_req: Request, res: Response): Promise<void> {
    try {
      const upstream = await fetchLanguageList();
      res.json(normalizeCdictLanguageResponse(upstream));
    } catch (error) {
      const message = error instanceof Error ? error.message : "语言列表获取失败";
      logger.warn("[CDict] 语言列表获取失败", { message });
      fail(res, 502, "上游服务暂时不可用");
    }
  }

  /** GET /api/cdict/tts —— source=engine 走在线合成，source=youdao 走词典静态音频；成功回音频字节。 */
  public static async tts(req: Request, res: Response): Promise<void> {
    return CDictController.speech(req, res, false);
  }

  /** Website-only conversion; Android retains original audio bytes and caching. */
  public static async ttsForWeb(req: Request, res: Response): Promise<void> {
    return CDictController.speech(req, res, true);
  }

  private static async speech(req: Request, res: Response, forWeb: boolean): Promise<void> {
    const text = firstString(req.query?.text).trim();
    const source = (firstString(req.query?.source).trim() || SOURCE_ENGINE).toLowerCase();
    if (!text) {
      fail(res, 400, "缺少待合成文本");
      return;
    }
    if (text.length > MAX_SPEECH_CHARS) {
      fail(res, 413, `文本超过 ${MAX_SPEECH_CHARS} 字上限`);
      return;
    }
    if (source !== SOURCE_ENGINE && source !== SOURCE_DICTIONARY && !(forWeb && source === "microsoft")) {
      fail(res, 400, forWeb ? "source 只支持 engine、youdao 或 microsoft" : "source 只支持 engine 或 youdao");
      return;
    }
    if (source === "microsoft") {
      const langType = firstString(req.query?.langType).trim() || "en-USA";
      if (!normalizeMicrosoftSpeechLocale(langType)) {
        fail(res, 400, "langType 不合法或不能用于朗读");
        return;
      }
      return CDictController.microsoftSpeech(req, res, text, langType);
    }
    try {
      let audio: CDictAudio;
      if (source === SOURCE_DICTIONARY) {
        const rawType = firstString(req.query?.type) || "2";
        if (forWeb && !/^[12]$/.test(rawType)) {
          fail(res, 400, "type 只支持 1（英式）或 2（美式）");
          return;
        }
        const type = Number.parseInt(rawType, 10);
        if (type !== 1 && type !== 2) {
          fail(res, 400, "type 只支持 1（英式）或 2（美式）");
          return;
        }
        audio = await fetchDictionaryVoice(text, type);
      } else {
        const langType = firstString(req.query?.langType).trim() || "en-USA";
        if (!LANGUAGE_CODE.test(langType)) {
          fail(res, 400, "langType 不合法");
          return;
        }
        audio = await synthesizeSpeech(text, langType);
      }
      if (forWeb) audio = toBrowserCdictAudio(audio);
      res.setHeader("Content-Type", audio.contentType);
      res.setHeader("Cache-Control", forWeb ? "private, no-store" : "public, max-age=86400");
      res.status(200).send(audio.data);
    } catch {
      logger.warn("[CDict] 语音请求失败", { source, category: "upstream_failed" });
      fail(res, 502, "上游服务暂时不可用");
    }
  }

  private static async microsoftSpeech(
    req: Request, res: Response, text: string, langType: string,
  ): Promise<void> {
    const controller = new AbortController();
    const onAborted = () => controller.abort();
    // Normal response completion also emits close; only disconnects cancel synthesis.
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    req.once("aborted", onAborted);
    res.once("close", onClose);
    if (req.aborted || res.destroyed) controller.abort();
    try {
      const audio = await synthesizeMicrosoftSpeech(text, langType, controller.signal);
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "private, no-store");
      res.status(200).send(audio.data);
    } catch (error) {
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
      const category = error instanceof CDictMicrosoftSpeechError ? error.category : "upstream_failed";
      logger.warn("[CDict] 微软短朗读请求失败", { category });
      fail(res, 502, "语音服务暂时不可用");
    } finally {
      req.removeListener("aborted", onAborted);
      res.removeListener("close", onClose);
    }
  }
}
