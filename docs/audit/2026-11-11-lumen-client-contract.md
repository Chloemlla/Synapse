# 2026-11-11 Synapse × Project-Lumen 客户端契约审计与修复清单

> 触发场景：Project-Lumen（Android）云端面板「检查服务 / 获取验证码」报
> `Project Lumen API request failed with HTTP 404`，基线地址显示 `https://chloemlla.com/api/`。
> 目标：双端互相适配——服务端不全崩、客户端不因契约漂移或 ip-risk 报备缺数据而整片失败。
>
> 判据来源：线上 `chloemlla.com`（raksmart，容器 `tts-node`，镜像 tag `ea97853`）、
> 两端仓库源码与提交历史。**本机不做任何构建/测试**，编译与用例只由 GitHub Actions 裁决。

## 0. 现场证据链（先定因果，再改代码）

| 观测 | 命令/入口 | 结果 |
| --- | --- | --- |
| 首访闸门可用 | `POST /api/ip-verification/session {fingerprint}` | 200，`issuedBy:"auto"`，签发 40 分钟令牌 |
| 带令牌访问 Lumen 业务 | `POST /api/lumen/v1/auth/email/start` + `X-Fingerprint`/`X-IP-Verification-Token` | **404 `{"error":"Not Found"}`** |
| 不带令牌同一路径 | 同上 | 403 `IP_VERIFICATION_REQUIRED`（说明闸门在前、路由在后） |
| 客户端真实请求路径 | `ProjectLumenApiClient` 21 处 `path = "v1/..."` + 基址 `/api/lumen` | `/api/lumen/v1/<resource>` |
| 服务端真实挂载 | `src/routes/lumen/index.ts` | `router.use("/api/lumen", lumenLimiter, v1Router)`，子路由 `auth/…`（**没有** `v1` 段） |
| 唯一通的一条 | `GET /api/lumen/health` | 200 `{"status":"ok","service":"project-lumen-api"}`（客户端 health 路径不带 `v1/`） |
| 正确前缀可用 | `POST /api/lumen/auth/email/start` + 令牌 | 200 `{"requestId":…,"delivery":"failed"}` |
| 容器内实际代码 | `docker exec tts-node sed -n … dist/routes/lumen/index.js` | 与仓库一致：只有 `/api/lumen` 一个前缀（排除“部署落后”这一假设） |
| 服务端日志 | `docker logs tts-node \| grep 404` | `404 Not Found: POST /api/lumen/v1/auth/email/start …`（请求确实进了 Express 兜底） |

结论：**不是 ip-risk、不是首访闸门、不是超时**，而是两端路径契约漂移——服务端把版本段从
`/api/v1` 换到 `/api/lumen` 时去掉了 `v1`，客户端的 21 个业务路径仍带 `v1/`。客户端
`parseErrorMessage` 取的是 `error.message`，而 Express 兜底 404 的 `error` 是字符串，
于是退化成那句没有任何线索的 `… failed with HTTP 404`。

## 1. 缺陷清单

