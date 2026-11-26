/**
 * X1 多模态内容件 + X2-01 线格式 JSON 模式(纯函数层)。
 *
 * 这里钉住的三件事,每一件都是「做错不会被发现、只会在生产里出问题」的类型:
 *  1. 纯文本请求体的**形状**不得因为引入了件而发生变化(G-04)——所以断言用 toEqual 打整段 body,
 *     而不是只抽查某个键;
 *  2. 图片只允许内联 data URL(X1-02)。外链会被上游自己去取,等于把 SSRF 面交给调用方,
 *     因此拒绝必须带稳定原因码,而且 `EXTERNAL_IMAGE_NOT_ALLOWED` 要抢在 `NOT_A_DATA_URL` 前面;
 *  3. 校验层(服务层据此给用户「哪一张不行」)与构造层(对非法件静默跳过)是**两套语义**,
 *     必须分别钉住,否则以后有人把跳过改成抛错,纯文本通路会被图片拖垮。
 */

import {
  buildWireRequest,
  contentPartsToPlainText,
  countContentImages,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGES_PER_REQUEST,
  parseInlineImageDataUrl,
  toContentParts,
  validateContentParts,
  wireMessageContent,
  type ChatContentPart,
  type ChatWireFormat,
  type WireChatContent,
} from "../services/librechat/wire";

/** 最小的合法载荷:纯 base64 段还原后仍是它自己,便于逐字节比对三种协议的图片件形状。 */
const PNG_URL = "data:image/png;base64,AAAA";

/**
 * base64 → 解码字节的反推(与 wire.ts 的 `floor(len*3/4)` 互为逆运算)。
 * 用公式而不是魔数:上限一旦调整,用例跟着常量走,不会变成假绿。
 */
const base64LenForBytes = (bytes: number): number => Math.ceil((bytes * 4) / 3);

interface BuildInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  wire: ChatWireFormat;
  system: string;
  messages: { role: "user" | "assistant"; content: WireChatContent }[];
  temperature: number;
  stream: boolean;
  maxTokens: number;
  responseFormat?: "json";
}

function requestFor(wire: ChatWireFormat, content: WireChatContent, responseFormat?: "json") {
  const input: BuildInput = {
    baseUrl: "https://api.example.com",
    apiKey: "sk-test",
    model: "m1",
    wire,
    system: "SYS",
    messages: [{ role: "user", content }],
    temperature: 0.7,
    stream: false,
    maxTokens: 2048,
    responseFormat,
  };
  return buildWireRequest(input);
}

/** 取 openai-chat / anthropic 请求体里的 messages 数组。 */
function bodyMessages(body: Record<string, unknown>): Record<string, unknown>[] {
  return body.messages as Record<string, unknown>[];
}

/** 取 openai-responses 请求体里的 input 数组。 */
function bodyInput(body: Record<string, unknown>): Record<string, unknown>[] {
  return body.input as Record<string, unknown>[];
}

function textParts(): ChatContentPart[] {
  return [{ type: "text", text: "只有文字" }];
}

