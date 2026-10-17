# doc-tool（Markdown → Word 批量转换）全量审查与修复 — 2026-10-17

> 依据 `F:\Repositories\GitHub\verified-methodology.md`：先静态通读并落盘清单，再按编号逐条修复；
> 本机**不构建 / 不测试 / 不装依赖**，结论以 GitHub Actions 为准。
> 参考方案：`docs/plans/2026-10-10-doctool-md2docx-port.md`（§5 契约 / §6 前端 / §7 安全 / §9 验证判据）。
> 方式：逐文件通读 `src/docTool/**`、`src/models/docToolModels.ts`、`src/routes/docToolRoutes.ts`、
> `frontend/src/api/docTool.ts`、`frontend/src/components/docTool/**`、上层融合页、现有测试与 Dockerfile 的 pandoc 层；
> 只跑只读检索与 `node scripts/governance/*.js`（ts-file-size / openapi-drift / frontend-design-language）。
> 基线：工作树含他人 WIP（`ModListEditor.tsx` / `ModListPage.tsx` / `TigerAdventure.tsx`，本轮**未触碰**）。

## 一、结论摘要

后端骨架（pandoc 探测、串行队列、任务状态机、Mongo Date/TTL、内置 zip、路径字符串守界、spawn 数组传参）
与方案一致，**没有命令注入面**（pandoc 全部走 `spawn(bin, args)`，用户值只出现在 `-o` 与 `--reference-doc=`）。
本轮修掉的主要是**边界与生命周期**问题，集中在四类：

1. **文件生命周期**：上传失败残留临时文件、同批同名静默覆盖、删除任务误删「不是本任务产出」的文件、
   overwrite 中途失败截断旧产物。
2. **路径安全**：字符串守界看不出符号链接；下载/打包/转换三处补齐 realpath 守界。
3. **契约一致性**：落库未归一的相对路径、重复文件、参考样式扩展名、失效模板回显、cleanup 无上限。
4. **前端状态与可达性**：批量模式缺同意闸门（403 后无人接住）、默认勾选已是最新的项、运行中可重试。

发现 38 条（高 2 / 中 13 / 低 23），**已修 27 条，挂起 11 条**（全部给出不修理由）。
另补 4 组测试：任务状态机、政策同意闸门、runtime/zip/HTTP 边界、前端轮询与 403。

## 二、发现清单