| 编号 | 位置 | 缺陷 | 改法 |
| --- | --- | --- | --- |
| S-1 | `Synapse/src/routes/lumen/index.ts` | 只挂 `/api/lumen`，已发布的 Project-Lumen 安装包请求 `/api/lumen/v1/*` 全部 404（APK 不会随服务端同步更新） | 同一个 `v1Router` 与 `health` 同时挂 `/api/lumen` 与 `/api/lumen/v1`，共用同一份限流；导出 `LUMEN_API_PREFIXES` 供用例与文档引用 |
| S-2 | `Synapse/src/routes/lumen/index.ts` | 注释写作 “Build the `/api/v1` sub-router”，与真实挂载前缀矛盾，是契约漂移的温床 | 注释改成「版本段只在挂载前缀上」，并写明别名存在的原因 |
| S-3 | `Synapse/src/routes/lumen/platform.routes.ts` | OpenAPI spec 只声明 `servers: /api/lumen`，别名不可发现 | `servers` 增加 `/api/lumen/v1`（标注兼容用途），`info.description` 说明规范基址 |
| S-4 | `Synapse/src/routes/lumenRouteModules.ts` | 治理注记仍写「lumenLimiter 挂在 `/api/lumen` 挂载点」，与实际两处挂载不符 | 注记与 scopes 说明同步（别名嵌套在 `/api/lumen` 作用域内，不新增 scope） |
| S-5 | `Synapse/src/controllers/ipRiskController.ts` | 出口探测上报契约（哪些字段必需、缺浏览器专属字段算不算失败）只存在于网页组件里，原生客户端无从得知，只能假设“少报就失败” | `probe-config` 增加 `reportProfile`（签名算法、canonical 规则、`nativeFields` / `browserOnlyFields`），明确缺失的浏览器轴按「不可判定」处理、不拒收 |
| S-6 | `Synapse/src/tests/`（新增） | 无任何用例守护挂载前缀，回归只能靠生产 404 发现 | `lumenRoutePrefixes.test.ts`：两个前缀的 `health` / `openapi.json` 都 200，未知前缀仍 404 |
| C-1 | `Project-Lumen/app/.../ProjectLumenApiClient.kt` | 21 个业务路径带 `v1/`，与规范基址 `/api/lumen` 拼成 `…/api/lumen/v1/*` | 全部改成无版本段（与服务端、后台面板、CI 同步脚本、OpenAPI 一致）；该写法的旧服务端同样可用，无需两侧同版本上线 |
| C-2 | `Project-Lumen/app/.../ProjectLumenApiConfig.kt` | `normalizeApiBaseUrl` 只把「恰好等于主机根」的写法改回默认值：CI 变量写成 `/api`、`/api/`、`/api/lumen/v1` 时会把整个客户端的请求打到 404 / 蜜罐 200 的假数据上 | 归一化任意 `host`、`host/`、`host/api`、`host/api/lumen`、`…/api/lumen/v1`（含尾斜杠）到规范基址，其他自定义后端路径保持原样 |
| C-3 | `Project-Lumen/app/.../ProjectLumenOriginProbe.kt`（新增） | 官方客户端从不上报出口探测数据，ip-risk 面板对安卓客户端永远缺一层观测（用户视角即「没给 iprisk 报备」） | 按 `reportProfile` 实现原生上报：`probe-config` → `echo`（拿会话）→ canonical JSON + HMAC-SHA256 → `report`；只报原生可观测字段，缺浏览器轴不上报不猜测，全程 best-effort 不抛错 |
| C-4 | `Project-Lumen/app/.../ProjectLumenApiConfigTest.kt`、`ProjectLumenApiClientContractTest.kt`、`ProjectLumenOriginProbeTest.kt`（新增） | 上述三条都没有用例，路径/归一化/签名任何一处漂移只会在真机上表现成 404 或验签失败 | 归一化表驱动用例、拦截器记录的请求路径断言、canonical JSON 与 HMAC 向量（向量由线上服务端接受的同一实现产出） |

## 2. 明确的“不改”项与理由

- **首访闸门（`/api/ip-verification/*`）与 `X-Fingerprint` 契约不动**：线上实测客户端指纹形态
  合法（64 位小写 hex 满足服务端 `^[a-zA-Z0-9_-]{8,200}$`），干净 IP 直接 `issuedBy:"auto"`，
  无需人机验证。把闸门放宽才是真风险。
- **`/api/v1/*` 蜜罐不动**：它返回 200 假数据，是给扫描器的诱饵；本次只保证官方客户端不再落到
  Express 兜底 404（兜底 404 会把 `error` 写成字符串，客户端拿不到可读 message）。
- **不把服务端 `/api/lumen/v1` 当新契约**：别名只为已发布安装包存在；新客户端走无版本段路径，
  这样客户端不需要等下一次服务端发布也能工作。

