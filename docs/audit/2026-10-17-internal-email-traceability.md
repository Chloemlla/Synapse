# 系统内部发信进入邮件溯源（2026-10-17）

## 症状

`/admin/email-traceability`（邮件溯源）只能看到对外发信（`POST /api/outemail/send`）的记录，
密码重置、邮箱验证、登录提醒、工单通知、管理端手动发信等「系统内部发信」全部不可见；
管理员据此排查「重置邮件到底发没发、发给了谁、正文是什么」时无据可查。

## 根因

- 对外发信在 `services/outEmailService.ts` 的发送成功后写 `outemail_records`；
- 系统内部发信走 `services/emailService.ts` 的 primary 通道（`sendEmail` / `sendBatchEmail`），
  这条链路只打日志（`logger.log("邮件发送成功")`），**从不写库**；
- 溯源页查询的 `/api/outemail/records` 因此只可能看到对外发信。

## 修复

1. 新增 `src/services/emailTraceService.ts`，作为 `outemail_records` 的唯一读写处：
   - `recordEmailTraces()`：批量旁路写入，**捕获并吞掉写入异常**（只记日志），
     绝不让「已发出」被记录失败改写成失败；
   - `getEmailTraceRecords()` / `getEmailTraceRecordById()`：查询从 `outEmailService` 迁入，
     并新增 `channel` 字段与筛选：`internal`（系统内部发信）/ `outemail`（对外发信）。
     历史文档没有 `channel`，统一按对外发信解释，老记录不会在筛选里消失。
2. `services/emailService.ts`：`sendEmail` / `sendBatchEmail` 在供应商受理成功后，
   为 primary 通道（`channel !== "outemail"`）写 `channel: "internal"` 的溯源记录；
   对外发信在 `outEmailService` 里以**原始正文**落库，此处跳过以避免同一次发送写两条。
3. `routes/outemailRoutes.ts`：`GET /api/outemail/records` 支持 `channel` 查询参数
   （未知值按不过滤处理）；权限仍是 `superadmin`（正文可能含验证码/重置链接）。
4. 前端 `EmailTraceability.tsx`：列表新增「来源」列与来源筛选，详情弹窗展示来源；
   标题与说明改为「系统内部发信 + 对外发信」。
5. `AdminDashboard.tsx`：溯源区块说明同步为「含系统内部发信」。

## 边界与取舍

- 保留原语义：供应商受理即成功；溯源写入是旁路，失败只记日志。
- 源 IP：内部发信不携带来路 IP，落库为空字符串（对外发信仍记录调用方 IP）。
- 正文包含重置链接/验证码：与既有对外发信记录同一口径，读取权限保持 `superadmin`，
  不做普通管理员放开。
- Mongo 未连接（启动早期、测试环境）时跳过写入，避免 mongoose 缓冲队列阻塞发信。

## 验证

- `src/tests/emailTraceRecords.test.ts`：内部单发/批量落库、对外通道不重复落库、
  供应商失败不落库、写入异常不影响发送、历史记录来源映射与 `channel` 过滤。
- `src/tests/outEmailDelivery.test.ts`：对外发信记录改走统一服务后仍不改变发送结果语义，
  且记录携带 `channel: "outemail"`。
- 本地不执行构建/测试，最终以 GitHub Actions 结果为准。