| 编号 | 严重度 | 侧 | 位置 | 类型 | 处置 |
|---|---|---|---|---|---|
| DT-01 | 高 | 后端 | `src/docTool/http/docToolHttp.ts:326-345` | multer 报错时已落盘的临时文件不清理（磁盘泄漏，且不在任何列表里） | 已修 |
| DT-02 | 中 | 后端 | `docToolHttp.ts:368-410` | 同批两个文件声称同一 `relPaths` 时后者静默覆盖前者（用户少一个文件） | 已修 |
| DT-03 | 低 | 后端 | `docToolHttp.ts:411-424` | `describeEntry` 返回 null 时已搬进 inbox 的文件既不返回也不删除 | 已修 |
| DT-04 | 中 | 后端 | `docToolHttp.ts:473-495` | `files[]` 原串落库：`sub\a.md`、`/inbox/a.md` 在 Linux 上让 runner 解析到别处（每个文件失败） | 已修 |
| DT-05 | 中 | 后端 | `docToolHttp.ts:483` | 同一批 `files` 重复列出同一文件时转两次（rename 策略多一份「(2)」） | 已修 |
| DT-06 | 中 | 后端 | `docToolHttp.ts:503-524`、`jobs/docJobRunner.ts:211-225` | 参考样式不校验 `.docx`/存在性；偏好里的失效路径会让每个文件各失败一次 | 已修 |
| DT-07 | 中 | 后端 | `docToolHttp.ts:214-222` | `GET /settings` 回显已被清理的模板路径（下拉框选不中、提交必失败） | 已修 |
| DT-08 | 低 | 后端 | `docToolHttp.ts:263-266` | `GET /files` 的非法 `outDir` 回落空串（隐式变成 `out`）而不是已保存偏好 | 已修 |
| DT-09 | 高 | 后端 | `jobs/docArtifactCleanup.ts:35-42` | 删除任务会删掉 **skipped 项** 指向的既有产物（不是本任务生成的） | 已修 |
| DT-10 | 中 | 后端 | `docToolHttp.ts:609-618`、`docJobRunner.ts:120-130` | 删除排队中任务与 runner 取值有竞态、队列残留占着 `isActive` 判断 | 已修 |
| DT-11 | 中 | 后端 | `docToolHttp.ts:140-148,658,688,716`、`docJobRunner.ts:198-210` | 下载/打包/转换只做字符串守界，用户目录里的符号链接可指向外部文件 | 已修 |
| DT-12 | 中 | 后端 | `docToolHttp.ts:767-780` | `keepDays` 无上限：`1e9` 等于「清空全部产物」 | 已修 |
| DT-13 | 低 | 后端 | `docToolHttp.ts:352-358` | 上传总大小在全部落盘后才检查（最坏 300×8 MB 先写盘） | 挂起（见 §四） |
| DT-14 | 中 | 后端 | `src/docTool/converter.ts:154-160` | pandoc 无沙箱：Markdown 内的本地文件引用/远程图片会读宿主文件或发内网请求 | 挂起（见 §四） |
| DT-15 | 低 | 后端 | `docToolHttp.ts:111` | 每个 `/health`、`/settings`、`/jobs` 都同步 `spawnSync pandoc --version`（阻塞事件循环） | 挂起（见 §四） |
| DT-16 | 低 | 契约 | `src/routes/docToolRoutes.ts:41-50` | 方案 §4 写「用户态」，实现为 `authenticateAdmin`（普通用户 403） | 挂起（见 §四） |
| DT-17 | 中 | 后端 | `src/docTool/converter.ts:154-186` | overwrite 直接写目标：pandoc 中途失败会把上一份好产物截断 | 已修 |
| DT-18 | 低 | 契约 | `converter.ts:94-101` | skip 策略下目标存在仍报「待更新」，与实际「什么都不做」矛盾，且被「只选需要生成的」选中 | 已修 |
| DT-19 | 低 | 后端 | `converter.ts:48-53` | 文件名恰为 `.md` 时产出隐藏的 `.docx`（收集阶段会跳过隐藏项） | 已修 |
| DT-20 | 中 | 后端 | `src/docTool/zipStore.ts:65,117` | zip 条目名没有第二道穿越/绝对路径防护（调用方已清洗，但不是最后一道闸） | 已修 |
| DT-21 | 低 | 后端 | `zipStore.ts:95-100,163` | 打包把全部条目留在内存再 concat（峰值约 2× 上限） | 挂起（见 §四） |
| DT-22 | 低 | 后端 | `zipStore.ts:7-8` | 不支持 zip64（>4 GB / >65535 项） | 挂起（已由上限约束） |
| DT-23 | 低 | 后端 | `runtime.ts:133-139` | `relInside` 只做字符串比较，语义上不覆盖符号链接 | 已修（新增 `realInside`） |
| DT-24 | 低 | 后端 | `docJobRunner.ts:99-111` | 取消只发默认 `SIGTERM`，不升级 `SIGKILL` | 挂起（见 §四） |
| DT-25 | 低 | 后端 | `jobs/docJobRunner.ts:169-180` | 删除后队列残留（同 DT-10） | 已修（`discard`） |
| DT-26 | 低 | 后端 | `docToolHttp.ts:460-470` | `countActive` 与 `create` 之间竞态，并发提交可超配额一条 | 挂起（见 §四） |
| DT-27 | 低 | 后端 | `models/docToolModels.ts:107-120` | 保留期 TTL 在模块加载时读 env，改 env 不会更新既有索引 | 挂起（现有注释已说明，属 Mongo 索引物理属性） |
| DT-28 | 低 | 后端 | `settingsStore.ts:59-67` | 并发 upsert 撞唯一索引会 500（双击保存） | 挂起（见 §四） |
| DT-29 | 中 | 前端 | `frontend/src/components/MarkdownExportPage.tsx:581-588` | 批量模式没有 `FeatureConsentGate`：403 后提示「已打开同意清单」但没有任何清单出现 | 已修 |
| DT-30 | 中 | 前端 | `frontend/src/components/docTool/DocBatchPanel.tsx:181,227,259,264,513,555,572` | 默认勾选包含「已是最新」项，rename 策略下重转会多出「(2)」副本 | 已修 |
| DT-31 | 低 | 前端 | `DocBatchPanel.tsx:282-284` | 上传全部被拒时仍提示「已上传 N 个文件」（N 取的是选择数） | 已修 |
| DT-32 | 低 | 前端 | `DocJobProgress.tsx:386-391` | 运行中可点「只重试失败项」，会用半截结果新建任务并与当前任务抢产物 | 已修 |
| DT-33 | 低 | 前端 | `frontend/src/api/docTool.ts:128-140` | `ReferenceTemplate` 接口重复声明两次（TS 合并后无害，但是死代码） | 已修 |
| DT-34 | 低 | 前端 | `DocFileList.tsx:72-75` | 「打包下载已转换的」的路径集合未去重 | 已修 |
| DT-35 | 低 | 前端 | `DocBatchPanel.tsx:255-260` | `changeConflict` 两个语句挤在一行（可读性，无行为差异） | 已修 |
| DT-36 | 低 | 测试 | `frontend/src/tests/docBatchPanel.test.tsx:128-137` | 替身没给 `downloadFile`/`downloadReport`/`downloadBundle` 返回 Promise，点击处理会 `.catch` undefined 抛 TypeError | 已修 |
| DT-37 | 低 | 后端 | `Dockerfile:178-186` | `/releases/latest` 的 HEAD 无重试；解析出的版本号未做形状校验 | 已修 |
| DT-38 | 低 | 后端 | `Dockerfile:155-165` | 不钉 SHA256（上游不发布校验和） | 挂起（方案 §3 已明确取舍，层末 `pandoc --version` 兜底） |