## 3. NexAI（另一位官方客户端）：闸门未参与 + 身份头缺失

排查方法同上：把 NexAI 的 24 个后端路径逐个打到线上（带/不带令牌对照），结论与 Project-Lumen
**不同**：路径本身对得上（`/api/nexai/**` 就是 Synapse 的挂载点），但**没有一个请求通过首访闸门**。

| 观测 | 结果 |
| --- | --- |
| `POST /api/nexai/auth/me`（无闸门头） | 403 `IP_VERIFICATION_REQUIRED` / `missing_verification_headers` |
| 同上带 `X-Fingerprint` + 令牌 | 进入业务（`/auth/me` 是 GET，POST 才是 404 —— 方法不匹配，不是路径漂移） |
| NexAI 源码 | `lib/`、`winui/` 里完全没有 `X-Fingerprint` / `X-IP-Verification-Token` / `X-Client-Name` |

也就是说：**NexAI 的注册/登录/同步/制品/安全上报在闸门开启的部署上一律 403**，与密码、网络无关。

| 编号 | 位置 | 缺陷 | 改法 |
| --- | --- | --- | --- |
| N-1 | `NexAI/lib/services/*` | 完全不参与 `/api/ip-verification` 握手 | 新增 `nexai_ip_verification.dart`：干净 IP 静默拿 `issuedBy:"auto"` 令牌，403+闸门标记时握手并重放一次；要人机验证/被封时只记原因不硬撞（冷却 5 分钟） |
| N-2 | `NexAI/lib/services/nexai_backend_client.dart` | 单一发送点没有闸门头，也没有重放 | `_send` 统一挂 `X-Fingerprint`/令牌，闸门 403 时握手重放；每次尝试**重新签名**（nonce 一次性） |
| N-3 | `NexAI/lib/services/lumen_translation_client.dart` | 翻译走 `/api/public/deeplx/**`，同样被闸门拦，表现为「网络错误」 | 同一套闸门头 + 重放，Lumen 签名 canonical 不含头集合，追加头不影响验签 |
| N-4 | `NexAI/lib/services/nexai_client_identity.dart` | 不带 `X-Client-Name`/`X-Platform`/`X-Device-Id`/`X-Device-Name`，后台只能把它归成 `other` | 新增身份模块，设备标识复用闸门指纹（同一 sha256 hex，跨重启稳定） |
| N-5 | `Synapse/src/services/authSessionService.ts`、`src/models/authSessionModel.ts` | `normalizeClientType` 不认 `NexAI`，会话列表里显示成 `other` | 词表加入 `nexai|nex-ai|nex_ai`，`AuthClientType` 与 schema enum 增加 `NexAI` |
| N-6 | `NexAI/winui/NexAI.Infrastructure/Security/NexaiHttp.cs` | Windows 端同样的闸门缺失（CI 会构建 WinUI，属于在发布链路里的客户端） | 抽出 `SendOnceAsync`，闸门 403 时刷新令牌并重试；非闸门 403 重建响应原样交回（body 只能读一次） |
| N-7 | `NexAI/winui/.../Tools/DeepLxTranslationClient.cs` | WinUI 翻译客户端同样绕过闸门 | 同上：`NexaiIpVerification` 头 + 重放 |
| N-8 | `NexAI/test/services/nexai_ip_verification_test.dart`（新增） | 上述判断（什么 403 可重放、令牌缓存/冷却/封禁）无用例 | 6 条用例覆盖判定、握手、复用、冷却、封禁、异常降级 |

**挂起（不本轮做）**：NexAI 的出口探测上报（`/api/ip-risk/echo` + `/api/ip-risk/report`）。
理由是闸门才是「所有请求失败」的根因，报备属附加观测；服务端已把缺失的浏览器轴判为「不可判定」，
不参与拒收，所以缺报备不会造成失败。Project-Lumen 侧已实现（见 §1 C-3），NexAI 可照同一契约后续补。