describe("parseInlineImageDataUrl · 原因码与优先级(X1-02/X1-03)", () => {
  it("合法 data URL 通过,并回报近似字节数", () => {
    const result = parseInlineImageDataUrl(PNG_URL);
    if (!result.ok) throw new Error(`期望通过,实际 ${result.code}`);
    expect(result.image.mediaType).toBe("image/png");
    expect(result.image.data).toBe("AAAA");
    // 体积判定用的是 floor(len*3/4) 估算,不复制缓冲区;这个数值直接决定上限判定,必须钉住。
    expect(result.image.bytes).toBe(3);
  });

  it("四种受支持的 mime 各自通过", () => {
    for (const mime of ["image/png", "image/jpeg", "image/webp", "image/gif"]) {
      const result = parseInlineImageDataUrl(`data:${mime};base64,AAAA`);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.image.mediaType).toBe(mime);
    }
  });

  it("前后空白与大小写不敏感(mime 归一为小写)", () => {
    const result = parseInlineImageDataUrl(`  DATA:IMAGE/PNG;BASE64,AAAA  `);
    if (!result.ok) throw new Error(`期望通过,实际 ${result.code}`);
    expect(result.image.mediaType).toBe("image/png");
    expect(result.image.data).toBe("AAAA");
  });

  it("载荷里的换行/空白被剥掉(data URL 折行是常见形态)", () => {
    const result = parseInlineImageDataUrl("data:image/png;base64,AA\nAA  ");
    if (!result.ok) throw new Error(`期望通过,实际 ${result.code}`);
    expect(result.image.data).toBe("AAAA");
  });

  it("除 base64 外还带别的参数时仍然通过", () => {
    const result = parseInlineImageDataUrl("data:image/png;charset=utf-8;base64,AAAA");
    expect(result.ok).toBe(true);
  });

  it("http/https 与协议相对地址被拒,且不是含糊的「不是 data URL」(X1-02)", () => {
    // 这条顺序判定是安全边界:如果外链只得到 NOT_A_DATA_URL,调用方无从知道自己踩了 SSRF 规则。
    expect(parseInlineImageDataUrl("https://evil.example.com/x.png")).toEqual({
      ok: false,
      code: "EXTERNAL_IMAGE_NOT_ALLOWED",
    });
    expect(parseInlineImageDataUrl("http://evil.example.com/x.png")).toEqual({
      ok: false,
      code: "EXTERNAL_IMAGE_NOT_ALLOWED",
    });
    expect(parseInlineImageDataUrl("//cdn.example.com/x.png")).toEqual({
      ok: false,
      code: "EXTERNAL_IMAGE_NOT_ALLOWED",
    });
    // 大写协议同样要拦住,否则等于留了个绕过口子。
    expect(parseInlineImageDataUrl("HTTPS://cdn.example.com/x.png")).toEqual({
      ok: false,
      code: "EXTERNAL_IMAGE_NOT_ALLOWED",
    });
  });

  it("非 data: 前缀 / 非字符串 / 空白 → NOT_A_DATA_URL", () => {
    expect(parseInlineImageDataUrl("not-a-url")).toEqual({ ok: false, code: "NOT_A_DATA_URL" });
    expect(parseInlineImageDataUrl("")).toEqual({ ok: false, code: "NOT_A_DATA_URL" });
    expect(parseInlineImageDataUrl("   ")).toEqual({ ok: false, code: "NOT_A_DATA_URL" });
    expect(parseInlineImageDataUrl(undefined)).toEqual({ ok: false, code: "NOT_A_DATA_URL" });
    expect(parseInlineImageDataUrl(42)).toEqual({ ok: false, code: "NOT_A_DATA_URL" });
    expect(parseInlineImageDataUrl({ dataUrl: PNG_URL })).toEqual({ ok: false, code: "NOT_A_DATA_URL" });
  });

  it("缺 ;base64 → NOT_BASE64,且该判定排在 mime 判定之前", () => {
    expect(parseInlineImageDataUrl("data:image/png,AAAA")).toEqual({ ok: false, code: "NOT_BASE64" });
    // image/tiff 既不支持又缺 base64:得到 NOT_BASE64 说明判定顺序没被调换。
    expect(parseInlineImageDataUrl("data:image/tiff,AAAA")).toEqual({ ok: false, code: "NOT_BASE64" });
    expect(parseInlineImageDataUrl("data:image/png;charset=utf-8,AAAA")).toEqual({ ok: false, code: "NOT_BASE64" });
  });

  it("不在白名单里的 mime → UNSUPPORTED_IMAGE_TYPE", () => {
    expect(parseInlineImageDataUrl("data:text/plain;base64,AAAA")).toEqual({
      ok: false,
      code: "UNSUPPORTED_IMAGE_TYPE",
    });
    // svg 能带脚本/外链,尤其不能被当成图片放进来。
    expect(parseInlineImageDataUrl("data:image/svg+xml;base64,AAAA")).toEqual({
      ok: false,
      code: "UNSUPPORTED_IMAGE_TYPE",
    });
    expect(parseInlineImageDataUrl("data:application/pdf;base64,AAAA")).toEqual({
      ok: false,
      code: "UNSUPPORTED_IMAGE_TYPE",
    });
  });

  it("空载荷 → EMPTY_IMAGE", () => {
    expect(parseInlineImageDataUrl("data:image/png;base64,")).toEqual({ ok: false, code: "EMPTY_IMAGE" });
    // 载荷只有空白时,剥完空白同样为空,不给下游一个零字节的「合法图」。
    expect(parseInlineImageDataUrl("data:image/png;base64,   \n  ")).toEqual({ ok: false, code: "EMPTY_IMAGE" });
  });

  it("体积上限:恰好 4MB 通过,再多一字节被拒(X1-03 边界)", () => {
    const atLimit = parseInlineImageDataUrl(`data:image/png;base64,${"A".repeat(base64LenForBytes(MAX_INLINE_IMAGE_BYTES))}`);
    if (!atLimit.ok) throw new Error(`边界值应通过,实际 ${atLimit.code}`);
    expect(atLimit.image.bytes).toBe(MAX_INLINE_IMAGE_BYTES);

    const overLimit = parseInlineImageDataUrl(`data:image/png;base64,${"A".repeat(base64LenForBytes(MAX_INLINE_IMAGE_BYTES + 1))}`);
    expect(overLimit).toEqual({ ok: false, code: "IMAGE_TOO_LARGE" });
  });
});