### 逐条细节（症状 / 根因 / 复现条件 / 改法）

- **DT-01**：multer 的 `fileFilter`/`limits.fileSize` 在任何文件失败时都会让整个请求报错，但**已经落盘的**
  `upload-*` 临时文件不会回滚。复现：上传 2 个合法 md + 1 个超过 `maxFileBytes` 的 md → 400，inbox 里残留
  2 个 `upload-…` 文件。改法：调用前现读 `req.files`（multer 边解析边推送，提前取快照是空的），
  在 catch 里逐个 `rmSync`。
- **DT-02**：`relPaths` 是文本字段，两个文件可以声明同一落点；`rmSync(destAbs)+rename` 让后者覆盖前者且
  两行都返回 200。改法：批内 `seenDest` 去重，第二份进 `rejected` 并清理临时文件。
- **DT-03**：`describeEntry` 只在 `relInside` 为空时返回 null（例如 rel 恰为根目录）；此时文件已 rename 到
  inbox，既不在返回的 `files` 里也没被删。改法：拒绝时把已搬入的文件删掉。
- **DT-04**：HTTP 用 `resolveUserPath(rel)` 校验的是**清洗后**的路径，落库却是原串。`sub\a.md` 在 Linux 上
  是文件名里带反斜杠，文件不存在；`/inbox/a.md` 在 Linux 上 `path.resolve` 得到绝对路径 → runner 判越界。
  改法：先 `sanitizeRelPath` 再校验与落库。
- **DT-05**：同一文件在 `files[]` 里出现两次 → runner 顺序转两次；rename 策略第二遍产出 `a (2).docx`。
  改法：保序去重（同时让 DT-04 的归一参与去重）。
- **DT-06**：`referenceDoc` 只查 `isFile()`，`.md` 也放过 → pandoc 每个文件都失败；偏好路径可能已被清理，
  且偏好分支没有任何校验。改法：显式传参必须 `.docx` + 存在（否则 400），偏好带出的失效值静默丢弃；
  runner 侧再复核一次（`.docx` + 根内 + 真实文件），防止历史记录绕过。
- **DT-07**：模板被保留期清理后 `prefs.referenceDoc` 仍指向它；前端 `<select value>` 没有匹配项，
  界面显示下一项但状态仍是幽灵值。改法：`GET /settings` 校验后清空。
- **DT-08**：`outDir=..` → `sanitizeRelPath` 返回 null → 取 `""`；`destForFile` 把空串当 `out`，
  于是列表预告与用户已保存的设置不一致。改法：回落 `prefs.outDir`。
- **DT-09**：`purgeDocArtifacts` 遍历**所有** items，skipped 项的 `destRel` 指向任务开始前就存在的那份。
  复现：先用 skip 策略转 `a.md`（`out/a.docx` 已存在，任务记为 skipped），再删除任务 → `out/a.docx` 被删。
  改法：只删 `status === "ok"` 的项，并在函数注释里写明口径。
