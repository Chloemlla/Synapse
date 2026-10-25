# 网站 CDict 翻译与朗读

网站 `/translate` 工作台可在 CDict 与原有 DeepLX 之间选择。CDict 的翻译、语言列表、在线朗读、英／美式词典发音及赞赏功能共用后端现有服务；网站不持有上游凭据或 Android 客户端签名密钥。

## 接口与鉴权边界

网站统一使用 `/api/translate/cdict`。这是一条独立的网站会话分支，不是 Android 接口的免签入口。

| 方法 | 网站接口 | 功能 |
| --- | --- | --- |
| POST | `/api/translate/cdict/translate` | 翻译，JSON 或表单字段 `text`、`from`、`to` |
| GET | `/api/translate/cdict/languages` | 支持的语言列表 |
| GET | `/api/translate/cdict/tts` | 在线合成、词典发音或显式 Microsoft 短朗读，返回浏览器可播放的音频 |
| GET | `/api/translate/cdict/donate` | 赞赏渠道、说明与鸣谢名单 |
| POST | `/api/translate/cdict/donate/claim` | 交易号和署名申请 |
| GET | `/api/translate/cdict/donate/:channel` | 当前渠道的收款码 |

- 所有网站端点均要求有效网站登录会话以及翻译权限；登录过期、撤销、停用或封停不能以客户端签名替代。
- 翻译被停用或仍处于限期限制时，网站 CDict 与原有翻译功能采用一致的拒绝策略。
- 交第三方处理的翻译／朗读请求沿用网站功能协议同意检查和写请求来源校验。
- 网站请求保留正常的 IP、WAF、安全检查与请求限额；翻译／朗读另外限制并发。
- 原有 `/api/cdict` 仍使用原生客户端签名和限流管线，未改成接受网站登录替代签名。
- 前端通过共享 `api` 实例发送请求。音频和内置收款码也是先以登录态取得响应，再生成临时 Blob URL，而不是直接把受保护接口塞进媒体元素；外部图床图片的处理见下文。

## 翻译与语言

`POST /translate` 最长 5000 个字符，`from` 默认为 `auto`，`to` 必填。CDict 语言码与 DeepLX 不同，例如英文 `en`、简体中文 `zh-CHS`。网站从后端加载 CDict 语言列表，不把 DeepLX 的静态语言枚举当作 CDict 的上游能力清单。

语言列表识别 SDK 的 `data.langs`，成功对象保留原始字段并提供顶层 `languages` 兼容别名，旧 CDict 客户端无需为此立即升级。非零业务码（如 `20000`）、失败标志、空或无法识别的语言集合返回 HTTP 502 与 `success:false`，不再把错误标成成功；不会用内置静态集合冒充上游结果。

翻译端点保留 CDict 响应结构。前端识别 `success`、非零 `code`／`retcode` 失败，不能仅凭 HTTP 200 宣称成功；成功时读取译文、实际源语言和目标语言。音标只展示文本，不向用户展示上游内部音频地址或设备字段。

切换提供方、语言或文本后，应取消过期翻译请求；历史项须记录提供方，旧 DeepLX 历史仍按 DeepLX 解释。

## 发音

`GET /tts` 的参数：

| 字段 | 说明 |
| --- | --- |
| `text` | 要朗读的文本，非空且最长 300 个字符；不静默截断 |
| `source=engine` | 在线语音合成 |
| `langType` | `engine`／`microsoft` 的语言与口音，省略时为 `en-USA`；例如 `en-USA`、`en-GBR`、`zh-CHS`、`zh-CHT` |
| `source=youdao` | 词典发音 |
| `type=1` / `type=2` | 英式／美式词典发音，仅 `youdao` 使用 |
| `source=microsoft` | 网站专用 Microsoft 短朗读，仅在运行时已启用 Edge 提供方时可用；无需传 `type` |

在线合成能否使用取决于后端上游语音配置及其支持的语言，词典发音不假装成任意语言的在线合成。CDict 分支不追加服务级重试，也不自动跨提供方兜底；上游失败返回 502，不自动改用浏览器语音冒充后端成功。

Microsoft 请求仍是同一个 `GET /api/translate/cdict/tts`，传 `source=microsoft&langType=...&text=...`。它每次读取当前 TTS 提供方启用集合、Edge 地址与音色目录，不使用 TTS 页的默认主服务。语言码 `en-USA`／`en-GBR`／`zh-CHS`／`zh-CHT` 分别映射到 `en-US`／`en-GB`／`zh-CN`／`zh-TW`；`zh-HK` 保持香港粤语地区，不归成台湾国语。这些明确口音／中文地区只能选匹配地区的目录音色；其它语言优先匹配精确地区，再选同语言音色。未知语言不会改成中文，`auto` 不可用于 Microsoft 朗读。音色优先采用目录内的常用对应音色，其次采用匹配语言的配置默认音色或目录候选；管理员更新地址、目录或启用状态后，后续请求按新配置处理。

`text` 和 `langType` 先校验再调用服务；无效参数返回 400，超过 300 字返回 413。Edge 未启用、语言没有可用音色、服务失败、非音频／无效音频或超过 8 MiB 时，Microsoft 请求仍返回 502 与非零 `code`，不改用其它来源。成功响应为经过音频校验的 `audio/mpeg` 字节，使用 `Cache-Control: private, no-store`；断连取消该次 Microsoft 合成，不取消其它请求。