describe("validateContentParts · 件级校验(X1-03/X1-04)", () => {
  it("字符串正文不是件 → 不产生任何 issue", () => {
    expect(validateContentParts("纯文本")).toEqual([]);
    expect(validateContentParts(null)).toEqual([]);
    expect(validateContentParts(undefined)).toEqual([]);
  });

  it("全合法的内容件 → 空 issue 数组", () => {
    expect(validateContentParts([{ type: "text", text: "看图" }, { type: "image", dataUrl: PNG_URL }])).toEqual([]);
  });

  it("逐件回报问题下标,而不是首个就返回", () => {
    const parts: ChatContentPart[] = [
      { type: "image", dataUrl: "https://evil.example.com/a.png" },
      { type: "text", text: "说明" },
      { type: "image", dataUrl: "data:image/png,AAAA" },
      { type: "image", dataUrl: "data:image/tiff;base64,AAAA" },
    ];
    expect(validateContentParts(parts)).toEqual([
      { code: "EXTERNAL_IMAGE_NOT_ALLOWED", index: 0 },
      { code: "NOT_BASE64", index: 2 },
      { code: "UNSUPPORTED_IMAGE_TYPE", index: 3 },
    ]);
  });

  it("超过张数上限 → 一条 index=-1 的 TOO_MANY_IMAGES(不属于单个件)", () => {
    const allowed: ChatContentPart[] = Array.from({ length: MAX_INLINE_IMAGES_PER_REQUEST }, () => ({
      type: "image" as const,
      dataUrl: PNG_URL,
    }));
    // 边界:刚好 4 张可用。
    expect(validateContentParts(allowed)).toEqual([]);
    const oneTooMany: ChatContentPart[] = [...allowed, { type: "image", dataUrl: PNG_URL }];
    expect(validateContentParts(oneTooMany)).toEqual([{ code: "TOO_MANY_IMAGES", index: -1 }]);
  });

  it("张数超限与单件问题并存时两者都要报出来", () => {
    const five: ChatContentPart[] = Array.from({ length: MAX_INLINE_IMAGES_PER_REQUEST + 1 }, (_unused, index) => ({
      type: "image" as const,
      dataUrl: index === MAX_INLINE_IMAGES_PER_REQUEST ? "data:image/png;base64," : PNG_URL,
    }));
    const found = validateContentParts(five);
    expect(found).toContainEqual({ code: "EMPTY_IMAGE", index: MAX_INLINE_IMAGES_PER_REQUEST });
    expect(found).toContainEqual({ code: "TOO_MANY_IMAGES", index: -1 });
    expect(found.length).toBe(2);
  });
});

describe("件计数与纯文本回写(X1-08)", () => {
  it("toContentParts 只对数组返回件,字符串返回 null", () => {
    expect(toContentParts(textParts())).toEqual(textParts());
    expect(toContentParts("纯文本")).toBeNull();
    expect(toContentParts(null)).toBeNull();
  });

  it("countContentImages 只数图片件", () => {
    expect(countContentImages("纯文本")).toBe(0);
    expect(countContentImages(textParts())).toBe(0);
    expect(countContentImages([{ type: "text", text: "a" }, { type: "image", dataUrl: PNG_URL }, { type: "image", dataUrl: PNG_URL }])).toBe(2);
  });

  it("contentPartsToPlainText 只取文字件(图不入库,隐私数据地图不漂移,G-05)", () => {
    const content: ChatContentPart[] = [
      { type: "text", text: "第一段" },
      { type: "image", dataUrl: PNG_URL },
      { type: "text", text: "第二段" },
    ];
    expect(contentPartsToPlainText(content)).toBe("第一段\n第二段");
    expect(contentPartsToPlainText("原样返回")).toBe("原样返回");
    expect(contentPartsToPlainText(null)).toBe("");
    // 首尾空白被裁掉:历史里存的是要回灌给模型的文本,留着空白只会浪费上下文。
    expect(contentPartsToPlainText([{ type: "text", text: "  甲  " }, { type: "text", text: "乙  " }])).toBe("甲\n乙");
  });

  it("纯图片件的历史文本是空串(刻意取舍:下一轮追问看不到图,X1-08)", () => {
    expect(contentPartsToPlainText([{ type: "image", dataUrl: PNG_URL }])).toBe("");
  });
});