- **DT-10**：删除排队任务后 id 仍留在 `runner.queue`；runner 取不到记录会空转返回，但 `isActive()` 在
  这段时间仍为 true，取消/删除的判断失真。反向竞态更严重：runner 已取到记录但还没写 running 时删除，
  产物会落在删除后的任务名下（无人清理）。改法：删除接口先同步 `discard()` 摘队列，摘完仍在 active 的（已在执行）回 409；排队中的可直接删除。
- **DT-11**：`relInside` 是纯字符串比较。复现：inbox 里存在符号链接 `link.md -> /etc/passwd`（本功能不提供
  创建链接的入口，但工作目录可能是共享卷）→ 下载/打包/转换都会读到根外文件。改法：新增 `realInside`
  （对 root 与 target 的最深已存在祖先做 realpath），用在下载、两个 bundle、task 源文件/输出落点。
- **DT-12**：`keepDays` 只判 `> 0`。`1e9` → cutoff ≈ 1970，`sweepExpiredArtifacts` 删光 out/。
  改法：`[1, 365]` 钳制，非法值回落保留期。
- **DT-13**：multer 不支持「累计大小」上限，只能在解析完成后统计。本次保留现状（单任务最坏
  300×8 MB=2.4 GB），见 §四的建议。
- **DT-14**：pandoc 在 docx 输出时会 fetch 图片资源：本地路径可读宿主文件、`http(s)` 会从容器发起请求
  （内网元数据/服务探测）。`--sandbox` 只限制 reader/writer 的文件 IO、**不阻断网络**，而且它会拒绝
  `--reference-doc` 之外的资源读取——是否放行参考样式尚未在真机取证（本机禁跑、CI 无 pandoc 集成用例），
  贸然打开会把「带图片/相对资源的文档」整体转坏。见 §四的处置建议。
- **DT-17**：转换前先 `ensureDir`，然后让 pandoc 直接写 `-o target`。pandoc 打开输出文件后失败（磁盘满、
  被 kill）会留下 0 字节/半截文件，overwrite 模式下等于毁掉旧产物。改法：写同目录 `.<name>.tmp-*.docx`
  再 `renameSync` 到目标；失败清理临时文件。临时名保留 `.docx` 后缀，因为 pandoc 用 `-o` 扩展名判格式。
- **DT-18**：skip 的语义是「目标存在就不写」，但徽章按 mtime 报「待更新」，且「只选需要生成的」会选中它，
  点一次转换得到一条 skipped。改法：skip + 目标存在 → `fresh`。
- **DT-19**：`basename(".md")` 去掉后缀为空串 → `.docx` 是隐藏文件，`collectMarkdown` 又会跳过隐藏项。
  改法：空 base 回落 `document`。
- **DT-20**：条目名来自 `destRel`/请求体，调用方已 `sanitizeRelPath`，但 zip 是「把数据交给解压方」的最后
  一道关口。改法：写侧 `safeEntryName` 拒绝绝对路径、盘符、控制字符与 `..` 段（被拒条目计入 `skipped`）。
- **DT-24**：取消用 `child.kill()`（SIGTERM）。pandoc 正常响应 SIGTERM；加 SIGKILL 升级需要额外定时器，
  在 `detectOpenHandles` 的测试环境下反而是噪声源，暂不引入。
- **DT-27**：TTL 是索引物理属性，方案已要求「存量部署改保留期需重建索引」；本次不做迁移脚本。
- **DT-29**：`DocConvertPage` 有门禁，`MarkdownExportPage` 的批量页没有；面板里的 `describeError` 会
  `dispatchEvent(POLICY_CONSENT_REQUIRED_EVENT)`，但没有监听者。改法：用同一个
  `<FeatureConsentGate feature="doc-tool">` 包住。
- **DT-30**：初始/换策略/换递归/换输出位置/重试加载都用「全选」；`fresh` 项在 rename 策略下重转会产生
  新副本。改法：这些自动重载统一用「只选需要生成的」，用户仍可手动「全选」。
- **DT-36**：`vi.fn()` 默认返回 `undefined`，而面板对下载方法直接 `.catch()`。补齐 `mockResolvedValue`。
- **DT-37**：`curl -fsSLI` 没有 `--retry`，GitHub 偶发 5xx 会让构建红；解析失败时 `version` 可能是
  HTML/相对 URL，加 `[0-9]*` 形状校验能在拉资产前就给出可读错误。

