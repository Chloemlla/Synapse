# proxycheck 验签与上游诊断契约

排障面板「IP 风险检测 → 上游诊断」与运行时配置 `PROXYCHECK.trustUnverifiedUpstream` 的契约。
面向实现者：改这里之前先读「三条硬约束」。

## 1. 为什么需要这份契约

线上只留下过这样一行日志：

```
[IpRisk] proxycheck 配置错误：上游凭据/验签密钥无效，风控已降级放行
  { ip: '144.52.238.197', error: 'proxycheck_signature_mismatch', failOpen: true }
```

它只说「验签没过」，不说**为什么**：上游到底回没回 `http_x_signature`、回的响应体是什么、
当前配置的密钥多长、是不是把 `hmacSecret` 填成了 `payloadVerificationKey`。
本契约把「一次上游交互的可诊断信息」固定下来，并明确**什么可以展示、什么永远不能**。

## 2. 三条硬约束

1. **密钥明文永不出现在日志、接口响应、页面里**（仓库约束：`AGENTS.md` §8）。
   密钥只以「长度 + sha256 前 12 位指纹」的形式出现。
   指纹足以回答「两处是不是同一串」「换 key 之后变没变」，反推不出密钥。
2. **要验证某把密钥对不对，走「重算」而不是「回显」**：
   `POST /api/admin/proxycheck/upstream-diagnostics/:id/verify-signature` 带上候选密钥，
   服务端在**已存响应体**上重算 HMAC-SHA256，回答「对不对得上上游回签值」。
   候选密钥只在本次请求的内存中使用，不落库、不写日志。
3. **响应体只留展示副本**：按字节截断到 8 KiB（`MAX_DIAGNOSTIC_BODY_BYTES`），
   验签与 JSON 解析仍用完整字节。截断过的记录在做重算时必须显式告警（`bodyTruncated`）。

## 3. 运行时配置

| 字段 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `PROXYCHECK.failOpen` | boolean | `true` | 上游失败（含验签失败）时是否放行。 |
| `PROXYCHECK.trustUnverifiedUpstream` | boolean | `false` | 验签未通过（`header_missing` / `header_malformed` / `mismatch` / `key_malformed`）时**仍采信上游响应体**。 |

`trustUnverifiedUpstream` 的行为边界：

- 只放宽「验签未通过」。上游自己回的 `status=auth` / `status=denied` **即便打开该开关也照样失败** ——
  那种响应体里没有风险数据，采信它等于凭空放行。
- 每次因它采信都会写一条 `logger.error` 和一行带 `diagnostics` 的 `status=ok` 日志
  （`diagnostics.trustedWithoutSignature=true`），面板上按「已采信（未验签）」筛选可见。
- 它**不是**「关掉验签」：验签照常执行，结论照常记录，只是不再作为采信门槛。
- 密钥长度不对（不等于 64）且该开关关闭时，请求在发出前就被拦下（`proxycheck_hmac_key_malformed`），
  不拿一把永远验不过的密钥去烧上游额度。

## 4. 落库形状

`proxycheck_lookup_logs.diagnostics`（仅在「失败」与「验签未过但已采信」时写入）：

| 字段 | 说明 |
| --- | --- |
| `errorCode` | 本次交互的错误码；成功采信时为空串 |
| `trustedWithoutSignature` | 是否属于「验签未过但已采信」 |
| `method` / `url` | `url` 中的 `key` 参数已换成 `<redacted length=… fp=…>` |
| `requestHeaders` / `requestBody` | 已剔除凭据类头；表单体的 `key` 脱敏、`ips` 折叠 |
| `status` / `responseHeaders` / `body` / `bodyBytes` / `bodyTruncated` | 上游响应；`body` 是截断后的展示副本 |
| `signature.verdict` | `verified` / `header_missing` / `header_malformed` / `mismatch` / `not_configured` / `key_malformed` / `no_response` |
| `signature.headerValue` | 上游回签值原样（不是本服务的密钥，可展示） |
| `signature.expectedSignature` | 用当前密钥对这份响应体重算的值（密钥不可用时为 `null`） |
| `signature.key` | 当前验签密钥的形状（长度 + 指纹） |
| `keys` | 四把配置密钥的形状 + `payloadVerificationKeyMatchesHmacSecret` |

索引：`{ "diagnostics.signature.verdict": 1, createdAt: -1 }` 支撑「按验签结论筛选 + 倒序分页」。
本集合**没有物理 TTL**（与其它取证类集合一致，改 TTL 必须配迁移脚本）。

隐私数据地图里的条目：`proxycheck-lookup-logs`
（`fields` 已含 `diagnostics`；`userFacing.what/why` 已同步，生成物 `src/generated/privacyDataMap.ts` 随契约重新生成）。

## 5. 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/proxycheck/upstream-diagnostics` | 分页列出带快照的行。参数：`limit` / `offset` / `ip`（前缀）/ `verdict` / `trusted`。 |
| POST | `/api/admin/proxycheck/upstream-diagnostics/:id/verify-signature` | 用候选密钥在已存响应体上重算验签。body：`{ "key": "<候选密钥>" }`。 |

两者都要求 superadmin，且沿用 `/api/admin` 挂载点的限流（不要在本文件里再挂一个限流器实例，会把额度减半）。
`/lookups` 的行里只回 `hasDiagnostics` 布尔，正文走上面第一条接口，避免一行 8 KiB 撑大分页。

## 6. 面板怎么读

1. 先看「验签结论」：`header_missing` 与 `mismatch` 的处理路径完全不同。
2. 看「四把密钥」的指纹：`payloadVerificationKey` 与 `hmacSecret` 指纹相同 = 填错了字段。
3. 看「上游响应」：`status=auth/denied` 说明是 apiKey 的问题，不是验签密钥的问题。
4. 还定不下来就用「用候选密钥重算验签」把 Dashboard 上的密钥贴一次：
   `对得上` = 服务端存的那把是错的（还没保存或保存失败）；`对不上` = 这把候选也不对。
