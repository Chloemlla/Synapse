# Synapse - 智能语音合成与综合服务平台

[![Docker Image Version](https://img.shields.io/docker/v/happyclo/tts-node?sort=date&label=Docker%20Image&color=blue&logo=docker)](https://hub.docker.com/r/happyclo/tts-node/tags)
[![Docker Pulls](https://img.shields.io/docker/pulls/happyclo/tts-node?logo=docker&label=Pulls)](https://hub.docker.com/r/happyclo/tts-node)
[![Docker Image Size](https://img.shields.io/docker/image-size/happyclo/tts-node?sort=date&logo=docker&label=Image%20Size)](https://hub.docker.com/r/happyclo/tts-node)
[![License](https://img.shields.io/badge/License-Custom-red.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-339933?logo=node.js)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript)](https://www.typescriptlang.org/)
[![Express](https://img.shields.io/badge/Express-5.x-000000?logo=express)](https://expressjs.com/)

> [!CAUTION]
> **使用本项目前，请务必先阅读 [LICENSE](LICENSE) 文件。** 本项目采用自定义许可证，对使用、修改和分发有明确的限制条件。未经许可证授权的任何使用行为，由使用者自行承担全部法律责任和后果。继续使用本项目即表示您已阅读、理解并同意遵守许可证中的所有条款。

> [!IMPORTANT]
> 本项目的 Docker 镜像托管在 [Docker Hub: happyclo/tts-node](https://hub.docker.com/r/happyclo/tts-node/tags)，请始终使用最新版本的镜像以获得安全更新和功能修复。

一个功能丰富的全栈 Web 应用平台，以文本转语音（TTS）为核心，集成用户认证、安全防护、资源商店、数据分析、实用工具、娱乐游戏、管理后台等数十个功能模块。后端基于 Node.js + Express 5 + MongoDB，前端基于 React 19 + Vite 8 + Tailwind CSS 4，支持 Docker 一键部署。

---

## 📋 目录

- [项目概述](#项目概述)
- [核心功能模块](#核心功能模块)
  - [认证与安全](#1-认证与安全)
  - [文本转语音 (TTS)](#2-文本转语音-tts)
  - [用户管理](#3-用户管理)
  - [资源商店](#4-资源商店)
  - [数据收集与分析](#5-数据收集与分析)
  - [通信服务](#6-通信服务)
  - [实用工具](#7-实用工具)
  - [查询服务](#8-查询服务)
  - [娱乐与游戏](#9-娱乐与游戏)
  - [管理后台](#10-管理后台)
  - [网络与集成](#11-网络与集成)
  - [UI 演示中心](#12-ui-演示中心)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [环境配置](#环境配置)
- [API 文档](#api-文档)
- [部署](#部署)
- [开发指南](#开发指南)
- [安全特性](#安全特性)
- [监控与日志](#监控与日志)
- [更新日志](#更新日志)
- [许可证](#许可证)

---

## 🎯 项目概述

Synapse 是一个综合性 Web 应用平台，围绕文本转语音核心功能，扩展出完整的用户体系、安全防护、资源管理、数据分析等企业级能力。平台采用前后端分离架构，后端提供 43 个路由模块、50+ 个服务模块，前端包含 100+ 个 React 组件，覆盖认证、工具、商店、游戏、查询、管理等多个业务领域。

### 亮点特性

- 🔐 多因素认证体系（密码 + TOTP + Passkey/WebAuthn + 邮箱验证 + 备份码）
- 🔑 OIDC 登录提供方：本服务可作为下游应用的统一身份源
- 🔒 全站统一「安全会话」：查看密钥 / 命令执行 / 双因素配置 / 第三方绑定共用一次强验证（密码 / TOTP / Passkey）
- 🧬 单一 `AES_KEY` 主密钥，经 HKDF 派生 JWT 签名、密码 KEK、令牌签名与各内部签名/凭据密钥
- 🛡️ 多层安全防护（WAF + IP 封禁 + 速率限制 + 篡改检测 + 智能人机验证 + proxycheck.io IP 风险检测 + WebRTC 泄露检测）
- 🧩 人机验证供应商调度：Turnstile / hCaptcha / trycap 可按场景权重、优先级、粘性、灰度与月度额度下发
- 📜 政策条文单点维护：登录/注册逐项同意、条文指纹留痕、用户端查看与撤回、管理端只读审计
- 🎙️ 多提供商文本转语音（OpenAI / Fish Audio / 内置微软 Edge 朗读）
- 🎧 语音转文本（录音转写）与媒体工具（B 站音频下载联动）
- 🗂️ 生成记录自助管理（标题 / 备注 / 标签 / 软删除）
- 🏪 完整的资源商店与 CDK 兑换系统
- 📊 用户行为数据收集与分析（集成 Microsoft Clarity）
- 🌐 WebSocket 实时通信
- 🐳 多阶段 Docker 构建，支持代码混淆
- 📚 内置 Swagger/OpenAPI 文档
- ☁️ 可选 Cloudflare Worker 分发包

---

## ✨ 核心功能模块

### 1. 认证与安全

#### 多因素认证 (MFA)
| 认证方式 | 说明 | 后端路由 | 前端组件 |
|---------|------|---------|---------|
| 密码认证 | 用户名/邮箱 + 密码登录注册 | `authRoutes` | `LoginPage`, `RegisterPage` |
| TOTP 双因素 | 基于时间的一次性密码（Google Authenticator 等） | `totpRoutes` | `TOTPManager`, `TOTPSetup`, `TOTPVerification` |
| Passkey/WebAuthn | 无密码生物识别认证（指纹/面容） | `passkeyRoutes` | `PasskeySetup`, `PasskeyVerifyModal` |
| 邮箱验证 | 注册邮箱验证 + 密码重置链接 | `emailRoutes` | `EmailVerifyPage`, `ForgotPasswordPage`, `ResetPasswordLinkPage` |
| 备份码 | MFA 备用恢复码 | `authRoutes` | `BackupCodesModal` |

#### 安全防护体系
| 防护层 | 说明 | 实现 |
|-------|------|------|
| WAF 防火墙 | Web 应用防火墙，检测恶意请求 | `wafMiddleware.ts` |
| IP 封禁 | 自动/手动封禁恶意 IP，支持 CIDR 段 | `ipBanCheck.ts`, `IPBanManager` |
| 速率限制 | 按路由粒度的请求频率限制（37 个独立限流器） | `routeLimiters.ts` |
| 篡改检测 | 前端关键元素篡改保护 | `tamperProtection.ts`, `TamperDetectionDemo` |
| 智能人机验证 | 基于行为分析的人机识别 | `smartHumanCheckService.ts`, `SmartHumanCheck` |
| Turnstile 验证码 | Cloudflare Turnstile 集成 | `turnstileAuth.ts`, `TurnstileWidget` |
| 人机验证 | 三家供应商（Turnstile / hCaptcha / trycap）统一下发链路，可按场景配置权重、优先级、粘性、灰度与月度额度，控件加载失败自动换家 | `ManagedCaptcha`, `CaptchaVerificationPage`, `HCaptchaWidget`, `TurnstileWidget`, `CapWidget` |
| 安全会话 | 查看密钥 / 命令执行 / 双因素配置 / 第三方绑定共用一次强验证（密码 / TOTP / Passkey），TTL 内可复用 | `utils/securitySession.ts`, `EstablishSecuritySession` |
| 主密钥派生 | 单一 `AES_KEY` 经 HKDF-SHA256 派生 JWT 签名、密码 KEK、令牌与内部签名密钥，旧 env 与存量密文双接受 | `config/keyDerivation.ts` |
| 政策同意 | 登录/注册/TTS 逐项勾选，条文指纹留痕，用户端可查看与撤回，管理端只读审计；**具体功能按用户自己的同意放行**（见下方「按同意开放功能」） | `policyRoutes`, `policyConsentChecklist`, `featureConsent` |
| 首次访问检测 | 新设备/浏览器首次访问验证 | `FirstVisitVerification` |
| IP 风险检测 | proxycheck.io IP 风险评分与自动阻断（出口探测 + HMAC 验签 + WebRTC 泄露自判） | `ip-risk` 服务、`IP 风险缓存页` |
| 指纹采集 | 浏览器指纹识别与追踪 | `FingerprintManager`, `FingerprintRequestModal` |
| 重放保护 | 防止请求重放攻击 | `replayProtection.ts` |
| 审计日志 | 全操作审计记录 | `auditLog.ts`, `AuditLogViewer` |

### 2. 文本转语音 (TTS)

> [!NOTE]
> TTS 功能依赖 OpenAI API，需要在 `.env` 中配置有效的 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL`。支持自定义 API 代理地址。

平台核心功能，基于 OpenAI TTS API 实现高质量语音合成；支持多提供商并存与用户切换（OpenAI / Fish Audio / 内置微软 Edge 朗读接口）。

> [!NOTE]
> 综合服务平台首页迁移后，语音合成工作台位于 `/tts`。

- **语音合成**：支持多种语言、多种音色，文本转语音生成
- **音频管理**：生成历史记录、音频文件缓存与预览
- **记录自助管理**：生成记录可设置标题、备注与预设标签，删除为软删除（管理后台仍可见）
- **生成统计**：用户生成次数统计与分析
- **音频预览**：在线播放生成的音频文件

| 模块 | 说明 |
|------|------|
| 后端路由 | `ttsRoutes.ts` |
| 后端服务 | `ttsService.ts` |
| 前端页面 | `TtsPage.tsx`（主页面）、`TTSForm.tsx`（表单）、`AudioPreview.tsx`（预览） |
| 静态资源 | `/static/audio/` 音频文件服务 |

#### 语音转文本（录音转写）

核心功能之一：登录用户在 `/transcribe` 上传录音即可拿到文字，管理员另有 `/admin/media-tool`（含 B 站音频下载联动）。

- **长录音友好**：单文件最大 500MB，任务在服务端排队执行，中断后可原地重试，不必从头再跑
- **三种产物**：纯文本 `.txt` / 带时间线 `.timed.txt` / 字幕 `.srt`，可任意组合，默认纯文本
- **分段展示**：结果按段落返回，页面提供「有时间线 / 无时间线」两种视图，支持复制与下载
- **按用户隔离**：每个人的上传文件与任务各自独立，越界访问与跨用户读取一律拒绝
- **限额可配**：每人单次文件数、并发任务数、上传上限与接口凭据均由管理员维护

| 模块 | 说明 |
|------|------|
| 后端路由 | `transcribeRoutes.ts`（`/api/transcribe`，登录用户）、`mediaToolRoutes.ts`（`/api/admin/media-tool`） |
| 转写与队列 | `src/mediaTool/`（转写引擎 + 任务队列，两类入口共用同一个 runner） |
| 前端页面 | `speech-to-text/SpeechToTextPage.tsx`（用户页）、`admin/media-tool/*`（管理端） |
| 配置入口 | 「管理后台 → 系统配置 → 语音转文本与媒体工具」、「管理后台 → 媒体工具 → 设置」 |

### 3. 用户管理

> [!NOTE]
> 用户数据存储仅支持 MongoDB。`USER_STORAGE_MODE` 只能设置为 `mongo`，或省略后使用默认值 `mongo`。
> 后端 MongoDB 持久化的启动链路、集合、索引和运维细节见 [后端 MongoDB 持久化细节](docs/reference/backend-mongo-persistence-detail.md)。

- **用户注册/登录**：支持用户名 + 密码注册，JWT Token 认证
- **个人资料**：头像、昵称、邮箱等个人信息管理
- **API 密钥**：用户可生成和管理个人 API 密钥
- **用户偏好**：个性化设置存储
- **存储模式**：仅支持 MongoDB 用户数据存储模式

| 模块 | 说明 |
|------|------|
| 后端路由 | `authRoutes.ts`, `apiKeyRoutes.ts` |
| 后端服务 | `userService.ts`, `apiKeyService.ts`, `userGenerationService.ts` |
| 前端组件 | `UserProfile.tsx`, `ApiKeyManager.tsx`, `UserManagement.tsx` |
| 数据模型 | `accessTokenModel.ts`, `apiKeyModel.ts`, `userPreferencesModel.ts` |

### 4. 资源商店

完整的数字资源分发与 CDK 兑换系统。

- **资源浏览**：资源列表展示、详情查看、分类筛选
- **CDK 兑换**：激活码生成、批量导入/导出、兑换验证
- **库存管理**：资源库存追踪、交易记录
- **模组列表**：游戏模组管理与分发
- **管理后台**：资源 CRUD、CDK 批量管理

| 模块 | 说明 |
|------|------|
| 后端路由 | `resourceRoutes.ts`, `cdkRoutes.ts`, `modlistRoutes.ts` |
| 后端服务 | `resourceService.ts`, `cdkService.ts`, `transactionService.ts` |
| 前端组件 | `ResourceStoreList.tsx`, `ResourceStoreDetail.tsx`, `ResourceStoreManager.tsx`, `CDKStoreManager.tsx`, `AdminStoreDashboard.tsx`, `ModListPage.tsx`, `ModListEditor.tsx` |
| 数据模型 | `resourceModel.ts`, `cdkModel.ts` |

### 5. 数据收集与分析

- **行为数据收集**：用户操作行为、页面访问、设备信息采集
- **数据处理**：数据清洗、聚合、统计分析
- **使用分析**：API 调用统计、功能使用频率分析
- **查询统计**：各模块查询次数与趋势
- **Microsoft Clarity**：集成 Clarity 用户行为分析（前端自动初始化）

| 模块 | 说明 |
|------|------|
| 后端路由 | `dataCollectionRoutes.ts`, `dataCollectionAdminRoutes.ts`, `dataProcessRoutes.ts`, `analyticsRoutes.ts` |
| 后端服务 | `dataCollectionService.ts`, `dataProcessService.ts`, `usageAnalyticsService.ts`, `queryStatsService.ts`, `clarityService.ts` |
| 前端组件 | `DataCollectionManager.tsx` |

### 6. 通信服务

- **内部邮件**：系统通知邮件、验证码邮件（基于 Resend API）
- **外部邮件**：对外邮件发送服务，支持独立域名
- **Webhook**：事件驱动的 Webhook 通知系统（基于 Svix）
- **WebSocket**：实时双向通信，支持广播消息

| 模块 | 说明 |
|------|------|
| 后端路由 | `emailRoutes.ts`, `outemailRoutes.ts`, `webhookRoutes.ts`, `webhookEventRoutes.ts` |
| 后端服务 | `emailService.ts`, `outEmailService.ts`, `webhookEventService.ts`, `wsService.ts` |
| 前端组件 | `EmailSender.tsx`, `OutEmail.tsx`, `WebhookEventsManager.tsx`, `BroadcastManager.tsx`, `WsConnector.tsx` |
| 邮件模板 | `emailTemplates.ts` |

### 7. 实用工具

#### 文本工具
| 工具 | 说明 | 前端路由 |
|------|------|---------|
| 字数统计 | 字数、字符数、段落数、阅读时间统计 | `/word-count` |
| 大小写转换 | 文本大小写批量转换 | `/case-converter` |
| Markdown 导出 | Markdown 渲染与导出为 PDF/DOCX | `/markdown-export` |
| Markdown 预览 | 实时 Markdown 渲染预览（支持 KaTeX 数学公式、Mermaid 图表） | 内嵌组件 |

#### Markdown → Word 批量转换（doc-tool）

把 Markdown 批量转成高保真的 Word 文档：入口在 `/doc-convert`，也可在 `/markdown-export` 页顶部切到「批量」模式。须登录，上传的文件与产物按用户隔离。

- **批量转换**：一次上传多个 `.md`，服务端依次排队转换，逐文件显示进度与结果
- **冲突策略三选一**：目标已存在时「跳过 / 自动另存为 `xxx (2).docx` / 覆盖」，默认不覆盖
- **参考样式模板**：可上传自己的参考样式文档，也可在页面上一键生成默认模板；**表格框线与中文字体等样式由该参考样式文档统一决定**，改一处即可全量生效
- **目录结构保留**：递归收集子目录，产物按相同的相对目录结构落盘
- **结果可追溯**：成功 / 跳过 / 失败逐条明细，附一份可下载的转换报告
- **打包下载**：一次把本次成功产物打包成 zip 取回；文件列表里已有的产物也能逐个下载或一次打包（不必为拿回旧文档重跑一次）
- **默认参考样式**：仓库自带一份可用的参考样式文档（`src/assets/doc-tool/reference.docx`），用户不选模板时就用它——表格框线与中英文字体开箱即用，不用先理解 pandoc 的样式文档
- **失败重试**：只重跑失败那几项，不必整批重来
- **选项记忆**：上次用过的选项（策略 / 输出方式 / 是否递归 / 参考样式）下次打开自动带出
- **产物自动过期**：过期产物按保留天数自动清理

| 模块 | 说明 |
|------|------|
| 后端路由 | `docToolRoutes.ts`（`/api/doc-tool`，登录用户） |
| 转换与队列 | `src/docTool/`（pandoc 转换引擎 + 任务队列） |
| 前端页面 | `DocConvertPage.tsx`（独立页 `/doc-convert`）、`MarkdownExportPage.tsx` 的「批量」模式 |
| 外部依赖 | 镜像内置 pandoc（见 `Dockerfile`）；pandoc 不可用时页面给出明确提示而非静默失败 |

限额与目录由环境变量维护（详见 `.env.example` 的「Markdown → Word 批量转换（doc-tool）」一节）：`DOC_TOOL_WORK_DIR`、`DOC_TOOL_PANDOC_BIN`、`DOC_TOOL_MAX_UPLOAD_BYTES`、`DOC_TOOL_MAX_FILE_BYTES`、`DOC_TOOL_MAX_FILES_PER_JOB`、`DOC_TOOL_MAX_ACTIVE_JOBS`、`DOC_TOOL_RETENTION_DAYS`。

#### 按同意开放功能（feature consent gate）
需要处理用户内容或涉及账号/第三方处理的功能，**按用户自己勾选的政策文件放行**：没勾完就在页面上先同意再继续，后台对同一功能也会拒绝（前端拦不等于后端就不管）。

- **按人不按设备**：同意记录绑到用户 id（不再只绑设备指纹）——同一台设备上换个账号不能蹭到上一位用户的同意；撤销同意后同一用户**立即**失去访问（门禁刻意不做进程缓存）。
- **按义务挂文件，不是“一律四份”**：上传并服务端处理（文档转换、图片、音频转写）要 `usage` + `specific-terms`；对外发布（IPFS 图床、短链）要 `usage` + `specific-terms`；交第三方处理（TTS、翻译）同样两份；账号/凭据/开放接口与配额（API Key、OAuth、CDK）要 `terms` + `specific-terms`；采集上报个人数据（数据上报）要 `terms` + `specific-terms`。映射表与依据（含路由证据）在 `src/config/featureConsent.ts`，加新功能只需在那里加一行并在目标路由挂 `requireFeatureConsent("<key>")`。
- **被拦时给得出路**：后端返回稳定 `code: POLICY_CONSENT_REQUIRED` 与缺失的条款清单，页面据此弹同意清单（复用登录/注册那套勾选组件），同意后自动放行，不必重进页面。
- **不设门禁的功能就不加**：纯本地/无个人数据的工具（计算器、大小写转换等）不挂门禁——过度门禁会把「需要同意」这句话的意思稀释掉。

#### 生活工具
| 工具 | 说明 | 前端路由 |
|------|------|---------|
| 年龄计算器 | 精确年龄计算，支持多种日期格式 | `/age-calculator` |
| 日志分享 | 加密日志分享与查看 | `/logshare` |
| 校园紧急情况 | 校园安全紧急信息页面 | `/campus-emergency` |

#### 网络工具
| 工具 | 说明 | 后端路由 |
|------|------|---------|
| IP 查询 | 客户端 IP 信息与地理位置查询 | `/ip`, `/ip-location` |
| 短链接 | URL 短链生成与跳转管理 | `shortUrlRoutes` |
| IPFS 上传 | 文件上传至 IPFS 分布式存储 | `ipfsRoutes` |
| 图片上传 | 图片批量上传与管理 | `imageDataRoutes` |

### 8. 查询服务

| 服务 | 说明 | 前端路由 | 后端路由 |
|------|------|---------|---------|
| FBI 通缉犯查询 | 查询 FBI 通缉犯数据库 | `/fbi-wanted` | `fbiWantedRoutes` |
| 安踏防伪查询 | 安踏产品防伪验证 | `/anti-counterfeit` | `antaRoutes` |
| GitHub 账单查询 | GitHub Actions/Copilot 用量与账单 | `/github-billing` | `githubBillingRoutes` |
| LibreChat 监控 | LibreChat 镜像更新监控 | `/librechat` | `libreChatRoutes` |

### 9. 娱乐与游戏

| 游戏 | 说明 | 前端路由 |
|------|------|---------|
| 抽奖系统 | 完整的抽奖活动系统（含管理后台） | `/lottery`, `/admin/lottery` |
| 硬币翻转 | 随机硬币翻转小游戏 | `/coin-flip` |
| 老虎冒险 | 互动冒险小游戏 | `/tiger-adventure` |

### 10. 管理后台

> [!WARNING]
> 管理后台包含命令执行、环境变量修改等高权限操作。请确保 `ADMIN_PASSWORD` 使用强密码，并严格限制管理员账户的分发。

管理员专属功能。超级管理员（superadmin）可用全部模块；普通管理员（admin）的管理端范围收窄为「用户管理 / API Key / API Key 计费 / OAuth 管理」，由 fail-closed 的 `adminScope` 守卫按前缀放行。

| 功能 | 说明 | 前端组件 |
|------|------|---------|
| 管理仪表盘 | 系统概览、统计数据、快捷操作 | `AdminDashboard.tsx` |
| 用户管理 | 用户列表、角色分配、封禁/解封 | `UserManagement.tsx` |
| 公告管理 | 系统公告发布与管理（支持 Markdown/HTML） | `AnnouncementManager.tsx` |
| IP 封禁管理 | IP/CIDR 封禁规则管理 | `IPBanManager.tsx` |
| 环境变量管理 | 运行时环境变量查看与修改；含 Project Lumen 配置区（保管库 + 一键同步到 GitHub Actions Secrets） | `EnvManager.tsx` |
| 命令执行 | 远程命令执行控制台 | `CommandManager.tsx` |
| 调试控制台 | 系统调试与诊断工具 | `DebugInfoModal.tsx` |
| 数据收集管理 | 采集数据查看与管理 | `DataCollectionManager.tsx` |
| 审计日志 | 操作审计记录查看 | `AuditLogViewer.tsx` |
| 短链管理 | 短链接创建与管理 | `ShortLinkManager.tsx` |
| 指纹管理 | 设备指纹数据管理 | `FingerprintManager.tsx` |
| 系统管理 | 系统配置与维护 | `SystemManager.tsx` |
| 商店管理 | 资源商店后台管理 | `AdminStoreDashboard.tsx` |
| 抽奖管理 | 抽奖活动配置与管理 | `LotteryAdmin.tsx` |
| FBI 数据管理 | FBI 通缉犯数据管理 | `FBIWantedManager.tsx` |
| LibreChat 管理 | LibreChat 集成管理 | `LibreChatAdminPage.tsx` |
| Webhook 管理 | Webhook 事件查看与管理 | `WebhookEventsManager.tsx` |
| 篡改检测演示 | 前端篡改保护演示 | `TamperDetectionDemo.tsx` |
| 人机验证控制台 | 供应商上下线、场景权重/优先级/粘性/灰度、组件外观、月度额度与用量 | `CaptchaProviderAdmin.tsx` |
| 政策同意记录 | 政策同意记录只读查看、版本/来源分布、逐条审计与 CSV 导出 | `PolicyConsentPanel.tsx` |
| B 站数据管理 | B 站登录期 cookie 上报与账号绑定元数据（仅密文，无明文导出） | `BilibiliDataAdmin.tsx` |

### 11. 网络与集成

| 模块 | 说明 |
|------|------|
| LibreChat 集成 | LibreChat 镜像版本监控与数据同步 |
| Cloudflare Worker | 可选的边缘计算部署分发包 |
| IPFS 集成 | 分布式文件存储上传 |
| Svix Webhook | 企业级 Webhook 事件分发 |
| Resend 邮件 | 现代邮件发送 API 集成 |
| OpenAI API | TTS 语音合成 API 调用 |
| Redis 缓存 | 可选的 Redis 缓存层 |
| 推荐系统 | 内容推荐引擎 |
| 邀请系统 | 用户邀请码机制 |

### 12. UI 演示中心

内置多个 UI 设计演示页面，展示前端组件能力。

| 演示 | 说明 | 前端路由 |
|------|------|---------|
| 演示中心 | 所有演示的入口页面 | `/demo` |
| 小红书风格 | 小红书 App UI 复刻 | `/demo/xiaohongshu` |
| 冥想应用 | 冥想 App UI 设计 | `/demo/meditation` |
| 音乐播放器 | 音乐播放器 UI 设计 | `/demo/music` |
| 金融应用 | 金融 App UI 设计 | `/demo/finance` |

---

## 🛠 技术栈

### 后端

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js 24+ |
| 框架 | Express.js 5.x |
| 语言 | TypeScript 6.0 |
| 数据库 | MongoDB 7 + Mongoose 9 |
| 缓存 | Redis 5 |
| 认证 | JWT (jsonwebtoken) + WebAuthn (@simplewebauthn) + TOTP (speakeasy) |
| AI 集成 | OpenAI SDK 6 |
| 邮件 | Resend API |
| Webhook | Svix |
| 文件处理 | Multer 2, tar, JSZip |
| 验证 | Zod 4, Validator.js |
| 安全 | Helmet 8, CORS, DOMPurify, bcrypt 6 |
| 加密 | CryptoJS, nanoid, uuid |
| 日志 | Winston 3 |
| API 文档 | Swagger (swagger-jsdoc + swagger-ui-express) |
| 爬虫/解析 | Cheerio, JSDOM |
| WebSocket | ws 8 |
| 代码混淆 | javascript-obfuscator 5 |
| 测试 | Jest 30 + Supertest 7 |
| 代码质量 | Biome 2.4 |

### 前端

| 类别 | 技术 |
|------|------|
| 框架 | React 19 |
| 构建工具 | Vite 8 |
| 语言 | TypeScript 6.0 |
| 路由 | React Router 7 |
| 样式 | Tailwind CSS 4 + PostCSS |
| 动画 | Framer Motion 12 |
| UI 组件 | Radix UI, Lucide React, Heroicons, React Icons |
| 图表 | Chart.js 4 + react-chartjs-2 |
| Markdown | react-markdown, marked, KaTeX, Mermaid |
| 代码高亮 | Prism.js, react-syntax-highlighter |
| HTTP 客户端 | Axios |
| 通知 | react-toastify |
| 文档导出 | jsPDF, docx, html2canvas |
| 二维码 | qrcode.react |
| 指纹识别 | @fingerprintjs/fingerprintjs |
| 行为分析 | @microsoft/clarity |
| 测试 | Vitest 4 + Testing Library |

### DevOps

| 类别 | 技术 |
|------|------|
| 容器化 | Docker（多阶段构建）+ Docker Compose |
| 包管理 | pnpm |
| 代码混淆 | javascript-obfuscator |
| API 文档 | Swagger/OpenAPI |
| 边缘计算 | Cloudflare Workers 分发包（可选） |
| CI/CD | GitHub Actions |

---

## 📁 项目结构

```
Synapse/
├── src/                              # 后端源代码
│   ├── app.ts                        # 应用入口（路由注册、中间件配置、服务器启动）
│   ├── config.ts                     # 主配置文件
│   ├── config/                       # 配置模块
│   │   ├── config.ts                 # 应用配置
│   │   ├── env.ts                    # 环境变量解析
│   │   └── index.ts                  # 配置导出
│   ├── controllers/                  # 请求处理器（28 个）
│   │   ├── authController.ts         # 认证控制器
│   │   ├── ttsController.ts          # TTS 控制器
│   │   ├── adminController.ts        # 管理员控制器
│   │   ├── cdkController.ts          # CDK 控制器
│   │   ├── fbiWantedController.ts    # FBI 查询控制器
│   │   ├── lotteryController.ts      # 抽奖控制器
│   │   └── ...                       # 更多控制器
│   ├── routes/                       # API 路由（43 个路由文件）
│   │   ├── authRoutes.ts             # 认证路由
│   │   ├── ttsRoutes.ts              # TTS 路由
│   │   ├── adminRoutes.ts            # 管理路由
│   │   ├── resourceRoutes.ts         # 资源路由
│   │   ├── shortUrlRoutes.ts         # 短链路由
│   │   └── ...                       # 更多路由
│   ├── services/                     # 业务逻辑服务（50+ 个）
│   │   ├── ttsService.ts             # TTS 服务
│   │   ├── userService.ts            # 用户服务
│   │   ├── mongoService.ts           # MongoDB 连接管理
│   │   ├── redisService.ts           # Redis 缓存服务
│   │   ├── passkeyService.ts         # Passkey 认证服务
│   │   ├── smartHumanCheckService.ts # 智能人机验证
│   │   ├── emailService.ts           # 邮件服务
│   │   ├── wsService.ts              # WebSocket 服务
│   │   ├── schedulerService.ts       # 定时任务服务
│   │   └── ...                       # 更多服务
│   ├── middleware/                    # 中间件（22 个）
│   │   ├── authenticateToken.ts      # JWT 认证
│   │   ├── corsMiddleware.ts         # CORS 配置
│   │   ├── wafMiddleware.ts          # WAF 防火墙
│   │   ├── ipBanCheck.ts             # IP 封禁检查
│   │   ├── routeLimiters.ts          # 路由限流器
│   │   ├── tamperProtection.ts       # 篡改保护
│   │   ├── replayProtection.ts       # 重放保护
│   │   └── ...                       # 更多中间件
│   ├── models/                       # Mongoose 数据模型（19 个）
│   ├── types/                        # TypeScript 类型定义
│   ├── utils/                        # 工具函数
│   ├── templates/                    # 邮件模板
│   ├── scripts/                      # 后端脚本
│   └── tests/                        # 后端测试文件（50+ 个）
│
├── frontend/                         # 前端源代码
│   ├── src/
│   │   ├── App.tsx                   # 主应用（路由定义、全局状态）
│   │   ├── main.tsx                  # 入口文件
│   │   ├── components/               # React 组件（100+ 个）
│   │   │   ├── TtsPage.tsx           # TTS 主页面
│   │   │   ├── AdminDashboard.tsx    # 管理仪表盘
│   │   │   ├── LoginPage.tsx         # 登录页
│   │   │   ├── ResourceStoreList.tsx # 资源商店
│   │   │   ├── LotteryPage.tsx       # 抽奖页面
│   │   │   ├── FBIWantedPublic.tsx   # FBI 查询
│   │   │   ├── DemoHub.tsx           # 演示中心
│   │   │   └── ...                   # 更多组件
│   │   ├── hooks/                    # 自定义 Hooks
│   │   ├── api/                      # API 调用封装
│   │   ├── types/                    # TypeScript 类型
│   │   ├── utils/                    # 工具函数
│   │   ├── styles/                   # 样式文件
│   │   └── config/                   # 前端配置
│   ├── docs/                         # 已退役占位目录
│   ├── vite.config.ts                # Vite 构建配置
│   ├── tailwind.config.js            # Tailwind CSS 配置
│   ├── vitest.config.ts              # Vitest 测试配置
│   └── package.json
│
├── data/                             # 运行时数据目录
│   ├── blocked-ips.json              # IP 封禁列表
│   ├── chat_history.json             # 聊天历史
│   ├── logs/                         # 应用日志
│   ├── exports/                      # 数据导出文件
│   ├── sharelogs/                    # 分享日志
│   ├── poetry/                       # 诗词文库
│   └── ...
│
├── docs/                             # 文档
│   ├── audit/                       # 审计报告与代码审查
│   └── ...
├── scripts/                          # 运维脚本（40+ 个）
├── secrets/                          # 签名密钥与服务凭证
├── Dockerfile                        # 多阶段 Docker 构建
├── docker-compose.yml                # Docker Compose 编排
├── package.json                      # 后端依赖与脚本
├── tsconfig.json                     # TypeScript 配置
├── jest.config.js                    # Jest 测试配置
├── biome.json                        # Biome 代码质量配置
└── openapi.json                      # OpenAPI 3.0 文档
```

---

## 🚀 快速开始

> [!IMPORTANT]
> 开始之前，请确保已阅读 [LICENSE](LICENSE) 并同意其条款。

### 前置要求

- Node.js 24+（与 Docker 镜像运行时一致）
- pnpm 11.x（推荐）或 npm
- MongoDB（必需，用于用户数据存储）
- Redis（可选，用于缓存加速）

### 安装依赖

```bash
# 安装后端依赖
pnpm install

# 安装前端依赖
cd frontend && pnpm install && cd ..

```

### 开发模式

```bash
# 同时启动后端 + 前端开发服务器
pnpm run dev

# 或分别启动
pnpm run dev:backend      # 后端: http://localhost:3000
pnpm run dev:frontend     # 前端: http://localhost:3001（Vite HMR）

```

### 生产构建

```bash
# 完整构建（后端 + 前端）
pnpm run build

# 简化构建（跳过部分优化）
pnpm run build:simple

# 最小化构建（最快速度）
pnpm run build:minimal

# 仅构建后端（含代码混淆）
pnpm run build:backend

# 仅构建前端
pnpm run build:frontend

# 启动生产服务器
pnpm start
```

### Docker 部署

> [!TIP]
> 推荐使用 Docker Hub 上的预构建镜像 [`happyclo/tts-node:latest`](https://hub.docker.com/r/happyclo/tts-node/tags)，无需本地构建，直接拉取即可运行。

```bash
# 使用 Docker Compose（推荐）
docker-compose up -d

# 手动构建镜像
docker build -t Synapse:latest .

# 运行容器
docker run -d \
  -p 3000:3000 \
  --env-file .env \
  -v ./data:/app/data \
  Synapse:latest

# 查看日志
docker-compose logs -f app
```

Docker 镜像采用 3 阶段构建：
1. **frontend-builder** - 前端 React 应用构建
2. **backend-builder** - TypeScript 编译 + 代码混淆 + OpenAPI 生成
3. **production** - 精简运行时镜像（Alpine + 生产依赖）

生产镜像默认只监听 `3000` 端口，后端 Express 在同一端口提供 API、前端 SPA 和 Swagger UI。`3001` 仅用于本地前端开发模式。

---

## 🔧 环境配置

> [!CAUTION]
> `.env` 文件包含 API 密钥、数据库凭证等敏感信息，**绝对不要**将其提交到版本控制系统。请确保 `.env` 已添加到 `.gitignore` 中。

### 首次部署必读

首次部署时，以下变量**必须正确配置**，否则应用会拒绝启动或关键功能不可用：

| 变量 | 必须 | 说明 |
|------|------|------|
| `MONGO_URI` 或 `MONGODB_URI` | **是** | MongoDB 连接串，缺少时应用启动报错 |
| `JWT_SECRET` | **生产环境是** | 缺少时自动生成临时密钥，进程重启后所有已签发的 JWT 失效 |
| `ADMIN_PASSWORD` | **生产环境是** | 缺少时管理员无法登录；开发环境默认 `admin` |
| `OPENAI_API_KEY` 或 `OPENAI_KEY` | **TTS 功能是** | TTS 核心功能依赖 |

### 后端环境变量（`.env`）

```env
# ==================== 服务器基础 ====================
NODE_ENV=development               # 运行环境: development | production | test
PORT=3000                          # 后端监听端口（默认 3000）
TZ=Asia/Shanghai                   # 时区（默认 Asia/Shanghai）
BASE_URL=                          # 公开访问地址，用于 OIDC Discovery 端点
FRONTEND_URL=                      # 前端地址，BASE_URL 的备选
TRUST_PROXY=                       # 反向代理信任层级（如 "1" 或 "loopback"）

# ==================== 数据库（必须） ====================
MONGO_URI=mongodb://user:pass@host:27017/tts?authSource=admin
MONGODB_URI=                       # MONGO_URI 的别名，两者选一
MONGO_DB=tts                       # 连接串未指定 database 时自动补全的库名
MONGO_PROXY_URL=                   # 可选 socks/http 代理地址

# ==================== Redis（强烈推荐） ====================
REDIS_URL=redis://localhost:6379   # 启用后：IP 封禁存 Redis、限流更高效、缓存加速

# ==================== 认证与安全（必须） ====================
JWT_SECRET=your-jwt-secret         # JWT 签名密钥，生产环境必填（不填则每次重启随机生成）
JWT_EXPIRES_IN=30d                 # JWT 有效期（默认 30d，支持 30d/12h/90m）
ADMIN_USERNAME=admin               # 管理员用户名（默认 admin）
ADMIN_PASSWORD=admin               # 管理员密码，生产环境必填
ADMIN_OPERATION_PASSWORD=          # 管理操作密码（可选，不填时与 ADMIN_PASSWORD 相同）
SERVER_PASSWORD=1145               # 服务器状态查询接口 POST /server_status 密码
SIGN_SECRET_KEY=                   # 签名密钥（用于 Short URL 等签名）
AES_KEY=                           # AES 加密密钥（用于敏感数据加密，缺省时使用 JWT_SECRET）
GENERATION_CODE=                   # 注册生成码（不填则注册功能受限）

# ==================== TTS 核心功能 ====================
# OpenAI TTS（至少配置一个 Key）
OPENAI_API_KEY=sk-xxx              # OpenAI API 密钥
OPENAI_KEY=                        # 别名，OPENAI_API_KEY 未设置时生效
OPENAI_BASE_URL=https://api.openai.com/v1  # OpenAI API 地址，支持自定义代理
OPENAI_MODEL=tts-1                 # TTS 模型（默认 tts-1）
OPENAI_VOICE=alloy                 # 默认语音（默认 alloy）
OPENAI_RESPONSE_FORMAT=mp3         # 输出格式（默认 mp3）
OPENAI_SPEED=1.0                   # 语速（默认 1.0）

# Fish Audio TTS（可选，替代 OpenAI TTS）
TTS_PROVIDER=                      # 默认 TTS 提供商（留空 = OpenAI）
FISH_AUDIO_API_KEY=                # Fish Audio API 密钥
FISH_AUDIO_BASE_URL=               # Fish Audio API 地址
FISH_AUDIO_REFERENCE_ID=           # Fish Audio 音色参考 ID
FISH_AUDIO_MODEL=                  # Fish Audio 模型

# ==================== WebAuthn / Passkey ====================
RP_ID=localhost                    # Relying Party ID（域名，必须与访问域名一致）
RP_ORIGIN=http://localhost:3001    # Relying Party Origin（完整 URL）
RP_ORIGIN_MODE=                    # Origin 模式（前端框架专用）
WEBAUTHN_RP_ID=                    # 备选，与 RP_ID 相同用途
WEBAUTHN_EXPECTED_ORIGIN=          # 备选，与 RP_ORIGIN 相同用途

# ==================== 邮件服务（Resend） ====================
RESEND_API_KEY=re_xxx              # Resend API 密钥（内部邮件）
RESEND_DOMAIN=example.com          # 发件域名
RESEND_QUOTA_TOTAL=100             # 每日配额（默认 100）
OUTEMAIL_ENABLED=true              # 启用对外邮件 API
OUTEMAIL_DOMAIN=example.com        # 对外邮件域名
OUTEMAIL_API_KEY=re_xxx            # 对外邮件 API 密钥
OUTEMAIL_QUOTA_TOTAL=100           # 对外邮件每日配额（默认 100）

# ==================== Cloudflare Turnstile ====================
TURNSTILE_SITE_KEY=0x4xxx          # Turnstile 站点密钥
TURNSTILE_SECRET_KEY=0x4xxx        # Turnstile 服务端密钥
TURNSTILE_DEV_AUTO_PASS=           # 开发模式自动通过验证（true/false）
TURNSTILE_DEV_AUTO_ACCESS=         # 开发模式自动放行（true/false）

# ==================== 安全防护 ====================
WAF_ENABLED=true                   # WAF Web 应用防火墙（默认 true）
SMART_HUMAN_CHECK_SECRET=change-me  # 智能人机验证主密钥（至少 16 字符）
SMART_HUMAN_CHECK_DEFAULT_ACTION=  # 默认动作（allow / deny / pow）
SMART_HUMAN_CHECK_POW_DIFFICULTY=  # PoW 难度（默认值 50000）
ENABLE_FIRST_VISIT_VERIFICATION=   # 首次访问验证的启动默认值（true/false；运行时请在 env-manager「首访验证闸门」分区配置）
AUDIT_LOG_MASKING=                 # 审计日志脱敏（默认 true）
EXEMPTED_DOMAINS=                  # 豁免域名列表（逗号分隔）
INTERNAL_DOMAINS=                  # 内部域名列表（逗号分隔）
ALLOWED_ORIGINS=                   # 额外允许的 CORS 域名（逗号分隔）
IP_WHITELIST=                      # IP 白名单（逗号分隔）

# ==================== Google / OAuth 登录 ====================
GOOGLE_CLIENT_ID=                  # Google Identity Services 客户端 ID
NEXAI_GOOGLE_CLIENT_ID=            # NexAI Google 登录客户端 ID
NEXAI_GITHUB_CLIENT_ID=            # NexAI GitHub 登录客户端 ID
NEXAI_GITHUB_CLIENT_SECRET=        # NexAI GitHub 登录客户端 Secret
NEXAI_FRONTEND_URL=                # NexAI 前端地址
NEXAI_WEBAUTHN_RP_ID=              # NexAI WebAuthn 域名
NEXAI_WEBAUTHN_ALLOWED_ORIGINS=    # NexAI WebAuthn 允许来源
NEXAI_WEBAUTHN_EXPECTED_ORIGINS=   # NexAI WebAuthn 期望来源

# ==================== LINUX DO 集成 ====================
# OAuth 登录
LINUXDO_CLIENT_ID=                 # LinuxDo OAuth Client ID
LINUXDO_CLIENT_SECRET=             # LinuxDo OAuth Client Secret
# Credit 积分支付
LINUXDO_CREDIT_ENABLED=            # 启用积分支付
LINUXDO_CREDIT_PID=                # 商户 PID
LINUXDO_CREDIT_KEY=                # 商户密钥
LINUXDO_CREDIT_PROTOCOL=epay       # 协议（epay / ldc）
LINUXDO_CREDIT_GATEWAY_BASE=       # 网关地址
LINUXDO_CREDIT_PRIVATE_KEY=        # 私钥
LINUXDO_CREDIT_RATE=               # 汇率
LINUXDO_CREDIT_MAX_MONEY=          # 单笔最大金额
LINUXDO_CREDIT_NOTIFY_URL=         # 异步通知 URL
LINUXDO_CREDIT_RETURN_URL=         # 同步跳转 URL

# ==================== LibreChat 集成 ====================
CHAT_BASE_URL=https://chat.example.com  # LibreChat 地址
CHAT_API_KEY=sk-xxx                    # LibreChat API 密钥
CHAT_MODEL=                            # 默认模型
CHAT_WIRE=openai-chat                  # 无 DB provider 时的默认线格式:openai-chat|openai-responses|anthropic

# ==================== 内容安全（可选） ====================
CONTENT_SAFETY_ENABLED=            # 启用内容安全过滤
CONTENT_FILTER_API_URL=            # 内容过滤 API 地址
SKIP_CONTENT_FILTER=               # 跳过内容过滤
DISABLE_SENSITIVE_FILTER=          # 禁用敏感词过滤

# ==================== 图床上传 ====================
IPFS_UPLOAD_URL=                   # IPFS 上传地址
IPFS_UA=                           # IPFS 请求 User-Agent
IPFS_ALLOW_ALL_FILE_TYPES=         # 允许所有文件类型
IMAGE_BED_API_URL=                 # 图床 API 地址（默认 https://img.scdn.io/api/v1.php）
IMAGE_BED_CDN_DOMAIN=              # 图床 CDN 域名
IMAGE_BED_STORAGE_DESTINATION=     # 存储目标（local / telegram / r2）

# ==================== 其他 ====================
TTS_REQUIRE_POLICY_CONSENT=        # TTS 使用前需要同意政策（true/false）
AUTH_REQUIRE_POLICY_CONSENT=       # 登录/注册必须逐项同意四份政策文件（true/false；生产默认 true，测试环境固定关闭）
TTS_DOWNLOADS_ENABLED=             # 启用 TTS 下载（true/false）
TTS_ASSET_SHARE_ENABLED=           # 启用 TTS 资产分享（true/false）
TTS_PUBLIC_STATIC_AUDIO_ENABLED=   # 启用公共静态音频访问（true/false）
TTS_QUEUE_CONCURRENCY=             # TTS 队列并发数
REGISTRATION_INVITE_REQUIRED=      # 注册需要邀请码的启动默认值（true/false；运行时请在 env-manager「注册邀请码」分区配置）
ACCESS_LOG_ENABLED=                # 启用访问日志（true/false）
VERBOSE_LOGGING=                   # 详细日志模式（true/false）
POLICY_VERSION=                    # 当前政策版本号
POLICY_CONSENT_VALIDITY_DAYS=      # 政策同意有效期（天）
POLICY_SECRET_SALT=                # 政策签名盐值
SERVE_FRONTEND=                    # 是否由后端托管前端静态文件（默认 true）
FRONTEND_DIST_DIR=                 # 前端构建产物目录（默认 frontend/dist）
OPENAPI_JSON_PATH=                 # OpenAPI JSON 输出路径（默认 openapi.json）
VITE_API_URL=                      # 前端 API 地址（BASE_URL 未设置时作为后备）
PUBLIC_SHORT_URL_ENABLED=          # 启用公共短链接（true/false）
PUBLIC_SHORT_URL_PASSWORD=         # 公共短链接创建密码

# ==================== 文档转换（doc-tool·可选） ====================
DOC_TOOL_WORK_DIR=                 # 工作目录（默认 data/doc-tool；收件箱 / 产物 / 参考样式模板都在它下面）
DOC_TOOL_PANDOC_BIN=               # pandoc 路径（留空自动探测 /usr/local/bin/pandoc → PATH）
DOC_TOOL_MAX_UPLOAD_BYTES=67108864 # 单次上传 .md 总大小上限（字节，默认 64 MB）
DOC_TOOL_MAX_FILE_BYTES=8388608    # 单个 .md 大小上限（字节，默认 8 MB）
DOC_TOOL_MAX_FILES_PER_JOB=300     # 单任务最多处理文件数（默认 300）
DOC_TOOL_MAX_ACTIVE_JOBS=3         # 每个用户同时在排队 / 运行的任务上限（默认 3）
DOC_TOOL_RETENTION_DAYS=7          # 产物保留天数（默认 7，与 Mongo TTL 一致）

# ==================== 短链热门查询缓存（可选·未配 Redis 时自动关闭） ====================
SHORT_URL_HOT_QUERY_THRESHOLD=3    # 计数窗口内查询次数超过该值才写进 Redis（默认 3）
SHORT_URL_HOT_WINDOW_MS=3600000    # 计数窗口（毫秒，默认 1 小时）
SHORT_URL_HOT_TTL_MS=600000        # 热点条目存活时长（毫秒，默认 10 分钟，命中即续期）

# ==================== Project Lumen GitHub Secret Sync（可选） ====================
# env-manager 的「Project Lumen 配置」区可将 13 个密钥/配置项同步到
# Project-Lumen 仓库的 GitHub Actions Secrets（Sealed Box 加密写入）。
# Token 需具备目标仓库 Actions secrets 写入权限（classic token 需 repo 权限，
# 或 fine-grained token 需 Secrets: write）。
PROJECT_LUMEN_GITHUB_OWNER=        # 目标仓库 Owner（如 Chloemlla）
PROJECT_LUMEN_GITHUB_REPO=         # 目标仓库名（如 Project-Lumen）
PROJECT_LUMEN_GITHUB_TOKEN=        # 具备 Actions secrets 写入权限的 PAT
```

### IP 与反向代理配置详解

与客户端 IP 识别、IP 封禁和访问控制相关的环境变量如下：

| 变量 | 说明 | 默认值 | 影响范围 |
|------|------|--------|---------|
| `TRUST_PROXY` | Express `trust proxy` 设置，决定 `req.ip` 的解析方式。**不设置时不信任任何代理**，`req.ip` 取 TCP 层真实 IP（`socket.remoteAddress`），客户端无法伪造 `X-Forwarded-For` 绕过封禁/限流。部署在 Nginx、Cloudflare 等反向代理后时**必须显式设置**，否则取到的是代理地址 | 不设置 = 不信任 | IP 封禁、限流、用量统计、审计日志中的客户端 IP 识别 |
| `IP_WHITELIST` | IP 白名单（逗号分隔）。非空时，IP 检查中间件（`src/middleware/ipCheck.ts`）只放行名单内的 IP，其余返回 403；本地/内网 IP（127.0.0.1、`10.x`、`192.168.x`、`172.16-31.x` 等）始终放行 | 空 = 不过滤 | `ipCheckMiddleware` 访问控制 |
| `PORT` | 后端监听端口，绑定 `::`（IPv6 双栈，监听所有网卡）。**没有** `HOST`/`BIND` 监听地址变量 | 3000 | 服务监听地址 |
| `REDIS_URL` | 设置后 IP 封禁存储于 Redis，否则存 MongoDB；同时启用限流与缓存加速 | 空 | IP 封禁存储、限流、缓存 |
| `MONGO_PROXY_URL` | MongoDB 连接的 socks/http 代理地址 | 空 | MongoDB 连接通道 |

**`TRUST_PROXY` 取值说明**：

| 取值 | 效果 |
|------|------|
| 不设置 | `false`，不信任任何代理（生产环境会打印 WARNING 提示） |
| `false` / `0` / `no` / `off` | 关闭 |
| `true` / `yes` / `on` | 信任所有代理（直接采用 XFF） |
| 整数（如 `1`） | 信任 N 跳反向代理 |
| 逗号分隔的 IP 列表 | 只信任列出的代理 IP |
| 单个 IP | 只信任该代理 IP |

> [!NOTE]
> 名字带 "IP" 但**与 IP 地址无关**的变量：`IPFS_UPLOAD_URL`、`IPFS_UA` 等属于 **IPFS（星际文件系统）** 图床上传配置；`EXEMPTED_DOMAINS`、`INTERNAL_DOMAINS` 是域名豁免/内部域名列表；`ALLOWED_ORIGINS` 是 CORS 来源白名单。它们不影响客户端 IP 识别。

### 前端环境变量（`frontend/.env`）

前端编译时注入，构建后无法修改，需在构建前正确配置。

```env
VITE_API_URL=http://localhost:3000              # 后端 API 地址
VITE_WS_URL=ws://localhost:3000                 # WebSocket 地址
VITE_NODE_ENV=development                       # 运行环境
VITE_CLOUDFLARE_TURNSTILE_SITE_KEY=0x4xxx       # Turnstile 站点密钥
VITE_ENABLE_TURNSTILE=false                     # 是否启用 Turnstile
VITE_OUTEMAIL_ENABLED=true                      # 是否启用外部邮件功能
```

### 运行时可变配置

以下配置可通过管理后台动态修改，无需重启进程：

| 配置项 | 管理后台路径 | 说明 |
|--------|------------|------|
| IPQS | 管理后台 → IPQS | IP 质量评分配置 |
| LINUXDO | 管理后台 → LinuxDo | LinuxDo OAuth 配置 |
| GOOGLE_AUTH | 管理后台 → Google Auth | Google 认证配置 |
| DEEPLX | 管理后台 → DeepLX | DeepLX 翻译配置 |
| NEXAI | 管理后台 → NexAI | NexAI 平台配置 |
| NEXAI_SIGNING | 管理后台 → NexAI Signing | NexAI 请求签名配置 |
| CDICT_SIGNING | 管理后台 → CDict 官方客户端请求配置 | CDict 官方客户端的独立请求额度识别参数 |
| QQ_GUARD_SIGNING | 管理后台 → QQ 群纪律机器人 | QQ 群纪律机器人控制通道共享 HMAC 密钥（对应 QQ_GUARD_BOT_TOKEN） |
| TTS | 管理后台 → TTS | TTS 服务配置（模型、队列、配额等） |
| TTS_PROVIDER | 管理后台 → TTS Provider | TTS 提供商配置（Fish Audio 等） |
| EMAIL | 管理后台 → Email | 邮件服务配置 |
| ADMIN_SECURITY | 管理后台 → Admin Security | 管理后台安全配置 |
| SYNAPSE_ANDROID | 管理后台 → Android | Android 应用配置 |

### 快速部署清单

首次部署到生产环境时，请逐一确认以下配置：

```
[ ] MONGO_URI / MONGODB_URI      — MongoDB 已就绪
[ ] JWT_SECRET                    — 已设置（32+ 字符随机字符串）
[ ] ADMIN_PASSWORD                — 已设置强密码
[ ] OPENAI_API_KEY / OPENAI_KEY   — TTS 功能需要
[ ] RP_ID + RP_ORIGIN             — WebAuthn 域名正确
[ ] TURNSTILE_SITE_KEY + SECRET   — 人机验证
[ ] RESEND_API_KEY + DOMAIN       — 邮件发送
[ ] BASE_URL 或 FRONTEND_URL      — OAuth 回调正确
[ ] WAF_ENABLED=true              — 安全防护开启
[ ] SMART_HUMAN_CHECK_SECRET      — 人机验证密钥
[ ] NODE_ENV=production           — 生产模式
[ ] 所有密码已修改（非默认值）
```

### 安全提醒

> [!WARNING]
> 生产环境部署前，请务必修改所有默认密码（`ADMIN_PASSWORD`、`SERVER_PASSWORD`、`JWT_SECRET`），并确保 `WAF_ENABLED=true`。使用默认凭证部署将导致严重安全风险。

---

## 📚 API 文档

> [!NOTE]
> API 文档在开发模式下自动从路由注释生成。生产环境使用预生成的 `openapi.json` 文件，可通过 `pnpm run generate:openapi` 更新。

### 在线文档

- **Swagger UI**: `http://localhost:3000/api-docs` — 交互式 API 文档界面
- **OpenAPI JSON**: `http://localhost:3000/api/openapi.json` — OpenAPI 3.0 规范文件

### 主要 API 端点一览

#### 认证 (`/api/auth`)
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 用户注册 |
| POST | `/api/auth/login` | 用户登录 |
| POST | `/api/auth/logout` | 用户登出 |
| GET | `/api/auth/me` | 获取当前用户信息 |

#### TOTP 双因素 (`/api/totp`)
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/totp/status` | 获取 TOTP 启用状态 |
| POST | `/api/totp/setup` | 初始化 TOTP 设置 |
| POST | `/api/totp/verify` | 验证 TOTP 令牌 |

#### Passkey (`/api/passkey`)
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/passkey/register/start` | 开始 Passkey 注册 |
| POST | `/api/passkey/register/finish` | 完成 Passkey 注册 |
| POST | `/api/passkey/authenticate/start` | 开始 Passkey 认证 |
| POST | `/api/passkey/authenticate/finish` | 完成 Passkey 认证 |
| GET | `/api/passkey/credentials` | 获取已注册凭证列表 |

#### 文本转语音 (`/api/tts`)
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/tts/generate` | 生成语音 |
| GET | `/api/tts/history` | 获取生成历史 |

#### 资源商店 (`/api/resources`, `/api/cdks`)
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/resources` | 获取资源列表 |
| POST | `/api/resources` | 创建资源 |
| PUT | `/api/resources/:id` | 更新资源 |
| DELETE | `/api/resources/:id` | 删除资源 |
| POST | `/api/cdks/redeem` | CDK 兑换 |

#### 管理员 (`/api/admin`)
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/users` | 获取用户列表 |
| PUT | `/api/admin/users/:id` | 更新用户 |
| DELETE | `/api/admin/users/:id` | 删除用户 |
| GET | `/api/admin/announcement` | 获取系统公告 |

#### CDict 客户端代理 (`/api/cdict`)
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/cdict/translate` | 文本翻译（表单或 JSON：`text` / `from` / `to`），上游凭据与签名由服务端代持 |
| GET | `/api/cdict/languages` | 上游支持的语言列表 |
| GET | `/api/cdict/tts` | 单词/短语朗读，`source=engine` 走在线合成、`source=youdao` 走词典静态音频，返回音频字节 |
| GET | `/api/cdict/donate` | 赞赏渠道、说明文案与鸣谢名单（`{ notice, channels: [{ id, name, hint }], supporters: [] }`），关闭或无可用渠道时返回 404 |
| GET | `/api/cdict/donate/:channel` | 指定渠道的收款码：管理端填了图片地址就 302 跳到那个地址（原样下发，服务端不下载也不缓存图片字节，改地址即时生效）；地址留空时直接返回 `src/assets/donation/<id>.(png\|jpg)` 的字节。地址只接受外部图床 https 直链，本站地址、本接口自身与内网地址一律拒绝，避免跳转绕回本接口 |
| POST | `/api/cdict/donate/claim` | 提交赞赏署名申请（`transactionId` + `displayName`），开发者核实交易号后加入鸣谢名单；只落库这两项，不记录 IP 或设备信息，同一交易号幂等，单独限流每 IP 每小时 10 次 |

赞赏配置存在 `runtime_config_settings` 的 `CDICT_DONATION` 键（含渠道、文案与鸣谢名单），署名申请存在 `cdict_donation_claims` 集合，均由超级管理员在 env-manager 的「CDict 赞赏码配置」分区维护：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/admin/cdict-donation/setting` | 读取当前赞赏配置 |
| POST | `/api/admin/cdict-donation/setting` | 覆盖写入（超级管理员，带审计日志） |
| DELETE | `/api/admin/cdict-donation/setting` | 重置为内置默认（超级管理员，带审计日志） |
| GET | `/api/admin/cdict-donation/claims` | 读取待核实的署名申请 |
| DELETE | `/api/admin/cdict-donation/claims/:id` | 核实后删除该申请（超级管理员，带审计日志） |

#### 其他常用端点
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（含 MongoDB 状态、WebSocket 连接数） |
| GET | `/ip` | 获取客户端 IP 信息 |
| GET | `/ip-location` | IP 地理位置查询 |
| POST | `/server_status` | 服务器状态（需密码） |
| GET | `/api/frontend-config` | 前端配置 |

### 完整路由模块列表（43 个）

| 路由文件 | 挂载路径 | 功能 |
|---------|---------|------|
| `authRoutes` | `/api/auth` | 用户认证（登录、注册、登出） |
| `ttsRoutes` | `/api/tts` | 文本转语音服务 |
| `adminRoutes` | `/api/admin` | 管理员功能 |
| `passkeyRoutes` | `/api/passkey` | WebAuthn/Passkey 认证 |
| `totpRoutes` | `/api/totp` | TOTP 双因素认证 |
| `apiKeyRoutes` | `/api/apikeys` | API 密钥管理 |
| `resourceRoutes` | `/api` | 资源管理 |
| `cdkRoutes` | `/api/cdks` | CDK 激活码管理 |
| `lotteryRoutes` | `/api/lottery` | 抽奖系统 |
| `shortUrlRoutes` | `/s`, `/api/shorturl` | 短链接服务 |
| `emailRoutes` | `/api/email` | 内部邮件服务 |
| `outemailRoutes` | `/api/outemail` | 外部邮件服务 |
| `turnstileRoutes` | `/api/turnstile` | Turnstile 验证码 |
| `humanCheckRoutes` | `/api/human-check` | 智能人机验证 |
| `dataCollectionRoutes` | `/api/data-collection` | 数据收集 |
| `dataCollectionAdminRoutes` | `/api/data-collection/admin` | 数据收集管理 |
| `dataProcessRoutes` | `/api/data` | 数据处理 |
| `analyticsRoutes` | `/api/analytics` | 分析统计 |
| `networkRoutes` | `/api/network` | 网络工具 |
| `mediaRoutes` | `/api/media` | 媒体管理 |
| `socialRoutes` | `/api/social` | 社交功能 |
| `lifeRoutes` | `/api/life` | 生活工具 |
| `libreChatRoutes` | `/api/libre-chat`, `/api/librechat` | LibreChat 集成 |
| `commandRoutes` | `/api/command` | 命令执行 |
| `debugConsoleRoutes` | `/api/debug-console` | 调试控制台 |
| `logRoutes` | `/api` | 日志管理 |
| `statusRouter` | `/api/status` | 状态检查 |
| `policyRoutes` | `/api/policy` | 服务条款/隐私政策 |
| `tamperRoutes` | `/api/tamper` | 篡改检测 |
| `modlistRoutes` | `/api/modlist` | 模组列表 |
| `imageDataRoutes` | `/api/image-data` | 图片数据 |
| `ipfsRoutes` | `/api/ipfs` | IPFS 上传 |
| `fbiWantedRoutes` | `/api/fbi-wanted` | FBI 通缉犯查询 |
| `antaRoutes` | `/api/anta` | 安踏防伪查询 |
| `githubBillingRoutes` | `/api/github-billing` | GitHub 账单查询 |
| `miniapiRoutes` | `/api/miniapi` | 迷你 API 集合 |
| `recommendationRoutes` | `/api/recommendations` | 推荐系统 |
| `auditLogRoutes` | `/api/admin/audit-logs` | 审计日志 |
| `invitationRoutes` | `/api/invitations` | 邀请系统 |
| `workspaceRoutes` | `/api/workspaces` | 工作区管理 |
| `webhookRoutes` | `/api/webhooks` | Webhook 接收 |
| `webhookEventRoutes` | `/api/webhook-events` | Webhook 事件管理 |
| `cdictRoutes` | `/api/cdict` | CDict 客户端代理（翻译 / 语言列表 / 朗读 / 赞赏码） |

---

## 👨‍💻 开发指南

### 项目脚本

```bash
# ========== 开发 ==========
pnpm run dev                # 同时启动后端 + 前端
pnpm run dev:backend        # 仅启动后端（nodemon 热重载）
pnpm run dev:frontend       # 仅启动前端（Vite HMR）

# ========== 构建 ==========
pnpm run build              # 完整构建（后端 + 前端）
pnpm run build:simple       # 简化构建
pnpm run build:minimal      # 最小化构建
pnpm run build:backend      # 后端编译 + 代码混淆
pnpm run build:frontend     # 前端 Vite 构建

# ========== 测试 ==========
pnpm run test               # 运行所有后端测试
pnpm run test:coverage      # 生成测试覆盖率报告
pnpm run test:watch         # 监听模式测试
pnpm run test:verbose       # 详细输出测试
pnpm run test:auth          # 仅测试认证模块
pnpm run test:ci            # CI 环境测试

# ========== 代码质量 ==========
pnpm run generate:openapi   # 生成 OpenAPI 文档
pnpm run check:openapi-drift # 检查已声明的路由路径是否都进了 openapi.json
pnpm run check:unused-deps  # 检查未使用的依赖
pnpm run check:tree-shaking # 检查 Tree Shaking 效果

# ========== 分析 ==========
pnpm run analyze:bundle     # 后端打包体积分析
pnpm run analyze:frontend   # 前端打包体积分析
pnpm run analyze:full       # 完整打包分析

# ========== Docker ==========
pnpm run docker:build       # 构建 Docker 镜像（Linux/macOS）
pnpm run docker:build:win   # 构建 Docker 镜像（Windows）
pnpm run docker:build:simple   # 简化 Docker 构建（4GB 内存限制）
pnpm run docker:build:minimal  # 最小化 Docker 构建（2GB 内存限制）

# ========== 生产 ==========
pnpm run prod               # 构建并启动生产服务器
pnpm start                  # 启动生产服务器（3000 端口提供 API + 前端 + Swagger UI）
```

### 前端脚本

```bash
cd frontend

pnpm run dev                # Vite 开发服务器
pnpm run build              # 生产构建
pnpm run build:analyze      # 构建并生成 Bundle 分析
pnpm run preview            # 预览构建产物
pnpm run test               # Vitest 测试
pnpm run analyze:bundle     # Bundle 体积分析
```

### 常见开发任务

#### 添加新的 API 端点

1. 在 `src/routes/` 中创建路由文件，定义 HTTP 方法和路径
2. 在 `src/controllers/` 中创建控制器，处理请求逻辑
3. 在 `src/services/` 中实现业务逻辑（可选）
4. 在 `src/models/` 中定义 Mongoose 数据模型（如需数据库）
5. 在 `src/app.ts` 中注册路由并绑定限流器
6. 运行 `pnpm run generate:openapi` 更新 API 文档

#### 添加新的前端页面

1. 在 `frontend/src/components/` 中创建页面组件
2. 在 `frontend/src/App.tsx` 中添加懒加载导入和 `<Route>` 定义
3. 在 `routeConfig.titles` 中添加页面标题映射
4. 如需导航入口，在 `MobileNav` 组件中添加链接

#### 添加数据库模型

1. 在 `src/models/` 中定义 Mongoose Schema 和 Model
2. 在对应的 Service 中引入并使用模型
3. MongoDB 连接由 `mongoService.ts` 统一管理

### 数据模型一览（19 个）

| 模型 | 说明 |
|------|------|
| `accessTokenModel` | 访问令牌 |
| `apiKeyModel` | API 密钥 |
| `archiveModel` | 归档数据 |
| `auditLogModel` | 审计日志 |
| `cdkModel` | CDK 激活码 |
| `collaborationSessionModel` | 协作会话 |
| `fbiWantedModel` | FBI 通缉犯数据 |
| `invitationModel` | 邀请码 |
| `ipBanModel` | IP 封禁记录 |
| `policyConsentModel` | 政策同意记录 |
| `recommendationHistoryModel` | 推荐历史 |
| `resourceModel` | 资源数据 |
| `shortUrlModel` | 短链接 |
| `tempFingerprintModel` | 临时指纹 |
| `userPreferencesModel` | 用户偏好 |
| `verificationTokenModel` | 验证令牌 |
| `versionModel` | 版本控制 |
| `voiceProjectModel` | 语音项目 |
| `workspaceModel` | 工作区 |

---

## 🔐 安全特性

> [!WARNING]
> 生产环境部署前，请务必修改所有默认密码（`ADMIN_PASSWORD`、`SERVER_PASSWORD`、`JWT_SECRET`、`AES_KEY`），并启用 WAF（`WAF_ENABLED=true`）。使用默认凭证部署将导致严重安全风险。

### 多层防护架构

```
请求 → IP 封禁检查 → WAF 防火墙 → 速率限制 → CORS 校验 → JWT 认证 → 业务逻辑
                                                                    ↓
                                                              篡改检测 / 重放保护
```

| 安全层 | 技术实现 | 说明 |
|-------|---------|------|
| HTTPS/TLS | Helmet HSTS | 强制 HTTPS，HSTS 预加载 |
| 安全头 | Helmet | CSP、X-Frame-Options、X-Content-Type-Options 等 |
| CORS | 自定义中间件 | 严格的跨域资源共享策略，按路由差异化配置 |
| WAF | `wafMiddleware.ts` | Web 应用防火墙，检测 SQL 注入、XSS 等攻击 |
| IP 封禁 | `ipBanCheck.ts` + Redis | 自动/手动 IP 封禁，支持 CIDR 段，Redis 同步 |
| 速率限制 | express-rate-limit | 37 个独立限流器，按路由粒度配置 |
| JWT 认证 | jsonwebtoken | Token 签发与验证，支持可选认证 |
| 密码加密 | bcrypt | 密码哈希存储 |
| 输入验证 | Zod + Validator.js | 请求参数校验与清理 |
| XSS 防护 | DOMPurify | HTML 内容净化 |
| 篡改检测 | `tamperProtection.ts` | 前端关键元素完整性保护 |
| 重放保护 | `replayProtection.ts` + Nonce | 防止请求重放攻击 |
| 代码混淆 | javascript-obfuscator | 生产环境后端代码混淆 |
| 信息隐藏 | 移除 X-Powered-By/Server 头 | 隐藏服务器技术栈信息 |

---

## 📊 监控与日志

### 日志系统

- **日志库**: Winston 3
- **日志目录**: `data/logs/`（按日期分文件）、`logs/`（combined + error）
- **日志级别**: error → warn → info → debug
- **请求日志**: 所有请求自动记录（开发环境含完整 headers/body）

### 健康检查

```bash
curl http://localhost:3000/health
```

```json
{
  "status": "ok",
  "uptime": 3600,
  "mongo": "connected",
  "wsConnections": 5,
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

### 性能监控

| 工具 | 说明 |
|------|------|
| Microsoft Clarity | 前端用户行为分析（自动初始化，后端配置） |
| Bundle 分析 | `pnpm run analyze:frontend` / `pnpm run analyze:bundle` |
| 服务器状态 | `POST /server_status`（CPU、内存、运行时间） |
| WebSocket 监控 | 实时连接数统计 |

### 定时任务

`schedulerService.ts` 提供定时任务调度，服务器启动时自动运行。

---

## 🐳 部署

> [!TIP]
> 最快的部署方式：直接使用 Docker Hub 预构建镜像，无需本地编译。
> ```bash
> docker pull happyclo/tts-node:latest
> ```

### Docker Compose 部署（推荐）

```yaml
# docker-compose.yml
version: "3.8"
services:
  app:
    image: happyclo/tts-node:latest
    ports:
      - "3000:3000"   # API + 前端 SPA + Swagger UI
    environment:
      - NODE_ENV=production
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - OPENAI_BASE_URL=${OPENAI_BASE_URL}
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

```bash
docker-compose up -d
```

### 端口说明

| 场景 | 端口 | 服务 |
|------|------|------|
| 开发 | 3000 | 后端 API + Swagger UI |
| 开发 | 3001 | 前端 React 应用（Vite HMR） |
| 生产/Docker | 3000 | API + 前端 SPA + Swagger UI |

### 网络工具部署原则

### Cloudflare Worker 部署（可选）

> [!NOTE]
> Cloudflare Worker 为可选的边缘部署方案，不提供预构建分发包。如需部署，请参考仓库中的 `frontend/` 构建产物自行配置 Wrangler。

---

## 📝 更新日志

按 commit 整理的 2025 年 1 月起变更记录（合并同类项，省略纯依赖 bump / merge / 任务归档类提交）。仓库在 2025-02 至 2025-05 无提交。

### 2025-01

#### 01-04
- 大幅更新早期 Python 入口 `app.py`（+542 / -113）
- 增加 Resend 邮件发送、Markdown / BeautifulSoup 解析能力
- 新增 `/email`、`/bili-done`、`/ip` 等 Flask 接口
- 增加 IP 归属查询、本地缓存与失败密码尝试限流
- 优化日志编码、OpenAI TTS 界面控件与请求前拦截逻辑

### 2025-02

- 本月无提交记录

### 2025-03

- 本月无提交记录

### 2025-04

- 本月无提交记录

### 2025-05

- 本月无提交记录


### 2025-06

#### 06-15 ~ 06-17
- 项目重构为 Node.js 全栈结构，清理无用文件
- 搭建环境变量、代理与 CI 依赖安装流程
- 实现 IP 限流与更稳健的 IP 识别
- 前端接入 React Router，重构 App 与 TTS 页面
- 登录改为 identifier，完善注册登录错误处理
- TTS 增加重复内容检测、生成码校验、文本长度限制与混淆构建

#### 06-18 ~ 06-20
- 新增 IP 归属查询、缓存、重试与宕机容错
- 增加服务状态接口、隐私政策 / 服务条款页
- 后端代码混淆，前端补充 Footer 与调试快捷键限制
- TTS 增加数据签名校验与 CSP / 篡改防护
- 强化密码强度、CORS、输入消毒与 Token 认证
- 新增公网 IP 获取 / 上报与上报限流白名单

#### 06-21 ~ 06-26
- 新增用户管理与管理员接口限流
- 实现 TOTP 双因素认证与备份码
- 增加移动端导航与 API 文档（Swagger / OpenAPI）
- 多服务器部署、日志分享 / 查询与上传历史

#### 06-28 ~ 06-29
- 接入 Docusaurus 文档站与博客
- 前端增加页面切换动画、粒子背景与技术栈展示
- 增强扩展检测、水印覆盖、完整性校验与反调试能力

### 2025-07

#### 07-03 ~ 07-08
- 前端测试切换 Vitest，优化 TOTP / TTS UI 与错误处理
- 引入动态 API Base URL，并增强限流与危险关键词过滤
- 用 Passkey 取代旧 WebAuthn 路径，完善 credentialID 修复与校验
- 支持多 2FA 方式，修复命令注入，并补充网络 / PublicIP API
- 增加代码分割、JWT 认证与 AudioPreview / Passkey 体验优化

#### 07-09 ~ 07-15
- 用户存储支持 MongoDB，后续补齐 MySQL 与使用量统计
- 新增 CaseConverter、Cloudflare Turnstile（可开关）与 hCaptcha 简化实现
- 管理端邮件发送、注册邮箱验证、多发件域名与邮件配额
- 强化 IP 查询 SSRF 防护，新增用户主页与 TTS 内容去重存储

#### 07-16 ~ 07-25
- 新增管理后台、响应式导航与 MiniAPI 限流
- 对外邮件 OutEmail、抽奖系统、ModList 与公告弹窗
- 用户资料 / 头像上传，IndexedDB 头像缓存
- IPFS 图床短链、短链跳转 / 管理与 XSS 防护

#### 07-27 ~ 07-31
- 管理后台增强命令管理、日志分享与域名豁免检查
- 新增 Tiger Adventure 游戏
- 强化命令 / 图片 ID 校验、安全日志与短链复制体验

### 2025-08

#### 08-01 ~ 08-10
- 新增 CaseConverter / CoinFlip 等实用工具增强
- 实现 CSRF 防护与会话安全加固
- MongoDB 用户存储自动切换，新增资源商店
- CDK 批量选择 / 删除 / 导出 / 导入与未使用 CDK 清理

#### 08-11 ~ 08-16
- 集成 FBI Wanted 模块与相关管理能力
- 指纹上报 / 管理、Webhook 事件管理与 Resend 校验
- LibreChat 兼容路由、实时聊天与数据收集管理
- 上线 SmartHumanCheck 智能人机校验与风险评估

#### 08-17 ~ 08-24
- SmartHumanCheck 接入认证链路，增强防自动化挑战
- 数据收集批处理、PII 检测与管理端设置面板
- Debug Console、敏感管理接口限流与 Docker 构建优化
- Markdown 支持 Mermaid / 数学公式，IPFS 配置管理与 SVG 消毒

#### 08-25 ~ 08-31
- Turnstile 配置管理、首次访问验证与临时指纹 / access token
- 首次访问联动 IP 封禁，重构篡改防护中间件
- 批量图片上传、Microsoft Clarity 分析、防伪查询页
- 部署脚本 Node 化，GitHub Billing 配置与 DOCX 导出
- Docker / GHCR 多架构构建与推送完善

### 2025-09

#### 09-05 ~ 09-10
- 包管理逐步切换到 pnpm，并优化 Docker / CI 安装缓存
- Turnstile 高级验证与风险评估，统一 `shc_traces` 溯源模型
- GitHub Billing 本地缓存、公开路由与限流
- 集成 hCaptcha 备选验证、CSP 更新与 Clarity
- 日志归档、路径消毒、指纹增强与开发态自动放行

#### 09-11 ~ 09-21
- Billing / 管理端接入 Turnstile token 鉴权
- GitHub Billing 高级缓存、性能指标与渐进加载
- 通知测试页、校园应急页与多配置 curl 管理
- PasskeySetup / FirstVisitVerification 可访问性与调试增强

#### 09-24 ~ 09-29
- 公开 Turnstile 配置 / token 校验端点
- 用户资料按 2FA 状态优化验证流程
- 管理端多个 Modal 组件性能与交互优化
- 新增 IP 数据清理与统计能力

### 2025-10

#### 10-03 ~ 10-09
- EnvManager 增强 Clarity Project ID 管理与 curl 校验
- 篡改检测 / 完整性校验与品牌保护增强
- 调度清理统计日志、首次访问懒加载
- 策略执行 / 同意记录模块与时间戳校验放宽
- 新增 `useToast` 通知 Hook

#### 10-18 ~ 10-23
- IPFS 开发态可跳过 Turnstile，增强 Crossbell 域名校验
- 短链生成策略增强；数据收集 / CDK / Clarity / Life 服务补健康检查与缓存
- 服务日志中文化
- 新增多个 Demo 页面（财务 / 冥想 / 音乐播放器）

### 2025-11

#### 11-06 ~ 11-17
- 统一 Passkey API 与 origin 管理，完善无密码登录路径
- 新增字数统计页与年龄计算器，并统一设计语言
- 接入 React 19 能力（metadata / use hook）并做组件性能优化
- 指纹请求弹窗支持一次性关闭与强制上报
- 实现基于 Redis + MongoDB 同步的 IP 封禁系统

#### 11-18 ~ 11-30
- 修复管理端弹窗、TypeScript 与数据库连通问题
- 支持 CIDR 段封禁，并完善封禁 / 解封同步
- 完整性检查误报显著降低，FBI Wanted 系统全面重构
- 登录 / 注册页拆分并采用 GitHub 风格设计
- 新增忘记密码 / 重置密码，兼容 mongoose 9，首次访问验证支持后端开关

### 2025-12

#### 12-03 ~ 12-07
- 补充完整 Passkey 登录指南
- 实现可发现凭证的无密码 Passkey 登录
- 新增 Turnstile 全局旁路开关
- 新增邮箱验证页与密码重置链接页
- 认证页完成中文本地化，所有模态框增强响应式与滚动支持


### 2026-01

#### 01-06
- 批量升级前端与后端依赖（jspdf、rollup、framer-motion、svix、react-email、lucide-react、mongoose、zod 等）

### 2026-02

#### 02-15
- 新增团队工作区与协作系统
- 修复 CodeQL 安全漏洞

#### 02-16
- 规范 Dockerfile 多阶段构建
- 新增 WebSocket 实时通知、广播管理，并重构限流 / CORS / WAF / 健康检查
- 新增请求防重放验证、操作审计日志、API Key 管理，并修复 Docker 构建问题
- 对齐 CI / Dockerfile 后端构建阶段，合并 Dependabot 自动批准与合并流程
- 继续处理 CodeQL 高危告警与 Dependabot 安全告警

#### 02-18
- 封禁 IP 加载优先使用 MongoDB
- 扩展 WAF body 白名单，支持 `deviceSignals` 与项目字段
- 新增 `WAF_ENABLED` 环境开关
- 优化审计日志与 WAF 性能，支持动态注册 WAF 白名单
- 新增一键修复 Dependabot 安全告警脚本与工作流
- 新增 Cloudflare Workers 边缘部署（Hono）
- 性能优化：减少请求日志开销、缓存 CIDR 查询、懒加载 JSDOM/DOMPurify、合并限流器内存存储
- 引入 Biome 配置与 safe/unsafe 检查工作流
- 修复 MongoDB 查询输入消毒与正则转义相关 CodeQL 告警

#### 02-19
- 补全短链迁移服务正则转义
- 新增专有许可证与完整 README
- 前后端支持 IPv6 双栈
- API / 前端域名迁移至 `951100.xyz`

#### 02-20
- 修复 nginx WebSocket 代理与前端 WSS 地址推导
- `authenticateAdmin` 改为校验 JWT 并从数据库查询角色
- 登录 / TOTP / Passkey 签发 JWT 时写入 role
- 管理后台落地五色设计体系，并统一欢迎页 / 登录注册页 / TTS 页视觉
- 新增通用 Webhook 通知端点与模板渲染
- 管理端弹窗统一 Portal 到 `document.body`
- 新增公开短链创建页（`SERVER_PASSWORD` 鉴权）
- 增强 WsConnector / ApiKeyManager / AuditLogViewer / SystemManager 移动端适配

#### 02-21
- 统一 FBIWanted / GitHubBillingCache UI 主题
- 管理员跳过 Turnstile，并修正 captcha token 字段名
- 广播 / WebSocket 通知支持自定义展示时长、toast/modal 与 text/html/markdown 格式

#### 02-23
- Docker inspect 子命令支持导出容器信息并生成 `docker run`
- 支持本地文件输入 inspect，并懒加载重依赖

### 2026-03

#### 03-02
- 新增 NexAI 独立认证体系（Google / GitHub OAuth，`/api/nexai`）
- 修复 NexAI 认证相关 CodeQL 告警
- 新增 AMD64 / ARM64 Docker 镜像构建工作流

#### 03-08
- 实现 NexAI 云同步（controller / model / service / routes）
- 完善 NexAI 本地 / OAuth / WebAuthn 认证与前端接入
- 用户生成记录支持 MySQL 存储与去重
- 引入 Turnstile / hCaptcha、用户管理、日志路由与 GitHub Billing 相关服务
- 新增 Dependabot 安全告警自动修复脚本

#### 03-13
- 实现 NexAI 安全能力：设备追踪、异常检测、事件上报与安全看板

#### 03-14
- 新增 Artifacts 分享功能与 NexAI Security Dashboard
- Artifact 支持密码保护、内容渲染与多内容类型（json / svg / latex / csv / xml / text）

#### 03-15
- 加强命令路由权限，并修复前端响应 / 渲染风险

#### 03-23 ~ 03-24
- 新增管理端用户管理界面与 API
- 补齐登录 / 注册 / 重置密码等核心认证页
- 登录支持 2FA（Passkey / TOTP）与 Turnstile
- 新增 hCaptcha 组件、通知系统、实时聊天与独立 Markdown 渲染组件
- 新增忘记密码页与完整邮件认证 / 通知模板
- 补齐 NexAI 安全控制器端点

#### 03-27 ~ 03-28
- 新增指纹上报（去重 + WebSocket 通知）
- 密码重置补充设备信息采集与通知邮件
- 管理员修改用户信息发送通知邮件
- 支持异地登录检测与告警邮件
- 初始化 Docusaurus API 文档与前端 / Worker 基础设施

#### 03-29
- 新增工单系统（创建 / 查看 / 回复 / 员工管理）
- 工单支持 AI 回复、流式响应、违规处罚与 WebSocket 实时更新
- WelcomePage / MobileNav 支持多账号切换与登录状态通知
- 强化 Passkey 校验、账户安全通知与用户变更邮件模板

### 2026-04

#### 04-04
- Markdown 预览与工单系统统一改用 MarkdownRenderer，并支持复制代码
- 新增 Linux.do OAuth 登录 / 注册（含 discovery 与 PKCE）
- 恢复首次访问验证，并新增 IP 验证挑战流程
- 支持运行时配置 Google Auth 与 OAuth JSON 导入
- 新增 DeepLX 翻译工作区、翻译审计与处罚策略
- 优化 App Shell UX、加载态与移动端 DeepLX 布局

#### 04-05 ~ 04-07
- 用户资料更新改为三步验证流程
- 优化资料页邮箱 / 密码与 TTS 交互体验
- 修复 TTS 响应元数据与工单前端构建
- 延迟加载 jsdom，扩展 tsc 工作流覆盖面

#### 04-10 ~ 04-11
- 修复前端 Dependabot 告警与 SVG / cheerio 类型问题
- 加固 NexAI 同步用户 ID 访问

#### 04-27 ~ 04-30
- 增强 Dependabot 告警修复脚本（repair mode / override / target 过滤）
- 修复前端运行时与静态资源错误
- 后端路由注册、安全流水线、限流配置与用户存储分层集中化
- TTS 流水线任务化并强化持久化
- 新增后端 profiling 能力
- 统一 CSP 归属，重构邮件传输并扩展管理端邮件控制台
- 重写 Mod List 编辑器，统一生产环境 API / 静态资源路径策略

### 2026-05

#### 05-21 ~ 05-24
- 优化 Windows 命令执行与依赖更新错误处理
- 强化认证 / TOTP 流程
- 更新 Dockerfile / pnpm 安装策略（ignore-scripts、frozen lockfile、统一 pnpm 11.1.1）
- 修复 SVG 多字符消毒不完整问题，并为 status 路由补齐限流
- 新增 `SERVE_FRONTEND` 环境开关

#### 05-25 ~ 05-26
- 修复 Tailwind v4 / Alpine 相关构建与 `@import "tailwindcss"` 顺序问题
- 统一 App 加载态、页面切换动画、404 与 TOTP 模态无访问性

#### 05-28
- EnvManager / IPFS 增加 ImageBed 配置与服务回退
- 拆分 `adminRoutes`、`turnstileService`、`turnstileRoutes`、env / librechat 大文件
- 前后端禁止上传 SVG
- 实用工具 / 核心功能 / 娱乐页 UI 统一
- 新增邮件系统配置管理与基于令牌的密码查看二次验证
- 增强篡改上报与管理能力，优化移动端导航

#### 05-29 ~ 05-30
- 增强 IP 解封参数校验与智能人机校验
- 补齐旧版 API 路径重定向与路由整合问题
- 降低后端热路径与 API 请求开销
- 完成 NexAI 后端契约
- 新增古诗文库 docx 生成能力
- 更新 README

### 2026-06

#### 06-04 ~ 06-06
- 用户存储脚本限制为 Mongo
- 修复静态音频服务与资源访问 token 处理
- 新增审计日志元数据与路由增强
- 新增 EcoEnchants API / 管理页 / Webhook / 遥测事件
- 增强限流 key 生成与路由限流
- 新增 OAuth 2.0 Provider（client / code / grant / token）
- 增强广播管理范围与管理后台访问校验
- 优化用户管理数据加载与 EnvManager 表单体验

#### 06-07
- 完善第三方账号绑定、合并与身份管理（含 Google 绑定）
- 新增 Rust network tools 客户端（TCP ping / port scan）
- 新增 Rust audio-worker sidecar 与 data-tools HTTP handlers
- 支持嵌入式 Rust 服务配置、重启退避与 Dependabot 周更
- 首次访问验证改为可配置开关

#### 06-08 ~ 06-10
- 新增 TTS 生成历史管理
- 支持 Rust Data Tools、mmap / shared-memory IPC 与 payload 校验
- 增强 ZIP 检查（ZIP64 / data descriptor）
- 优化 Webhook 事件规范化与管理 UI
- TTS 响应补充音频元数据与体积展示
- 强化 OAuth token secret 哈希策略与多路由限流

#### 06-24 ~ 06-27
- 新增 Markdown 文章管理（CRUD / 状态控制 / 列表筛选 / 搜索面板）
- 优化文章页页头行为与文本选择操作
- 增强 OAuth 管理端能力
- 新增注册邀请码管理与校验
- 优化登录 UX，并支持 Vercel 部署脚本
- 管理员密码校验改为 timing-safe，并支持运行时配置变更

#### 06-30
- 新增遗留 API 选择页，并要求后端确认选择结果
- 管理员密码查看流程支持 Passkey

### 2026-07

#### 07-02
- 自动处理 Dependabot 安全告警

#### 07-03
- 新增第三方账号绑定流程
- 优化 Provider 绑定交互体验
- 暴露已登录态外部邮箱 API
- 补充 Rust OutEmail API 文档
- 改进 Markdown 渲染体验

#### 07-04
- 新增 Android 移动端登录流程
- 降低外部资源与过期 TTS 资源错误
- 管理后台安全页面对齐基准仪表盘 UI
- 处理乱码相关编码问题
- 修复 Linux.do 回调错误跳转
- 支持邮箱服务商注册凭证能力

#### 07-05
- 对齐认证错误信息与测试断言
- 新增完整项目审计报告
- 修复审计中的安全与发布相关问题

#### 07-07
- 为 NexAI Passkey 增加 signal 选项

#### 07-08
- 同步前端 lockfile
- 重构解密函数，提升 buffer 处理与类型安全
- 在测试中 mock 工单路由限流器

#### 07-11
- 持久化工单 AI 失败诊断信息
- 增加加密 LogShare 响应解密测试
- 同步并修复 pnpm override / lockfile 兼容性
- 优化失败尝试合并逻辑与诊断结构
- 更新 README 构建与测试说明
- 保留 LibreChat 完整重试 token
- 将 pnpm 设置迁移到 workspace 配置并统一版本

#### 07-12
- 新增 NexAI 可发现式 Passkey 登录
- 完整适配 Google Identity Services Web 客户端
- 在 EnvManager 暴露并可用化 `GOOGLE_CLIENT_ID` 配置

#### 07-13
- 在 `assetlinks.json` 提供 Synapse Mobile 入口
- 为 NexAI Passkey 托管默认 Digital Asset Links
- 完成 Synapse Android 运行时配置

#### 07-15
- 修复 Linux.do 回调重定向循环与 429
- 落地健康检查、运维与配置相关审计修复
- 完成全量审计整改收尾
- 引入 HttpOnly Cookie 会话，并继续拆分管理后台 UI
- 浏览器会话强制 Cookie-only，并深化前端拆分
- 继续拆分 EnvManager 配置区块

#### 07-16
- 接受 Android base64 / base64url 的 apk-key-hash origin
- NexAI 支持反调试设备安全请求头
- 修复管理端 `AdminUserRecord` 类型错误
- 修复 `CommandManager` 状态拉取 try/catch 结构
- 修复 UI 拆分后的前端 TypeScript 构建错误
- 补充 `UserList` 过滤类型导入，并修正账户类型断言
- 合入 Synapse TTS 平台代码主体
- 适配 TypeScript 6 / Node16 模块解析规则
- 继续自动处理 Dependabot 安全告警
- 修复 `emailService` 中 `marked` Promise 类型问题

#### 07-17
- 清理 Node 验证日志
- 固定 TypeScript 6 以兼容 ts-jest
- 安全维护脚本支持自动修复 CodeQL 告警
- CI 双通道安全告警修复常开
- 兼容 `createLimiter` API 变体，降低 CodeQL 误报
- 处理 Dependabot Rust 告警并升级安全相关 cargo 依赖
- 恢复 Node 验证链路，规避损坏的 coverage 插桩
- 修复剩余 Node 验证测试失败
- 审计并修复 NexAI 安全信任问题
- 接受 NexAI Frida / Xposed 安全事件类型
- 新增 NexAI sig-v2 中间件与明确错误阶段
- 支持 refreshToken 绑定的 NexAI 请求签名
- 修复 NexAI TypeScript 构建错误（NodeNext 动态导入扩展名、签名中间件返回类型）

### 2026-08

#### 08-03
- 彻底移除 Rust 微服务集成：删除 `rust-services/` 目录（含 audio-worker / data-tools / file-worker / network-tools / security-worker / ipc-runtime）及 `rust-toolchain.toml`
- 清理所有 Rust 相关 CI 工作流（tsc.yml / codeql.yml / auto-merge.yml / dependabot-maintenance.yml）
- 移除 `RustBenchmarkDashboard` 组件及其所有前端引用（路由、导航菜单、管理模块加载器、WebSocket 消息类型）
- 移除 `internalServiceToken` 配置项及后端引用（startup diagnostics、wsService、legacyApiRedirect）
- 修复 Tailwind CSS v4 构建问题：`@config` 改为内联语法 `@import "tailwindcss" config("...")`
- 修复 Tailwind v3 `config()` 语法不兼容 Vite 7 lightningcss 的问题
- 移除 sidebar logo 蓝色背景
- 修复 Config.ts 和 smartHumanCheckService.ts 缺少闭合括号的 TS 错误
- 修复 adminController 和 ipBanSyncService 的 TS 编译错误
- 项目显示名称统一为 Synapse
- 清理根目录：移动审计报告、脚本，更新 gitignore 规则
- 删除 `test-data/`、`logs/`、`outputs/` 目录
- 更新 README 项目结构

#### 08-06 ~ 08-07
- 新增 env-manager「Project Lumen 配置」区：MongoDB 保管库（`project_lumen_config` 集合）可保存 Project-Lumen 客户端构建与 CI 的 13 个密钥/配置项（不受 1024 字符限制，可容纳 base64 keystore），并按 key 增删改查
- 新增一键「同步全部到 GitHub」：基于 libsodium Sealed Box 加密，调用 GitHub Actions Secrets REST API，把保管库中的值批量写入目标仓库 secrets，并逐 key 展示同步结果
- 同步目标通过 `PROJECT_LUMEN_GITHUB_OWNER / PROJECT_LUMEN_GITHUB_REPO / PROJECT_LUMEN_GITHUB_TOKEN` 配置（已写入 `.env.example`）
- 移除 keystore 签名 4 字段（`KEYSTORE_BASE64 / KEYSTORE_PASSWORD / KEY_ALIAS / KEY_PASSWORD`），签名材料改由线下单独管理
- 新增依赖 `libsodium-wrappers`（注意：需在部署环境重新生成 `pnpm-lock.yaml`，否则 `--frozen-lockfile` 工作流会因锁文件未同步而失败）

#### 08-27 ~ 08-31
- 崩溃报告后台重构：优化查询路径，支持按设备 ID 检索
- CDict 官方客户端签名参数改为后台可调
- coin-flip 前后端生成唯一结果 ID，管理端可查看记录
- 全量升级 npm 依赖；补充 IP 与反向代理相关环境变量详解
- CI MongoDB 镜像 `mongo:7` → `mongo:8`，修复 replica/nightly 集成测试；回退 mongodb 驱动至 `^7.5.0` 修复握手失败
- 基础镜像 `node:24.3.0-alpine` → `24.20.0-alpine`，运行时移除 npm/corepack/pnpm 并 `apk upgrade`、仅装生产依赖，消除镜像扫描 CVE
- Lumen 服务端配置改为 env-manager 可配置 + 启动门控
- 应用 2026-08-31 架构审计修复

### 2026-09

#### 09-01
- 大规模架构审计落地：app/中间件、认证/身份、路由、控制器、平台服务、前端核心/管理/功能等 G1–G13 分组共数百项修复
- 全量修复 type-check 错误（TOTP delta 计数、聚合分组类型、定时器句柄类型、runtimeConfig 缓存键、静态 import 收紧等）

#### 09-02 ~ 09-03
- Lumen 采集集合加 TTL 保留期与回填迁移，随生产镜像发布
- 基于作用域的路由治理；拆分超过 800 行的路由文件与 `authController`
- 篡改事件落 MongoDB、审计失败即 fail-closed、受管命令从策略重建
- `dist-obfuscated` 补齐非 JS 资源并对生产产物做冒烟；输出侧消毒 HTML 而非写入时改写
- 抽取共享 `PROTECTED_ENV_KEYS`、去重限流后端

#### 09-06
- LibreChat：强制登录、移除游客与手动鉴权通道；管理端游客孤儿历史筛选 + 一键清理；通道支持 openai-chat / openai-responses / anthropic 三种线格式；遗留审计 F1–F11 修复
- 新增 qq-guard 纪律管控：控制通道 + 审计存储 + 管理面板，扩展政治/历史失真内容审核规则，bot 离线/恢复健康事件入审计与告警邮件，控制通道密钥接入 runtimeConfig
- 新增 media-tool：内置 + 独立双形态管理 GUI，Mongo/JSON 双任务存储 + 任务 runner + HTTP API，移植 B 站下载 / 语音转写引擎至 `src/mediaTool`
- 工单内容超限改走邮件通道（前端保留全文并一键 mailto）
- 修复邮箱 identifier 登录被当用户名拒、hCaptcha token 被截断、`/admin/*` SPA 深链 308、失效 IP 地理位置源、winston 重复日志等；移除全屏 LoadingSpinner

#### 09-12
- OAuth userinfo 改从 auth 上下文取 user（而非无 user 行的窄 oauthContext），修复生产 500

#### 09-19
- 补齐 OIDC 语义，使本服务可作为下游应用的登录提供方；管理页新增 OIDC 接入信息面板
- 全量升级 npm 依赖；修复 vitest 5 与 mongodb 7.6 升级引入的两处 CI 回归

#### 09-22
- 新增 v-t 图六个比例交互演示页

#### 09-25
- 新增综合服务平台首页，语音合成工作台迁至 `/tts`
- 上线「语音转文本」核心功能页：内嵌 transcribe.js 全链路，转写正文入 `media_tool_transcripts`
- 接入 proxycheck.io IP 风险检测：出口探测 + 按官方语义的 HMAC 验签 + 详细日志面板（api 请求日志 / 库内内容 / 每项决策）
- 新增内置微软语音（直连 Edge 朗读接口）提供商，默认不动；TTS 支持多提供商
- media-tool 镜像补齐 yt-dlp/ffmpeg 并落实「留空探测 PATH」；任务终态只落库一次，取消不再卡在运行中
- 新增 Vercel Web Analytics 页面浏览统计
- `ENABLE_FIRST_VISIT_VERIFICATION` / `REGISTRATION_INVITE_REQUIRED` 收敛为 env-manager 运行时配置（env 仅作启动默认值）
- 域名统一为 `chloemlla.com`，前端基址固定，CORS/CSP 相应放行
- 前端样式大规模收敛到 studioTheme（批 1–6 + Info* 组件族），清除蓝紫渐变统一中性 slate
- 恢复后端 Jest 与前端覆盖率采集，让 118 个后端套件真正启动
- CVE 依赖升级（browserslist / baseline-browser-mapping），修复 pnpm 锁文件

#### 09-26
- 客户端 `sml_` 令牌按血缘每日轮换，旧令牌复用即整链吊销；接入风险分级轮换（命中信号压到 1 小时）与 Play Integrity 设备证明（不通过只降级不拒绝）；新增登录令牌血缘只读面板（P4）与代次上限告警 + 被顶替代次 IP 保留期
- footer 构建期注入前后端版本 + 短 SHA，四块信息响应式横竖排
- IP 风险分过高直接阻断，前后端各加对应页面；封禁界面统一改为支持邮箱入口
- 将 Project-Lumen 识别为官方客户端，记录设备/会话身份
- TTS 多提供商并存与用户切换，SPA 路径清单覆盖全部前端路由
- media-tool：B 站 412 改走 API 直取 + cookies 正文入库持久化
- 部署脚本修复（后端短 SHA 部署后永不更新、env 差集精确化、失败不再假绿）
- 大量测试收尾（替身/mock 修复、单测真入门禁、覆盖率补齐）

#### 09-27
- 单一 `AES_KEY` 主密钥派生落地：JWT 签名、密码 KEK、验证令牌元数据、B 站凭据、重放签名、proxycheck HMAC 等统一改为 HKDF-SHA256 派生子密钥，旧 env 与存量密文双接受；生产启动校验改为 `AES_KEY`（过渡期兼容 `JWT_SECRET`）≥32
- env-manager：验证安全会话后可查看主密钥与派生子密钥、轮换 `AES_KEY`、一键结束所有安全会话；查看密钥等敏感操作发安全通知邮件
- WebRTC 泄露检测完善：采集 srflx 公网候选 + 多 STUN，服务端自判 `webrtcVsExit`，管理端 IP 风险日志支持按泄露筛选
- 新增 B 站凭据与设备管理页；登录期 cookie 上报不依赖 Synapse 会话（只认设备 id，密文入库、仅元数据可读）
- 安全加固：移除 test 环境万能管理口令后门、补齐 disabled 账户拦截（36 个路由）、`CF-Connecting-IP` 仅在显式信任 Cloudflare 时采信
- 补 `broadcastLog` / `securityEvent` 缺失索引；消除 9 处 Mongoose 重复索引告警
- 修复邮箱白名单点转义、星座判定整体错位、大小写转换快捷键劫持浏览器快捷键等
- 文档分门别类整理并归置根目录审计报告

#### 09-28
- 全站统一「安全会话」：新增 `hasValidSecuritySession` 与前端 `EstablishSecuritySession`（密码 / TOTP / Passkey），命令端点与查看密钥改用安全会话，替换各自的管理操作口令
- 管理后台可一键结束所有安全会话并轮换 `AES_KEY`
- 出站邮件保留 HTML 排版（DOMPurify 净化后走 `text/html`，不再整体拍平为纯文本）

#### 09-29
- 政策体系：条文改由 `src/config/policyDocument.ts` 单点维护（版本升至 2.1），登录/注册强制逐项同意四份文件，同意记录带 `source` / `agreements`
- 打通 TTS 政策同意链路（服务端签名 + 设备归属证明 + 前端勾选续跑）；用户端可查看并撤回同意（只认本设备同意凭据）；新增管理端政策同意记录只读面板
- 安全会话收口：个人资料 / 第三方绑定 / 命令执行 / 查看密钥 / 轮换主密钥统一复用，双因素配置禁止仅凭密码建立会话；关闭 TOTP 在持有 TOTP / Passkey 安全会话时不再要求验证码
- TTS 生成记录支持用户自助管理（标题 / 备注 / 标签 + 软删除，管理后台仍可见），并停用匿名生成链路
- 已登录管理员访问共享口令端点（公共短链、服务器状态）免填口令
- 全仓旧品牌字样 `hapx` / `hapxs` 统一为 `chloemlla.com`；清除 5 条 CodeQL 告警

#### 09-30
- 政策同意记录补齐 `documentHash` 与撤回留痕（`revokedAt` / `revokedIP` / `revokedReason`），有效期与有效性判定收敛，新增 `GET /api/policy/status` 与 `purge` 硬删除；管理端记录接口支持时间/完整性筛选与 CSV 导出
- 政策页新增站内检索、字号切换、本设备同意状态与就地续期

### 2026-10

#### 10-01
- 人机验证：新增 trycap（自托管 Cap）供应商，三家统一请求契约与下发链路，CDK 不再直连 Cloudflare；供应商分配支持场景权重（默认 / 首访 / 独立页）、策略（加权 / 轮询 / 故障转移）、粘性窗口、灰度与优先级
- 人机验证控制台改为「总览 / 供应商 / 分配策略 / 组件外观 / 额度与用量」五页签，含分配模拟器与「现在会选谁」诊断；hCaptcha 月度额度 10000/月，用尽自动停止下发、下月自动恢复
- 前端新增 `ManagedCaptcha`，登录 / 注册 / 忘记密码 / 重置密码 / TTS / 图床 / 抽奖 / 资源商店 / 挑战页统一接入，控件加载失败按策略自动换供应商；`/challenge`、`/hcaptcha-verify` 重定向到 `/captcha-verify`
- 新增共享短期状态存储 `sharedStateStore`（Redis → Mongo → 内存三层，含 `claim` 原子申领与 `consume` 一次性读取）；安全会话改自包含令牌 + 共享撤销水位（跨实例收敛 ≤2s），令牌改用 AES-256-GCM 密封，彻底消除 CodeQL 1247 弱哈希告警
- 未登录只放行 `/articles` 与「实用工具」组，其余内容 / 商店 / 娱乐页面及其接口同步收紧为必须登录
- 普通管理员管理端范围收窄为「用户管理 / API Key / API Key 计费 / OAuth 管理」，新增 fail-closed 的 `adminScope` 范围守卫
- 管理员效率包：⌘K 命令面板、模块置顶与最近访问、模块页工具条（面包屑 / 上下一模块 / 复制路径）
- 前端首屏性能：入口不再静态加载 mermaid / katex / pdf / charts 与全量 Prism（新增 PrismLight 语法白名单），react-icons 独立分块；用 rolldown 原生 `codeSplitting.groups` 取代 `manualChunks`，修掉 mermaid 组递归吞依赖导致 `vite/preload-helper` 寄生的根因，CI 首屏静态闭包 1655.6 → 344.2 KiB gzip，预算收回 800 KiB
- 移除前后端 31 项无用依赖并新增无用依赖静态审查脚本；全量升级 npm 依赖
- TypeScript 单文件体量上限由 800 放宽到 1500；修 CodeQL `js/request-forgery`（Cap 端点 SSRF）与 `js/identity-replacement`；密码重置链接邮件不再受邮件共享日配额限制

#### 10-03
- 全量审计收口：前后端 7 份报告 + 94 条逐条处置，并修复登记的阻断级 / 高危 / 第三批缺陷（认证、人机验证、TTS、商店、管理面板、工具页与失败出路）
- 前端原生 `confirm` 清零：最后 60 余处统一到组件化确认对话框（管理面板 + 工具页）
- 数据保留口径：审计日志保留期 90 → 60 天，并附可执行的 TTL 迁移脚本
- 安全：管理员口令改为 bcrypt 入账（不再明文存 Mongo）；媒体工具 B 站下载加域名白名单与私网地址拦截（管理端 SSRF）；运行时环境变量补齐「进程加载器」类保护，审计脱敏补验证码字段名
- 运维备份体系：每日 MongoDB / Redis / 容器卷备份统一到 `/root/backups`，全面 age 加密（存量 + 增量）并接 Google Drive 云端副本（授权助手、size+md5 幂等校验、重列云端验证），服务器端自助恢复脚本 + RESTORE.md；卷备份在容器短停期间被强杀可自愈
- 接入层：维护兜底页独立成 `deploy/openresty` 并统一兜 5xx，证书分发脚本与备份三件套入仓
- 隐私政策 v2.2：补「逐项数据清单」与四章数据处理说明，条文、数据地图与闸门同步

#### 10-04
- 2026-10-03 审计的全部中 / 低缺陷修复完成，并挂载 4 组此前实现但未注册的孤儿路由
- IP 风控模块 38 条缺陷修复：上游验签静默失效、配额漏计、面板误读
- `UserManagement` 顶部常量与类型拆到子模块，回到单文件 1500 行闸门内
- 修掉前三批修复引入的 CI 回归（前端类型检查 + 两个用例套件）

#### 10-05
- 修同类「控件被自身状态回报卸载」缺陷：TTS 页人机验证区块不再随自身状态回报而消失，并对齐状态契约

#### 10-07
- 人机验证全生命周期 19 项已确认缺陷修复；响应层统一识别验证码失败并触发自动恢复，且不再清掉更新的令牌
- 邮件系统：账号投递与发送配额分离，生命周期与「事务性邮件」标记修正
- 修 CodeQL 告警 1282 / 1287 / 1288（`js/sql-injection`、`js/clear-text-logging`、`js/insufficient-password-hash`）
- 审计整改整合：保留同期邮件、验证码与安全修复；`configurationNotice` 索引只声明一次
- 前端审查报告（fe-comp 1~4）落盘并收束覆盖面

#### 10-08
- 修正合并后的引用与共享密码策略

#### 10-10
- **仅管理员可用**的一批功能不再对普通用户开放：`公共短链创建`、`v-t 图比例`、`MD 导出`、`MD 转 Word`、`GitHub 账单`、`校园紧急` 六项入口从普通用户导航隐藏、直链也进不去（路由改 admin 守卫），后端同步封锁（`/api/doc-tool` 叠 authenticateAdmin；`/api/shorturl` 的公共创建端点新增「管理员或匿名」闸门：已登录的普通用户直接 403，真实访客仍走共享口令流程）
- LibreChat 每日额度：普通用户每天 5 次对话；超出后逐次警告（最多 3 次），继续无视则**自动暂停 LibreChat 权限一天并同时封禁工单权限**（封禁文案不给申诉入口）；管理员不受限，只读（历史/导出/清空）不消耗额度、封禁期间仍可用
- LibreChat 额度可见：普通用户可在页面**实时看到今日剩余对话次数**——发送/重试成功即按后端回传的额度就地更新，跨标签页在回复完成时同步；接近上限与暂停时给出状态提示。后端新增只读额度端点（不消耗次数，暂停期间也能查看），并在成功响应里内联同一额度视图，省掉一次额外查询
- 新增「按同意开放功能」（feature consent gate）：需要处理用户内容或涉及账号/第三方处理的功能，按**用户自己**勾选的政策文件放行；同意记录新增 `userId`，同一设备换账号不再能蹭到上一位用户的同意，撤销同意后立即收回访问（门禁不做缓存）
- 功能与政策的对应关系按义务分五类落在 `src/config/featureConsent.ts`（上传处理 / 对外发布 / 交第三方 / 账号与开放接口 / 个人数据上报，共 10 个功能键，各带依据与路由证据），并加配置自检测试防映射静默漂移；被拦时返回稳定 `code: POLICY_CONSENT_REQUIRED` + 缺失条款清单，页面弹出同意清单，同意后自动放行；纯本地工具不挂门禁
- 新增「Markdown → Word 批量转换」实用工具（`/doc-convert`，也可在 `/markdown-export` 页切「批量」模式）：一次上传多个 `.md`（或整个文件夹，保留子目录结构），服务端用 pandoc 批量转换，带逐文件进度、成功 / 跳过 / 失败统计、可下载的转换报告、成功产物打包 zip 下载与「只重试失败项」
- 转换完成的文档可直接取回：结果列表逐条下载，文件列表里已有的产物也能逐个下载或一次打包（重命名模式下拿的是磁盘上现存那份，不必先重转）
- 仓库自带默认参考样式文档（`src/assets/doc-tool/reference.docx`，随构建进 `dist/assets/`）：用户没选模板时用它，表格框线与中英文字体开箱即用；也可在页面上生成自己的模板或 `DOC_TOOL_DEFAULT_REFERENCE_DOC` 指定/关闭
- 同名产物冲突三选一：跳过 / **自动另存为 `xxx (2).docx`（默认，旧文件一字不改）** / 覆盖；参考样式模板可一键生成，表格框线与中文字体由它一处统一；上传文件与产物按用户隔离，并按保留天数自动过期
- 镜像内置 pandoc：与 yt-dlp 同思路取上游官方静态二进制（默认跟随上游最新 release，也可 `--build-arg PANDOC_VERSION=<x>` 钉版本；构建期 `pandoc --version` 自证），不走 `apk add pandoc`（仓库版本滞后且会拉入整套 GHC 依赖树）
- 短链新增「近期热门查询」缓存：1 小时内查询超过 3 次的短链写进 Redis，后续跳转直接命中缓存、不再打库；删除短链（含管理端批量删除与清库）同步失效缓存；未配置 Redis 时自动退化为原行为

#### 10-11
- 抽奖公平性修复：`probability` 回到「绝对概率」语义——概率和 < 1 时随机值落在剩余区间即**未中奖**，不再把差额全部补贴给列表里第一个奖品（旧实现等于把第一个奖品的实际概率放大到 1 − Σ 其余）。抽出 `pickPrize` 纯函数并把分布边界写进用例
- 抽奖参与记录：未中奖也计一次参与（`participationCount`），只有中奖才加 `winCount` / 总价值 / 历史；「奖品已领完」（明确报错）与「未中奖」（正常返回 `data: null`）分开
- 抽奖页面：未中奖弹「谢谢参与」而不是错误面板；**任何参与失败（已参与过 / 验证失败 / 抽完）不再把整页替换成错误页**，改为通知；奖品区显示本轮中奖概率
- 抽奖隐私：普通用户拿到的轮次视图不再包含参与者的内部用户 id（改回 `hasParticipated` + `participantCount` / `winnerCount`），中奖记录去掉 `userId`；管理员仍拿完整数据
- 抽奖管理端入参硬化：时间必须是可解析时刻、概率限 0-1、数量为正整数、库存在服务端按数量初始化、奖品 id 缺失或重复自动补；概率和 > 1 自动归一化——自动修正项会回传并在界面提示
- 抽奖存储：`deleteAllRounds` 同时清空用户记录（不再残留孤儿中奖历史）；排行榜/统计改批量读取（`$in` / `IN` / 一次读文件），统计只读一遍轮次；区块高度与哈希合并为一次外呼
- 抽奖请求幂等（PRD §4）：`POST /rounds/:id/participate` 接受 `requestId`，同一 id 的重放直接返回上次结果、不再抽一次也不重复扣库存（`sharedStateStore` 幂等键，业务拒绝自动释放可重试）；前端每次参与携带 `crypto.randomUUID()`
- 抽奖审计流水：每次抽奖往既有 `audit_logs` 写 `lottery.draw`（`module: lottery`），detail 含随机数快照、落点奖品与扣减后库存，可在管理端审计查看器按模块筛选（复用 60 天保留与不可变存储，不另造流水表）
- 抽奖管理页清掉不再使用的 AES 解密死代码与无用导入
- 抽奖机会与多抽：轮次可配 `maxDrawsPerUser`（默认 1）与 `chanceCost`（默认 0 = 免费抽）；抽奖机会账本支持每日免费（`LOTTERY_DAILY_FREE_CHANCES`，自然日懒发放）、超管发放（`POST /api/lottery/chances/grant`，写 `lottery.chances_grant` 审计）与原子扣减 + 落库失败自动退机会（`GET /api/lottery/chances` 查余额）
- 抽奖硬保底：轮次可配 `guarantee = { everyDraws, category }`，按本轮个人次数每 N 抽必出指定稀有度及以上（无符合条件的有库存奖品时回落普通抽取）；页面显示剩余可抽次数与每次消耗，管理端创建轮次可配次数/机会/保底
- 抽奖算法增强：软保底（`softGuarantee = { startsAfterDraws, category, step }`，越界后线性抬高「至少出该档」触发概率，触发即必中该档）与伪随机平滑补偿（`pseudoRandom = { increment, maxBonus }`，连续未命中累积概率加成、命中重置）；均可选，管理端可配
- 抽奖管理端新增「发放抽奖机会」面板（超管填用户 ID + 数量，走 `/api/lottery/chances/grant` 并留审计）
- 抽奖页面全面对接：hero 机会余额徽标、轮次卡展示每人次数/剩余/每次消耗、硬保底与软保底与平滑补偿提示、本轮中奖概率、最近中奖名单、机会不足时按钮禁用；管理端轮次管理显示规则摘要（次数/机会/三类保底）
- 抽奖任务与资产：行为任务目录（签到/浏览自助领取，下单由业务子系统核销）+ 每日限领；抽奖积分（`assetBalance`）按可配汇率 `LOTTERY_CHANCE_EXCHANGE_COST` 兑换机会，超管可发放积分；页面新增「我的抽奖机会」钱包面板
- 抽奖三层库存：进程内售罄快速拒绝（TTL）→ Redis 预热库存 + Lua 原子预扣（`redisService.decrementIfAtLeast`，未配置时回落 DB 权威）→ DB 快照 `remaining > 0` 校验；抽奖落库失败时机会与 Redis 库存双双回补
- 抽奖 Pacing：奖品级 `pacing = { periodMs, quotaPerWindow }`，时间窗配额用尽权重归零，中奖后按窗计数
- 抽奖对账：T+0（DB 剩余 vs 中奖推算 vs Redis 计数，5 分钟定时 + 超管端点）与 T+1（用户价值 vs 中奖价值）报表，管理端可一键运行
- 抽奖中台 PRD 与实施清单落盘 `docs/plans/2026-10-11-lottery-platform-prd.md`（产品蓝图 + 看门狗设计 + 分阶段勾选清单）
- 任务队列看门狗硬化（Express + MongoDB 轻量队列，当前用于 TTS 生成，后续抽奖履约复用）：长任务心跳续租（`renewJobLease`，租约 1/3 周期）；看门狗回收改为**原子条件更新**（逐条 `findOneAndUpdate`，条件含 `status/leaseExpiresAt/attempts`，不被续租/完成抢先误杀）；终态写入（`completeJob`/`failJob`）owner 不匹配时旧 Worker 放弃提交与用户通知（防重叠消费）；死信任务一轮回收合并一封告警
- 告警通道：只走**邮件**（admin/superadmin 团队）+ 可选 `ALERT_WEBHOOK_URL` webhook，无钉钉/企业微信；新增 `services/adminAlertService.ts` 并写入 `.env.example`

---

## 📝 许可证

> [!CAUTION]
> 本项目采用自定义许可证，**并非** MIT 或其他常见开源许可证。使用、修改或分发本项目代码前，请务必完整阅读 [LICENSE](LICENSE) 文件。违反许可证条款的行为，由使用者自行承担全部法律责任。

[Self-written License](LICENSE)

---

## 👥 贡献

欢迎提交 Issue 和 Pull Request。

## 📞 支持

- 🐛 Bug 报告: [GitHub Issues](../../issues)
- 💬 讨论: [GitHub Discussions](../../discussions)

---

**版本**: 2026-10-10
