# 2026-10-07 全部修复台账

> 用户已要求停止新增审查并修复全部已确认问题。范围冻结为下表编号；原始症状、行号、触发条件和建议见对应分组报告。证据不足、设计观察、已修、重复项逐条保留去向，不能机械采纳误报。
> 修复工作区：`.codex-worktrees/Synapse-audit-all-20261007`，起点 `cb9fb199`；原 clone 存在其他会话 WIP，本轮不暂存、回滚或代交这些内容。新增验证码提交已纳入起点；重叠项需核对当前代码。
> 约束：本地不构建/测试/lint/装依赖；显式文件白名单，签名 commit，GIT_TERMINAL_PROMPT=0 push；GitHub Actions 是验证依据。

## 冻结清单与逐条去向

| 编号 | 原严重度 | 详细证据 | 处置 |
| --- | --- | --- | --- |
| be-controllers-01 | 高 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-controllers-02 | 高 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-controllers-03 | 中 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-controllers-04 | 中 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-controllers-05 | 中 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-controllers-06 | 中 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-controllers-07 | 中 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-controllers-08 | 中 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-controllers-09 | 低 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-controllers-10 | 低 | [be-controllers.md](./be-controllers.md) | Partially confirmed; fixed with narrower finding — [处置证据](./fix-controllers.md) |
| be-controllers-11 | 低 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-controllers-12 | 低 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-controllers-13 | 低 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-controllers-14 | 低 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-controllers-15 | 低 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-controllers-16 | 低 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-controllers-17 | 低 | [be-controllers.md](./be-controllers.md) | Confirmed; fixed — [处置证据](./fix-controllers.md) |
| be-core-01 | 中 | [be-core.md](./be-core.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| be-core-02 | 中 | [be-core.md](./be-core.md) | 修正文档；漏洞归因证据不足 — [处置证据](./fix-root.md) |
| be-core-03 | 中 | [be-core.md](./be-core.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| be-core-04 | 中 | [be-core.md](./be-core.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| be-core-05 | 中 | [be-core.md](./be-core.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| be-core-06 | 低 | [be-core.md](./be-core.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| be-core-07 | 低 | [be-core.md](./be-core.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| be-core-08 | 低 | [be-core.md](./be-core.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| be-core-09 | 低 | [be-core.md](./be-core.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| be-core-10 | 低 | [be-core.md](./be-core.md) | 不成立 — [处置证据](./fix-root.md) |
| be-core-11 | 低 | [be-core.md](./be-core.md) | 已清理 — [处置证据](./fix-root.md) |
| be-core-12 | 低 | [be-core.md](./be-core.md) | 已加固 — [处置证据](./fix-root.md) |
| be-core-13 | 低 | [be-core.md](./be-core.md) | 随01修复 — [处置证据](./fix-root.md) |
| be-core-14 | 低 | [be-core.md](./be-core.md) | 设计观察 — [处置证据](./fix-root.md) |
| be-core-15 | 低 | [be-core.md](./be-core.md) | 设计观察 — [处置证据](./fix-root.md) |
| be-routes-01 | 高 | [be-routes.md](./be-routes.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| be-routes-02 | 高 | [be-routes.md](./be-routes.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| be-routes-03 | 中 | [be-routes.md](./be-routes.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| be-routes-04 | 中 | [be-routes.md](./be-routes.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| be-routes-05 | 中 | [be-routes.md](./be-routes.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| be-routes-06 | 中 | [be-routes.md](./be-routes.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| be-routes-07 | 中 | [be-routes.md](./be-routes.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| be-routes-08 | 低 | [be-routes.md](./be-routes.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| be-routes-09 | 低 | [be-routes.md](./be-routes.md) | 根协作修复 — [处置证据](./fix-routes-devops.md) |
| be-routes-10 | 低 | [be-routes.md](./be-routes.md) | 原报告不成立 — [处置证据](./fix-routes-devops.md) |
| be-routes-11 | 低 | [be-routes.md](./be-routes.md) | 不成立 — [处置证据](./fix-routes-devops.md) |
| be-routes-12 | 低 | [be-routes.md](./be-routes.md) | 随 01 修复 — [处置证据](./fix-routes-devops.md) |
| be-routes-13 | 低 | [be-routes.md](./be-routes.md) | 设计观察，未接线事实保留 — [处置证据](./fix-routes-devops.md) |
| be-routes-14 | 低 | [be-routes.md](./be-routes.md) | 不成立 — [处置证据](./fix-routes-devops.md) |
| be-routes-15 | 低 | [be-routes.md](./be-routes.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| be-routes-16 | 低 | [be-routes.md](./be-routes.md) | 不成立 — [处置证据](./fix-routes-devops.md) |
| be-routes-17 | 低 | [be-routes.md](./be-routes.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| be-routes-18 | 低 | [be-routes.md](./be-routes.md) | 设计观察 — [处置证据](./fix-routes-devops.md) |
| be-routes-19 | 低 | [be-routes.md](./be-routes.md) | 与控制器组修复合并 — [处置证据](./fix-routes-devops.md) |
| be-routes-20 | 高 | [be-routes.md](./be-routes.md) | 不成立 — [处置证据](./fix-routes-devops.md) |
| be-routes-21 | 低 | [be-routes.md](./be-routes.md) | 设计观察 — [处置证据](./fix-routes-devops.md) |
| be-routes-22 | 低 | [be-routes.md](./be-routes.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| be-routes-23 | 低 | [be-routes.md](./be-routes.md) | 设计观察 — [处置证据](./fix-routes-devops.md) |
| be-routes-24 | 低 | [be-routes.md](./be-routes.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| be-services-1-01 | 高 | [be-services-1.md](./be-services-1.md) | 起点已修，不重复改动 — [处置证据](./fix-services-1.md) |
| be-services-1-02 | 高 | [be-services-1.md](./be-services-1.md) | 已修，待 CI — [处置证据](./fix-services-1.md) |
| be-services-1-03 | 中 | [be-services-1.md](./be-services-1.md) | 已修，待 CI — [处置证据](./fix-services-1.md) |
| be-services-1-04 | 中 | [be-services-1.md](./be-services-1.md) | 已修，待 CI — [处置证据](./fix-services-1.md) |
| be-services-1-05 | 中 | [be-services-1.md](./be-services-1.md) | 已修，待 CI — [处置证据](./fix-services-1.md) |
| be-services-1-06 | 低 | [be-services-1.md](./be-services-1.md) | 已修，待 CI — [处置证据](./fix-services-1.md) |
| be-services-1-07 | 低 | [be-services-1.md](./be-services-1.md) | 已修，待 CI — [处置证据](./fix-services-1.md) |
| be-services-1-08 | 低 | [be-services-1.md](./be-services-1.md) | 已修，待 CI — [处置证据](./fix-services-1.md) |
| be-services-1-09 | 低 | [be-services-1.md](./be-services-1.md) | 已修，待 CI — [处置证据](./fix-services-1.md) |
| be-services-1-10 | 低 | [be-services-1.md](./be-services-1.md) | 已修；GET 合同保留 — [处置证据](./fix-services-1.md) |
| be-services-1-11 | 低 | [be-services-1.md](./be-services-1.md) | 已修失败缓存；既有 TTL 设计保留 — [处置证据](./fix-services-1.md) |
| be-services-1-12 | 低 | [be-services-1.md](./be-services-1.md) | 已修，待 CI — [处置证据](./fix-services-1.md) |
| be-services-1-13 | 低 | [be-services-1.md](./be-services-1.md) | 已修，待 CI — [处置证据](./fix-services-1.md) |
| be-services-1-14 | 低 | [be-services-1.md](./be-services-1.md) | 已修，待 CI — [处置证据](./fix-services-1.md) |
| be-services-2-01 | 高 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-02 | 中 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-03 | 中 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-04 | 中 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-05 | 中 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-06 | 中 | [be-services-2.md](./be-services-2.md) | 已修复并纠正范围 — [处置证据](./fix-services-2.md) |
| be-services-2-07 | 中 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-08 | 中 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-09 | 中 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-10 | 中 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-11 | 低 | [be-services-2.md](./be-services-2.md) | 不成立 — [处置证据](./fix-services-2.md) |
| be-services-2-12 | 低 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-13 | 低 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-14 | 低 | [be-services-2.md](./be-services-2.md) | 不成立 — [处置证据](./fix-services-2.md) |
| be-services-2-15 | 低 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-16 | 低 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-17 | 低 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-18 | 低 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-19 | 低 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-20 | 低 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-21 | 低 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-22 | 低 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-23 | 低 | [be-services-2.md](./be-services-2.md) | 不成立 — [处置证据](./fix-services-2.md) |
| be-services-2-24 | 低 | [be-services-2.md](./be-services-2.md) | 不成立 — [处置证据](./fix-services-2.md) |
| be-services-2-25 | 低 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-2-26 | 低 | [be-services-2.md](./be-services-2.md) | 已修复 — [处置证据](./fix-services-2.md) |
| be-services-sub-01 | 高 | [be-services-sub.md](./be-services-sub.md) | 已修 — [处置证据](./fix-services-sub.md) |
| be-services-sub-02 | 高 | [be-services-sub.md](./be-services-sub.md) | 已修 — [处置证据](./fix-services-sub.md) |
| be-services-sub-03 | 高 | [be-services-sub.md](./be-services-sub.md) | 已修 — [处置证据](./fix-services-sub.md) |
| be-services-sub-04 | 高 | [be-services-sub.md](./be-services-sub.md) | 已修 — [处置证据](./fix-services-sub.md) |
| be-services-sub-05 | 中 | [be-services-sub.md](./be-services-sub.md) | 已修 — [处置证据](./fix-services-sub.md) |
| be-services-sub-06 | 中 | [be-services-sub.md](./be-services-sub.md) | 已修（协调者协作） — [处置证据](./fix-services-sub.md) |
| be-services-sub-07 | 中 | [be-services-sub.md](./be-services-sub.md) | 已修 — [处置证据](./fix-services-sub.md) |
| be-services-sub-08 | 中 | [be-services-sub.md](./be-services-sub.md) | 基线已修 — [处置证据](./fix-services-sub.md) |
| be-services-sub-09 | 中 | [be-services-sub.md](./be-services-sub.md) | 已修 — [处置证据](./fix-services-sub.md) |
| be-services-sub-10 | 中 | [be-services-sub.md](./be-services-sub.md) | 已修 — [处置证据](./fix-services-sub.md) |
| be-services-sub-11 | 中 | [be-services-sub.md](./be-services-sub.md) | 已修 — [处置证据](./fix-services-sub.md) |
| be-services-sub-12 | 中 | [be-services-sub.md](./be-services-sub.md) | 已修 — [处置证据](./fix-services-sub.md) |
| be-services-sub-13 | 低 | [be-services-sub.md](./be-services-sub.md) | 已修 — [处置证据](./fix-services-sub.md) |
| be-services-sub-14 | 低 | [be-services-sub.md](./be-services-sub.md) | 已修 — [处置证据](./fix-services-sub.md) |
| be-services-sub-15 | 低 | [be-services-sub.md](./be-services-sub.md) | 已修 — [处置证据](./fix-services-sub.md) |
| be-services-sub-16 | 低 | [be-services-sub.md](./be-services-sub.md) | 已修（遵循后端边界） — [处置证据](./fix-services-sub.md) |
| be-services-sub-17 | 低 | [be-services-sub.md](./be-services-sub.md) | 已修观测缺口；原功能归因部分不成立 — [处置证据](./fix-services-sub.md) |
| be-services-sub-18 | 低 | [be-services-sub.md](./be-services-sub.md) | 已修 — [处置证据](./fix-services-sub.md) |
| be-services-sub-19 | 低 | [be-services-sub.md](./be-services-sub.md) | 重复，随 02 修复 — [处置证据](./fix-services-sub.md) |
| be-services-sub-20 | 低 | [be-services-sub.md](./be-services-sub.md) | 已修 — [处置证据](./fix-services-sub.md) |
| devops-01 | 高 | [devops.md](./devops.md) | 已修触发缺口，纠正严重度依据 — [处置证据](./fix-routes-devops.md) |
| devops-02 | 高 | [devops.md](./devops.md) | 已修代码 — [处置证据](./fix-routes-devops.md) |
| devops-03 | 高 | [devops.md](./devops.md) | 不成立 — [处置证据](./fix-routes-devops.md) |
| devops-04 | 高 | [devops.md](./devops.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| devops-05 | 中 | [devops.md](./devops.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| devops-06 | 中 | [devops.md](./devops.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| devops-07 | 中 | [devops.md](./devops.md) | 不成立 — [处置证据](./fix-routes-devops.md) |
| devops-08 | 中 | [devops.md](./devops.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| devops-09 | 中 | [devops.md](./devops.md) | 已修实际链路，纠正泄漏断言 — [处置证据](./fix-routes-devops.md) |
| devops-10 | 中 | [devops.md](./devops.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| devops-11 | 中 | [devops.md](./devops.md) | 不成立 — [处置证据](./fix-routes-devops.md) |
| devops-12 | 低 | [devops.md](./devops.md) | 不成立 — [处置证据](./fix-routes-devops.md) |
| devops-13 | 低 | [devops.md](./devops.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| devops-14 | 低 | [devops.md](./devops.md) | 设计观察 — [处置证据](./fix-routes-devops.md) |
| devops-15 | 低 | [devops.md](./devops.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| devops-16 | 低 | [devops.md](./devops.md) | 不成立 — [处置证据](./fix-routes-devops.md) |
| devops-17 | 低 | [devops.md](./devops.md) | 已修 — [处置证据](./fix-routes-devops.md) |
| devops-18 | 低 | [devops.md](./devops.md) | 不成立 — [处置证据](./fix-routes-devops.md) |
| fe-admin-01 | 高 | [fe-admin.md](./fe-admin.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-admin-02 | 中 | [fe-admin.md](./fe-admin.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-admin-03 | 中 | [fe-admin.md](./fe-admin.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-admin-04 | 中 | [fe-admin.md](./fe-admin.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-admin-05 | 中 | [fe-admin.md](./fe-admin.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-admin-06 | 中 | [fe-admin.md](./fe-admin.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-admin-07 | 低 | [fe-admin.md](./fe-admin.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-admin-08 | 中 | [fe-admin.md](./fe-admin.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-api-01 | 中 | [fe-api.md](./fe-api.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| fe-api-02 | 中 | [fe-api.md](./fe-api.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| fe-api-03 | 中 | [fe-api.md](./fe-api.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| fe-api-04 | 中 | [fe-api.md](./fe-api.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| fe-api-05 | 中 | [fe-api.md](./fe-api.md) | 基线已修（cb9fb199） — [处置证据](./fix-root.md) |
| fe-api-06 | 中 | [fe-api.md](./fe-api.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| fe-api-07 | 中 | [fe-api.md](./fe-api.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| fe-api-08 | 高 | [fe-api.md](./fe-api.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| fe-api-09 | 中 | [fe-api.md](./fe-api.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| fe-api-10 | 低 | [fe-api.md](./fe-api.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| fe-api-11 | 中 | [fe-api.md](./fe-api.md) | 已修，待 CI — [处置证据](./fix-root.md) |
| fe-comp-1-01 | 高 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-02 | 中 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-03 | 高 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-04 | 高 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-05 | 中 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-06 | 中 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-07 | 中 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-08 | 中 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-09 | 中 | [fe-comp-1.md](./fe-comp-1.md) | 已修 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-10 | 中 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-11 | 中 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-12 | 中 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-13 | 中 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-14 | 中 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-15 | 中 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-16 | 中 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-17 | 低 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-1-18 | 低 | [fe-comp-1.md](./fe-comp-1.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-2-01 | 阻断 | [fe-comp-2.md](./fe-comp-2.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-2-02 | 中 | [fe-comp-2.md](./fe-comp-2.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-2-03 | 中 | [fe-comp-2.md](./fe-comp-2.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-2-04 | 低 | [fe-comp-2.md](./fe-comp-2.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-2-05 | 中 | [fe-comp-2.md](./fe-comp-2.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-2-06 | 中 | [fe-comp-2.md](./fe-comp-2.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-2-07 | 中 | [fe-comp-2.md](./fe-comp-2.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-2-08 | 中 | [fe-comp-2.md](./fe-comp-2.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-2-09 | 中 | [fe-comp-2.md](./fe-comp-2.md) | 修复 — [处置证据](./fix-frontend-12.md) |
| fe-comp-3-01 | 高 | [fe-comp-3.md](./fe-comp-3.md) | 已修复（前后端协同） — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-02 | 高 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-03 | 高 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-04 | 高 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-05 | 中 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-06 | 高 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-07 | 中 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-08 | 中 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-09 | 高 | [fe-comp-3.md](./fe-comp-3.md) | 已修复（前后端协同） — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-10 | 中 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-11 | 中 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-12 | 低 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-13 | 中 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-14 | 中 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-15 | 中 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-16 | 中 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-17 | 低 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-comp-3-18 | 中 | [fe-comp-3.md](./fe-comp-3.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-features-01 | 高 | [fe-features.md](./fe-features.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-features-02 | 中 | [fe-features.md](./fe-features.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-features-03 | 中 | [fe-features.md](./fe-features.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-features-04 | 中 | [fe-features.md](./fe-features.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-features-05 | 低 | [fe-features.md](./fe-features.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-features-06 | 中 | [fe-features.md](./fe-features.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-features-07 | 低 | [fe-features.md](./fe-features.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |
| fe-features-08 | 中 | [fe-features.md](./fe-features.md) | 已修复 — [处置证据](./fix-frontend-3-admin.md) |

原报告登记 206 项，全部已有逐项处置记录。以上“已修”指代码落盘，CI 状态见下；原严重度不等于复核后风险等级。

## 验证记录

- 审查基线 15f6c1a2 的 Node Verification（37245521860）构建、后端 Jest、前端 Vitest 均 success；Quality Guardrails、Docker、CodeQL success。
- Nightly 37529016437 为存量 failure：两个套件、10 个用例在 Mongo 握手报 Missing required sub-document driver；最终修复需重新验证，不沿用旧绿灯。
- 最终提交、CI 与所有编号的处置将在修复完成后回填。
