// 「Markdown → Word 批量转换」用户态路由（/api/doc-tool）：普通登录用户即可使用，
// 但需先在自己的账号下同意相关条款（见下方 requireFeatureConsent("doc-tool")）。
// 与 src/docTool/serverRuntime.ts 共用同一份 store / settingsStore / runner 单例，
// 保证同一进程只有一个串行队列；作用域由 http/docToolHttp.ts 锁死在 users/<uid>/ 内。
//
// 为什么 OpenAPI 注释写在本文件而不是 docToolHttp.ts：swagger-jsdoc 只扫 `src/routes/**/*.ts`
// （scripts/generate-openapi.js 的 apis glob），`check:openapi-drift` 也只从那里对账注释路径 ——
// 注释放错目录，端点就会从 openapi.json 里静默消失，构建仍然绿。
import type { Request } from "express";
import { createDocToolRouter } from "../docTool/http/docToolHttp";
import { resolveDocToolRoot, resolvePandocBin } from "../docTool/runtime";
import {
  ensureDocJobRecovery,
  getDocJobStore,
  getDocRunner,
  getDocSettingsStore,
} from "../docTool/serverRuntime";
import { docLimitsFromEnv } from "../docTool/types";
import { requireFeatureConsent } from "../middleware/featureConsent";
import type { AuthenticatedRequest } from "../types/authRequest";

const router = createDocToolRouter({
  store: getDocJobStore(),
  settingsStore: getDocSettingsStore(),
  runner: getDocRunner(),
  workRoot: resolveDocToolRoot(),
  limits: docLimitsFromEnv(),
  pandocBin: resolvePandocBin(),
  // 挂载层（routeModules/postTamperModules.ts）已挂 authenticateToken；这里只做「有没有登录」的复核
  resolveUser: (req: Request) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user?.id) return null;
    return { id: String(user.id), username: String(user.username || user.id) };
  },
});

// 进程重启自恢复（整队列一次，幂等；见 serverRuntime.ensureDocJobRecovery）
ensureDocJobRecovery();

// 整棵 /api/doc-tool 都要求「用户自己同意过相关条款」——上传到服务端处理的文件由本服务端转换。
// 判定按 userId（见 middleware/featureConsent），同设备换个账号不会蹭到上一位用户的同意。
// 挂载层（routeModules/postTamperModules.ts）已挂 authenticateToken，中间件内仍自己判一次未登录，
// 便于单测直挂 router（如 docToolHttp.test.ts 的挂法）时独立覆盖 401 / 403 两条分支。
// 端点因此多一个响应：403 POLICY_CONSENT_REQUIRED（带缺失的条款清单，前端据此弹同意面板）。
router.use(requireFeatureConsent("doc-tool"));

/**
 * @openapi
 * /doc-tool/health:
 *   get:
 *     summary: 转换引擎与限额状态
 *     description: 返回 pandoc 可用性、工作目录与本次部署的限额。引擎不可用时 ok=false，诊断原因在 pandoc.error（界面「详情」折叠区展示）。
 *     responses:
 *       200:
 *         description: 引擎可用性与限额
 *       401:
 *         description: 未登录
 */
/**
 * @openapi
 * /doc-tool/settings:
 *   get:
 *     summary: 读取转换设置
 *     description: 返回 pandoc 状态、限额、该用户上次使用的偏好，以及已生成的参考样式模板清单。
 *     responses:
 *       200:
 *         description: 设置视图
 *       401:
 *         description: 未登录
 *   put:
 *     summary: 保存转换设置
 *     description: 只接受已知偏好键，非法值回落默认；下次打开页面自动带出。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               prefs:
 *                 type: object
 *                 properties:
 *                   conflict:
 *                     type: string
 *                     enum: [skip, rename, overwrite]
 *                   outMode:
 *                     type: string
 *                     enum: [alongside, custom]
 *                   outDir:
 *                     type: string
 *                   recursive:
 *                     type: boolean
 *                   referenceDoc:
 *                     type: string
 *     responses:
 *       200:
 *         description: 保存后的偏好
 *       401:
 *         description: 未登录
 */
/**
 * @openapi
 * /doc-tool/files:
 *   get:
 *     summary: 列出已上传的 Markdown
 *     description: 扫描该用户 inbox 下的 .md；recursive 控制是否进入子目录，conflict 会改变 destRel 与「会另存为」标记。
 *     parameters:
 *       - in: query
 *         name: recursive
 *         required: false
 *         schema:
 *           type: boolean
 *       - in: query
 *         name: conflict
 *         required: false
 *         schema:
 *           type: string
 *           enum: [skip, rename, overwrite]
 *     responses:
 *       200:
 *         description: 文件清单与分组计数
 *       401:
 *         description: 未登录
 */