## 三、逐项核对（未发现缺陷 / 已符合）

| 核对项 | 结论 |
|---|---|
| §5 端点齐全性 | health / settings(GET,PUTh) / files / upload / jobs(POST,GET) / jobs/:id(GET,DELETE) / cancel / report / bundle / files/download / files/bundle（契约外补充，已写 OpenAPI）/ templates / cleanup 全部实现，方法与路径一致 |
| 响应字段与状态码 | 创建任务 `{jobId}`、列表 `{jobs}`、详情 `{job}`、报告 `text/plain`、打包 `application/zip`、引擎不可用 503、配额 429、越界 400、他人任务 404 —— 与实现一致；`/health` 额外回 `workDir`/`defaultReference`（契约超集） |
| settings 只接受已知键 | `applyPrefs` 白名单 5 键，未知键丢弃；TTL/枚举非法值回落默认 |
| 列表 limit 钳制 | HTTP `Math.min(...,100)` + store 内再钳一次；0/NaN 回落 20 |
| owner 隔离 | `ownJob` 先取记录再比 `userId`，不一致 404（不泄露存在性）；列表按 `userId` 过滤 |
| 命令注入 | `runPandoc` 全程 `spawn(bin, args)`；`buildReferenceDoc` 固定两参数；用户值只出现在 `-o` 与 `--reference-doc=` |
| Mongo 时间字段 / TTL | `createdAt/startedAt/finishedAt` 均为 `Date`；`createdAt` TTL 7 天 + `{userId,createdAt}` + `{status,createdAt}` 索引 |
| 串行队列 | `DocJobRunner(concurrency=1)`，单例装配（serverRuntime），跨入口共享同一队列 |
| 取消 | 同步 `kill()` 当前子进程 + 落 `cancelRequested`；终态幂等；启动/恢复时把「已请求取消的 queued」直接判 cancelled |
| 重启恢复 | `running → failed("服务重启…")`；`queued` 重新入队；`ensureDocJobRecovery` 幂等、延后 2500 ms |
| 进度/统计自洽 | `progress = round(done/total*100)`，取消时停在实际 done；`succeeded/partial/failed` 三分支与计数一致 |
| 文件数上限 | HTTP 与 runner 各校验一次 `maxFilesPerJob` |
| zip 结构 | CRC32 校验向量已测（`123456789 → 0xCBF43926`）；EOCD/中央目录/local header 偏移一致；UTF-8 标志位；deflate/store 回退 |
| Docker | 版本解析走 `/releases/latest` 的 302 终址；`x86_64→amd64`、`aarch64→arm64`；只拷 `bin/pandoc`；层末 `pandoc --version` 自证；静态 ELF 结论见方案 §3 |
| 前端懒加载 | `MarkdownExportPage` 用 `React.lazy` 二次懒加载 `DocBatchPanel`；`DocConvertPage` 本身由 `App.tsx` 懒加载；首屏禁名单里的 `docx` 不受影响 |
| 轮询 | 1s；终态不排下一拍；`document.hidden` 停表、`visibilitychange` 续表；effect cleanup 清 `setTimeout`（本轮补了卸载回归用例） |
| 可访问名 | 每行下载按钮 `aria-label="下载 <basename>"`；筛选/输出目录/参考样式均有可读标签；分段按钮 `aria-pressed` |
| OpenAPI | 注释全部在 `src/routes/**`（swagger-jsdoc 只扫该目录）；`check-openapi-drift` 通过（267 路径对账） |
| 依赖 | 未新增任何依赖（zip 用 `node:zlib`，HTTP 已有 multer） |

### 现有用例断言强度核对

