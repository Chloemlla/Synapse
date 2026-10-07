# ConfigurationNoticeState 重复索引（2026-10-07）

- INDEX-01：`src/models/configurationNoticeStateModel.ts:4,15` 同时通过字段 `unique: true` 和 `schema.index({ key: 1 }, { unique: true })` 声明相同索引，Mongoose 启动时报告重复索引。
- 修复：移除字段级 `unique`，保留唯一一处显式 schema 索引及其 `unique: true`。`required: true` 保留，业务依赖的 key 唯一约束不变，无需删除或重建数据库现有索引。
- 验证：静态核对仅一处 key 索引；按仓库约定不在本地运行构建、测试或安装依赖，由推送后的 GitHub Actions 验证。