/**
 * @openapi
 * /doc-tool/files/download:
 *   get:
 *     summary: 下载单个产物文件
 *     description: 只能下载调用者自己目录内的文件；响应头里的文件名只取 basename，不回显目录结构。
 *     parameters:
 *       - in: query
 *         name: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 文件内容
 *       400:
 *         description: 路径缺失或非法
 *       401:
 *         description: 未登录
 *       404:
 *         description: 文件不存在
 */
/**
 * @openapi
 * /doc-tool/files/bundle:
 *   post:
 *     summary: 打包下载已转换好的文档
 *     description: 按传入的相对路径把磁盘上已有的 .docx 打成 zip（不重新转换）；越界或不存在的条目静默跳过，全不可用时 400。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               paths:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: zip 包
 *       400:
 *         description: 没有可打包的文件
 *       401:
 *         description: 未登录
 */
/**
 * @openapi
 * /doc-tool/upload:
 *   post:
 *     summary: 上传 Markdown 文件
 *     description: multipart 表单，字段 files 可重复；relPaths 与 files 同序，用于保留子目录结构（缺失或非法时回落到原文件名）。
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *               relPaths:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: 已接收的文件与未接收的文件（含原因）
 *       400:
 *         description: 未收到文件、类型不支持或超出大小/数量上限
 *       401:
 *         description: 未登录
 */
/**
 * @openapi
 * /doc-tool/jobs:
 *   post:
 *     summary: 创建批量转换任务
 *     description: files 与 recursive 二选一；创建后立即入队（进程内串行）。引擎不可用返回 503，超出并发配额返回 429。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               files:
 *                 type: array
 *                 items:
 *                   type: string
 *               recursive:
 *                 type: boolean
 *               outMode:
 *                 type: string
 *                 enum: [alongside, custom]
 *               outDir:
 *                 type: string
 *               conflict:
 *                 type: string
 *                 enum: [skip, rename, overwrite]
 *               referenceDoc:
 *                 type: string
 *     responses:
 *       200:
 *         description: 任务编号
 *       400:
 *         description: 没有可转换文件、超出单任务文件数或路径非法
 *       401:
 *         description: 未登录
 *       429:
 *         description: 该用户排队/运行中的任务已达上限
 *       503:
 *         description: 转换引擎（pandoc）不可用
 *   get:
 *     summary: 列出我的转换任务
 *     description: 按创建时间倒序返回该用户最近的任务，limit 默认 20、上限 100。
 *     parameters:
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: 任务列表
 *       401:
 *         description: 未登录
 */
/**
 * @openapi
 * /doc-tool/jobs/{id}:
 *   get:
 *     summary: 读取任务详情
 *     description: 返回进度、逐文件结果与日志。不是自己的任务一律 404（不泄露他人任务是否存在）。
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 任务详情
 *       401:
 *         description: 未登录
 *       404:
 *         description: 任务不存在
 *   delete:
 *     summary: 删除任务并清理产物
 *     description: 运行中的任务需先取消；只清理产物，保留用户上传的原稿。
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 已删除的任务产物数
 *       401:
 *         description: 未登录
 *       404:
 *         description: 任务不存在
 *       409:
 *         description: 任务运行中
 */
/**
 * @openapi
 * /doc-tool/jobs/{id}/cancel:
 *   post:
 *     summary: 请求取消任务
 *     description: 取消会立即终止当前 pandoc 子进程；已结束的任务返回现状（幂等）。
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 取消后的任务
 *       401:
 *         description: 未登录
 *       404:
 *         description: 任务不存在
 */
/**
 * @openapi
 * /doc-tool/jobs/{id}/report:
 *   get:
 *     summary: 下载任务报告
 *     description: text/plain 报告：本次策略、结果统计与逐条明细。
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 报告文本
 *       401:
 *         description: 未登录
 *       404:
 *         description: 任务不存在
 */
/**
 * @openapi
 * /doc-tool/jobs/{id}/bundle:
 *   get:
 *     summary: 打包下载成功产物
 *     description: 把成功项打成一个 zip；产物已不在磁盘的条目跳过，不会整体失败。
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: application/zip
 *       401:
 *         description: 未登录
 *       404:
 *         description: 任务不存在
 */
/**
 * @openapi
 * /doc-tool/templates:
 *   post:
 *     summary: 生成默认参考样式模板
 *     description: 用 pandoc 内置的 reference.docx 生成一份模板到用户模板目录，之后可在 Word 里改字体与标题样式。
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *     responses:
 *       200:
 *         description: 生成的模板条目
 *       401:
 *         description: 未登录
 *       500:
 *         description: 生成失败
 *       503:
 *         description: 转换引擎（pandoc）不可用
 */
/**
 * @openapi
 * /doc-tool/cleanup:
 *   post:
 *     summary: 清理过期产物
 *     description: 按保留期清扫用户 out/ 目录下的过期产物，返回删除数。
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               keepDays:
 *                 type: integer
 *     responses:
 *       200:
 *         description: 删除数
 *       401:
 *         description: 未登录
 */
export default router;