| 用例文件 | 结论 |
|---|---|
| `src/tests/docToolRuntime.test.ts` | `relInside` 越界、`sanitizeRelPath` 拒绝面、冲突命名 `(2)/(3)`、`collectMarkdown` 递归/隐藏项均有真断言；本轮补 `realInside` 符号链接与「尚不存在落点」 |
| `src/tests/docToolZip.test.ts` | 用**独立读回器**（EOCD→中央目录→local header）校验，不复用写侧函数，不存在「写错也读得回来」的自证；CRC32 有公开校验向量 |
| `src/tests/docToolConverter.test.ts` | 冲突三策略、参数落点、失败原因、报告文本都断言到具体值；本轮把 `-o` 断言从「最终路径」改为「临时文件 + 最终路径」，并补失败清理 |
| `src/tests/docJobRunner.test.ts` | 已有状态机、取消、日志上限；本轮继续用它做回归（顺带确认恢复路径不会因 `realInside` 误伤） |
| `src/tests/docArtifactCleanup.test.ts` | 越界/目录/入参保留都有真断言；本轮只改「哪些 item 该删」，其用例全部使用 `status: "ok"`，语义不变 |
| `frontend/src/tests/docBatchPanel.test.tsx` | 6 条原用例都渲染真实组件并断言 DOM；缺 Promise 替身会让下载点击抛 TypeError（DT-36），本轮补齐并新增 4 条 |

## 四、未修项与理由

1. **DT-13 上传总大小的事后检查**：multer 没有「累计字节」限流钩子，要做到边写边拒需要自写 storage engine。
   现有上限（单文件 8 MB / 单次 300 个）已把最坏值约束在 2.4 GB；建议在部署侧给 `data/doc-tool` 一个磁盘配额，
   或在反代限制请求体（`client_max_body_size`），这属于部署参数而非代码修复。
2. **DT-14 pandoc 的本地文件/网络访问**：`--sandbox` 的实测行为（是否放行 `--reference-doc`、对图片资源的影响）
   需要真 pandoc + 真实文档取证；本机禁跑、CI 只有 `pandoc --version`。当前功能是 **admin-only + 按用户同意**，
   信任边界比公开功能窄。建议下一步：在 Docker CI 里加一个「用 sandbox 转一份含图文档」的集成用例，
   通过后默认打开 `--sandbox`，并对容器出站做网络策略（或后续加 URL 白名单）。
3. **DT-15 同步探测**：`/jobs` 每次提交最多阻塞 ~几十毫秒（探测失败时才逼近 15 s 超时）。探测结果对
   「容器里换了 pandoc」需要尽快反映，缓存会引入新的不直观行为；限流已把频率压住，保持现状。
4. **DT-16 访问模型与方案不一致**：方案 §4 写「用户态（authenticateToken）」，实现是 `authenticateAdmin`
   （前端 `renderAdminRoute`、导航 `requiredRole: 'admin'`、路由挂载说明三处一致）。这是产品权限决策，
   不是缺陷，本轮**不擅自放开**；若 owner 决定对普通用户开放，需要同时改 `docToolRoutes.ts` 的
   `router.use(authenticateAdmin)` 与前端两处入口，并重新评估每用户磁盘配额。
5. **DT-21 / DT-22 zip 内存与 zip64**：调用方把单次打包限制在 256 MB / 300 项，落在 Node Buffer 可承受范围；
   流式打包需要改 HTTP 管道（且要处理客户端断开），当前没有这个量级的需求。
6. **DT-26 配额竞态**：`countActive` 与 `create` 之间无事务；并发两个请求最多超配额一条，随后一次提交会被 429。
   要彻底修需要 Mongo 事务/计数器文档，收益不抵复杂度。
7. **DT-28 并发 upsert**：唯一索引会兜住重复行（不会脏数据），请求返回 500 需要用户重试；双击保存是唯一触发路径。
8. **DT-38 不钉 pandoc 校验和**：方案 §3 已论证（上游不发 checksums，自钉会变成「新版校旧哈希」的假失败）；
   层末 `pandoc --version` 是本次打包的判据。
9. **DT-24 SIGTERM 不升级 SIGKILL**：pandoc 对 SIGTERM 响应良好；升级会引入额外定时器。
10. **DT-27 保留期 TTL 不能热更新**：`expireAfterSeconds` 是索引物理属性，改 env 只会影响新索引；
    存量部署要改保留期需显式重建索引（现有注释已说明），不做自动迁移。

## 五、本轮改动与测试

**生产代码**