describe("wireMessageContent · 构造层语义(X1-01/X1-04)", () => {
  it("字符串正文原样返回 —— 这是文本请求体逐字节不变的支点(G-04)", () => {
    for (const wire of ["openai-chat", "openai-responses", "anthropic"] as ChatWireFormat[]) {
      expect(wireMessageContent(wire, "你好")).toBe("你好");
    }
    expect(wireMessageContent("openai-chat", null as unknown as WireChatContent)).toBe("");
    expect(wireMessageContent("openai-chat", undefined as unknown as WireChatContent)).toBe("");
  });

  it("openai-chat:文字件是 text,图片件是 image_url.url", () => {
    expect(wireMessageContent("openai-chat", [{ type: "text", text: "看图" }, { type: "image", dataUrl: PNG_URL }])).toEqual([
      { type: "text", text: "看图" },
      { type: "image_url", image_url: { url: PNG_URL } },
    ]);
  });

  it("anthropic:图片件是 source{type:base64,media_type,data}(不是 url)", () => {
    expect(wireMessageContent("anthropic", [{ type: "text", text: "看图" }, { type: "image", dataUrl: PNG_URL }])).toEqual([
      { type: "text", text: "看图" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
  });

  it("openai-responses:文字件是 input_text,图片件是 input_image + detail", () => {
    expect(wireMessageContent("openai-responses", [{ type: "text", text: "看图" }, { type: "image", dataUrl: PNG_URL }])).toEqual([
      { type: "input_text", text: "看图" },
      { type: "input_image", image_url: PNG_URL, detail: "auto" },
    ]);
  });

  it("图片件重建 data URL 时 mime 归一、空白剔除(三种协议都只带白名单形态)", () => {
    const blocks = wireMessageContent("openai-chat", [{ type: "image", dataUrl: "data:IMAGE/JPEG;base64,AA\nBB" }]) as Record<string, unknown>[];
    expect(blocks[0].image_url).toEqual({ url: "data:image/jpeg;base64,AABB" });
  });

  it("空文字件被丢弃,非法图片件被跳过而不是抛错", () => {
    const parts: ChatContentPart[] = [
      { type: "text", text: "" },
      { type: "image", dataUrl: "https://evil.example.com/a.png" },
      { type: "image", dataUrl: "data:application/pdf;base64,AAAA" },
      { type: "text", text: "只剩这句" },
    ];
    // 构造层要保持纯函数可预测:校验已在服务层做完,这里不能因为一张坏图把整条消息弄崩。
    expect(() => wireMessageContent("openai-chat", parts)).not.toThrow();
    expect(wireMessageContent("openai-chat", parts)).toEqual([{ type: "text", text: "只剩这句" }]);
    expect(wireMessageContent("anthropic", parts)).toEqual([{ type: "text", text: "只剩这句" }]);
    expect(wireMessageContent("openai-responses", parts)).toEqual([{ type: "input_text", text: "只剩这句" }]);
  });

  it("全是非法件时得到空块数组(不是抛错、也不是 undefined)", () => {
    expect(wireMessageContent("anthropic", [{ type: "image", dataUrl: "https://evil.example.com/a.png" }])).toEqual([]);
  });
});

describe("buildWireRequest · 纯文本与带件的请求体形状(X1-01/X1-04)", () => {
  const imageParts: ChatContentPart[] = [{ type: "text", text: "看看这张图" }, { type: "image", dataUrl: PNG_URL }];

  it("openai-chat 纯文本:整段 messages 形状与改造前一致,system 仍在首位", () => {
    const spec = requestFor("openai-chat", "你好");
    expect(spec.url).toBe("https://api.example.com/v1/chat/completions");
    expect(bodyMessages(spec.body)).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "你好" },
    ]);
    // 不传 responseFormat 就不产生任何新键 —— 老调用方请求体逐字节不变(G-04)。
    expect(Object.keys(spec.body).sort()).toEqual(["max_tokens", "messages", "model", "stream", "temperature"]);
  });

  it("openai-chat 带件:content 由 string 变成块数组", () => {
    const spec = requestFor("openai-chat", imageParts);
    expect(bodyMessages(spec.body)[1].content).toEqual([
      { type: "text", text: "看看这张图" },
      { type: "image_url", image_url: { url: PNG_URL } },
    ]);
    expect(typeof bodyMessages(spec.body)[1].content).toBe("object");
  });

  it("两种形状确实不同(纯文本不会莫名其妙变成数组)", () => {
    const plain = requestFor("openai-chat", "看看这张图");
    const withParts = requestFor("openai-chat", [{ type: "text", text: "看看这张图" }]);
    expect(bodyMessages(plain.body)[1].content).toBe("看看这张图");
    expect(Array.isArray(bodyMessages(withParts.body)[1].content)).toBe(true);
  });

  it("anthropic:system 走顶层键,件进 messages[].content", () => {
    const spec = requestFor("anthropic", imageParts);
    expect(spec.url).toBe("https://api.example.com/v1/messages");
    expect(spec.body.system).toBe("SYS");
    expect(bodyMessages(spec.body)[0].content).toEqual([
      { type: "text", text: "看看这张图" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
    expect(bodyMessages(spec.body)).toHaveLength(1);
  });

  it("openai-responses:件进 input[].content,用 input_text/input_image", () => {
    const spec = requestFor("openai-responses", imageParts);
    expect(spec.url).toBe("https://api.example.com/v1/responses");
    expect(spec.body.instructions).toBe("SYS");
    expect(bodyInput(spec.body)[0]).toEqual({
      role: "user",
      content: [
        { type: "input_text", text: "看看这张图" },
        { type: "input_image", image_url: PNG_URL, detail: "auto" },
      ],
    });
  });

  it("多轮上下文里只有带件的那条变成数组,纯文本条保持字符串", () => {
    const spec = buildWireRequest({
      baseUrl: "https://api.example.com",
      apiKey: "sk-test",
      model: "m1",
      wire: "openai-chat",
      system: "SYS",
      temperature: 0.7,
      stream: false,
      maxTokens: 2048,
      messages: [
        { role: "user", content: imageParts },
        { role: "assistant", content: "收到" },
      ],
    });
    expect(bodyMessages(spec.body)).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: [{ type: "text", text: "看看这张图" }, { type: "image_url", image_url: { url: PNG_URL } }] },
      { role: "assistant", content: "收到" },
    ]);
  });
});