这是现有网站 CDict **短朗读**的扩展：继续要求网站会话、翻译权限、`tts-generate` 条款同意，并共享该分支既有的 IP／用户请求限额以及用户／IP／全局并发限额。它不创建公共音频文件、TTS jobs 或历史，不消耗或改变 TTS 页生成码、生成配额和任务队列；短朗读限额独立于 TTS jobs，换 `source` 不能获得新额度。原生 `/api/cdict/tts` 仍只接受 `engine`／`youdao`，`microsoft` 返回 400。

前端 API 契约为 `fetchMicrosoftTranslatorSpeech(payload: CDictSpeechPayload, signal?): Promise<Blob>`：将原始来源／口音转换成上述 Microsoft 查询，仍走网站认证 API。调用方仅在首次服务／网络／音频错误后显式发起一次 Microsoft 请求；权限拒绝、限流、主动取消和浏览器自动播放拒绝不触发兜底。Microsoft 请求失败仍显示失败，成功时前端按实际使用的来源显示状态。

网站端将上游裸 PCM 包装成单声道、16000 Hz、16-bit WAV；已有 MP3／WAV 字节保持原样。转换只发生在网站分支，原生客户端收到的音频契约不变。网站音频不进入公共共享缓存。

原文与译文均可发音，英文在线合成可分别选择英式与美式；词典发音也提供这两种口音。新播放、文本／语言／提供方变更以及页面离开时，取消过期请求、停止旧音频并释放 Blob URL，避免播放错版本的文本或泄漏媒体资源。

## 赞赏

赞赏配置关闭或没有可用渠道时，列表返回 404，网站将其视为功能未开启而非翻译故障。渠道与鸣谢名单实时读取，不将收款信息写入前端源码。

网站的收款码接口有两种成功响应：内置图片返回图像字节；管理员配置外部图床时返回 `200 application/json { success: true, imageUrl }`。地址仍经后端既有 HTTPS 直链校验。网站对外部图片仅用不附加本站会话／安全请求头、无 referrer 的图片元素展示，不用共享 `api` 请求图床，避免图床 CORS 失败或转发安全请求头。图床可能接收其自身域下的浏览器 Cookie，这不等于转发本站会话；服务端也不新增外部图片下载代理。原生收款码接口的 302 行为保持不变。

署名申请提交 `transactionId` 和 `displayName`，由后端继续执行原有格式校验、幂等规则与提交限流。站点不宣称已核实付款；是否加入鸣谢名单仍由管理员核实。

## 管理后台上游配置

env-manager 的「CDict 翻译与朗读配置」支持全部现有上游环境项：

| 环境默认值 | 后台字段 | 用途 |
| --- | --- | --- |
| `VIVO_TRANSLATE_BASE_URL` | `translateBaseUrl` | 翻译及语言列表的服务地址 |
| `VIVO_TRANSLATE_APP_ID` | `translateAppId` | 翻译与语言列表应用标识 |
| `VIVO_TTS_URL` | `ttsUrl` | 在线朗读服务地址 |
| `VIVO_TTS_APP_ID` | `ttsAppId` | 在线朗读应用标识 |
| `VIVO_TTS_APP_KEY` | `ttsAppKey` | 在线朗读凭据 |

管理员接口为 `GET / POST / DELETE /api/admin/cdict-upstream/setting`。读取时密钥仅脱敏展示，并提供 `hasTtsAppKey` 状态；只有超级管理员可写入或重置，并沿用网站安全验证。新密钥输入留空表示保留已有值，勾选明确清除会使在线引擎不可用，删除整个后台覆盖则恢复部署环境默认值。保存后后续请求读取当前运行期配置，不依赖服务重启。现有 CDict 客户端请求签名与赞赏配置分区仍单独维护。

网站和 Android 继续使用 GET 获取后端语言列表，不要求客户端改变请求方法。服务端按 SDK 发送完整 GET 查询（包含 `online=1`、`appId`、`app`、`userId`、`imei` 和设备字段）；只有上游明确返回 HTTP 405 时，才以相同参数兼容回退一次 POST 表单。

## 验证

后端回归覆盖网站会话鉴权、翻译限制、条款同意、原生签名／来源隔离、各来源共享的限额与并发、端点委派、PCM/WAV 兼容，以及 Microsoft 的启用状态、运行时地址／目录更新、语言口音选择、8 MiB 音频校验和请求取消；前端回归覆盖 CDict 返回值归一化、语言和提供方切换、认证 API 路径、发音请求及资源清理。所有构建与测试只由 GitHub Actions 执行，具体通过结论以当前提交的 CI job / step 为准。

## Microsoft 协议维护与诊断

网站短朗读与 TTS 页共用 `src/tts/edge/edge.client.ts`，都发送 Sec-MS-GEC v2 参数。握手 403 仅说明上游拒绝鉴权，不直接归因为时钟偏差；只有上游 Date 证明偏移发生变化时才在客户端内有限重试。时差是相对本机的绝对值，不能重复累加；短朗读取消也终止校时请求。短朗读服务日志保留受控 TTS 错误码、HTTP 状态与协议版本，不记录上游地址、令牌或朗读文本。CI 除替身回归外，核对独立参考向量并请求真实中英文音频；其成功结论才是当前上游协议可用的证据。