| 文件 | 改动 |
|---|---|
| `src/docTool/runtime.ts` | 新增 `realInside`（realpath 守界）与 `isDocxFile` |
| `src/docTool/converter.ts` | 临时文件 + 原子改名；skip 策略的 freshness；空 basename 回落 |
| `src/docTool/jobs/docJobRunner.ts` | 源/输出/参考样式三重校验（含符号链接）；新增 `discard()` |
| `src/docTool/jobs/docArtifactCleanup.ts` | 只删 `ok` 项的产物 |
| `src/docTool/zipStore.ts` | `safeEntryName` 第二道穿越防护 |
| `src/docTool/http/docToolHttp.ts` | 上传清理/去重/归一；参考样式口径；settings 清洗；下载/打包守界；cleanup 钳制；删除竞态 |
| `src/routes/docToolRoutes.ts` | 仅删除接口的 `@openapi` 描述与行为对齐（未改路径） |
| `Dockerfile` | pandoc 版本解析加重试与形状校验（仅 pandoc 层） |
| `frontend/src/api/docTool.ts` | 删除重复接口声明 |
| `frontend/src/components/docTool/DocBatchPanel.tsx` | 默认勾选「需要生成的」；上传提示准确；格式整理 |
| `frontend/src/components/docTool/DocFileList.tsx` | 打包路径去重 |
| `frontend/src/components/docTool/DocJobProgress.tsx` | 运行中禁重试 |
| `frontend/src/components/MarkdownExportPage.tsx` | 批量模式加同意闸门 |

**新增/补齐测试**

| 文件 | 覆盖 |
|---|---|
| `src/tests/docToolJobRunner.test.ts`（新） | queued→running→succeeded/partial/failed；超额文件数不调用转换；取消 kill 子进程并落 cancelled；重启恢复三条分支；`discard` 不留队头；`recover` 幂等 |
| `src/tests/docToolConsent.test.ts`（新） | 已同意放行、撤销同意 403 + `POLICY_CONSENT_REQUIRED`、未登录 401、服务异常 fail-closed、按 userId 判定 |
| `src/tests/docToolRuntime.test.ts` | `realInside` 符号链接逃逸 / 尚不存在的落点；`isDocxFile` |
| `src/tests/docToolConverter.test.ts` | 临时文件命名与清理、失败不截断旧产物、skip 的 freshness、空 basename |
| `src/tests/docToolZip.test.ts` | 条目名穿越/绝对路径被拒 |
| `src/tests/docToolHttp.test.ts` | 重复 files 去重与反斜杠归一、参考样式 `.docx`、失效偏好静默忽略、删除只清 ok 产物、同名上传拒绝、settings 清洗、cleanup 钳制 |
| `frontend/src/tests/docBatchPanel.test.tsx` | 默认勾选、卸载停轮询、403 通知门禁、运行中禁重试、报告/打包按钮、下载方法 Promise 替身 |

**静态自检**（本机允许的只读治理脚本）

- `node scripts/governance/check-ts-file-size.js` → 通过（docTool 最大文件 `docToolHttp.ts` 785 行，远低于 1500）
- `node scripts/governance/check-openapi-drift.js` → 通过（267 路径对账）
- `node scripts/governance/check-frontend-design-language.js` → 通过（未新增设计语言命中）

> 构建、类型检查、Jest、Vitest、Docker 均**未在本机运行**，最终以 `Node Verification` / `Quality Guardrails` / `Docker` 三个 workflow 为准。

## 六、需要协调者应用的接线/注册补丁

本轮核对后**没有必须由协调者应用的改动**：`/api/doc-tool` 已在 `src/routes/routeModules/postTamperModules.ts`
（`doc-tool-routes`，挂 `authenticateToken`）与 `routeLimiterModules.ts`（`doc-tool-limiter`）注册，
限流器 `docToolLimiter` 已在 `src/middleware/routeLimiters.ts` 定义并导出，`featureConsent.ts` 已有
`doc-tool` 键，前端 `/doc-convert` 路由、标题与导航入口均已存在。因此本轮不产出越权补丁。

需要 owner 决策的两项（不影响本轮合并）：

1. **DT-16 访问档位**：保持 admin-only（当前实现）还是按方案 §4 放开到登录用户。放开需改
   `src/routes/docToolRoutes.ts` 的 `router.use(authenticateAdmin)` 与前端 `App.tsx:765` /
   `navConfig.ts:180` 两处 `requiredRole`，并评估磁盘配额。
2. **DT-14 pandoc 沙箱**：需要一条 Docker 集成用例（真实 pandoc + 含图 Markdown）作为开关前提；
   在那之前该风险随 admin-only 信任边界接受。
