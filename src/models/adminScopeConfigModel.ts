import { mongoose } from "../services/mongoService";

/**
 * 普通管理员的页面授权配置（单例文档）。
 *
 * 为什么要单独一张表而不是塞进 runtimeConfigService：那份服务按「设置项」逐个 getter/setter
 * 组织（TTS 生成码、IPQS、Google 登录……），而这里是结构化的授权映射（默认页面集合 + 按用户覆盖），
 * 校验与缓存策略都不同，混进去只会让两边的键空间互相污染。
 *
 * 语义：
 *  - `defaultPages`：未单独配置的普通管理员能看到的页面（key 见 `config/adminPages.ts`）。
 *  - `perUser`：按 userId 覆盖 `defaultPages`（不含默认值，读取时做并集）。
 *  - 文档不存在时按 `DEFAULT_PLAIN_ADMIN_PAGES` 处理（保持历史行为）。
 */
const AdminScopeConfigSchema = new mongoose.Schema(
  {
    scopeKey: { type: String, required: true, unique: true },
    defaultPages: { type: [String], default: [] },
    perUser: { type: Map, of: [String], default: {} },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: String, default: "" },
  },
  { collection: "admin_scope_configs", minimize: false },
);

// 唯一性由上方字段声明的 unique: true 提供。不要再加显式 index({scopeKey:1},{unique:true})：
// mongoose 会报 'Duplicate schema index'，且重复定义的选项不会被应用。

export interface AdminScopeConfigDoc {
  scopeKey: string;
  defaultPages: string[];
  perUser?: Map<string, string[]> | Record<string, string[]>;
  updatedAt?: Date;
  updatedBy?: string;
}

export function getAdminScopeConfigModel() {
  return (
    mongoose.models.AdminScopeConfig ||
    mongoose.model("AdminScopeConfig", AdminScopeConfigSchema)
  );
}