describe("buildWireRequest · responseFormat(X2-01)", () => {
  it("openai-chat 带 response_format:{type:\"json_object\"}", () => {
    const spec = requestFor("openai-chat", "你好", "json");
    expect(spec.body.response_format).toEqual({ type: "json_object" });
    expect(spec.body).not.toHaveProperty("text");
  });

  it("openai-responses 带 text.format,而不是 response_format", () => {
    const spec = requestFor("openai-responses", "你好", "json");
    expect(spec.body.text).toEqual({ format: { type: "json_object" } });
    expect(spec.body).not.toHaveProperty("response_format");
  });

  it("anthropic 不加任何 JSON 参数(上游没有这一档,硬塞会被 400)", () => {
    const spec = requestFor("anthropic", "你好", "json");
    expect(spec.body).not.toHaveProperty("response_format");
    expect(spec.body).not.toHaveProperty("text");
    // 请求体仍然完整可用:约束落在提示层与解析层。
    expect(bodyMessages(spec.body)).toEqual([{ role: "user", content: "你好" }]);
  });

  it("不传 responseFormat 时三种协议都不产生新键", () => {
    expect(requestFor("openai-chat", "你好").body).not.toHaveProperty("response_format");
    expect(requestFor("openai-responses", "你好").body).not.toHaveProperty("text");
    expect(requestFor("anthropic", "你好").body).not.toHaveProperty("response_format");
  });

  it("件与 responseFormat 同时给出时互不干扰", () => {
    const spec = requestFor("openai-chat", [{ type: "image", dataUrl: PNG_URL }], "json");
    expect(spec.body.response_format).toEqual({ type: "json_object" });
    expect(bodyMessages(spec.body)[1].content).toEqual([{ type: "image_url", image_url: { url: PNG_URL } }]);
  });
});
