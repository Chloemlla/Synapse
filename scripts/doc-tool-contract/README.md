# doc-tool 排版契约评测（eval.js）

这是**拿证据**的工具，不是 CI 测试。它真跑 pandoc，把 `corpus/` 里每份 Markdown 过三遍，
打印「基线 → +声明层 → +管线」的分数对比，再对产物做五个负样本，确认验收器真的在数东西。

单元测试在 `src/tests/docToolContract.test.ts`（不依赖 pandoc，CI 里跑）。两者分工明确：
测试证明「逻辑对」，本脚本证明「在真实 pandoc 产物上，这些缺陷确实存在且能被修掉」。

## 跑法

```bash
pnpm install                                # 需要 devDependency 里的 typescript
node scripts/doc-tool-contract/eval.js

# 只跑部分语料（按文件名前缀）
node scripts/doc-tool-contract/eval.js --only 01,05

# 保留中间 docx（要拿 Word 打开人工核对时用）
node scripts/doc-tool-contract/eval.js --keep

# 指定 pandoc（默认读 DOC_TOOL_PANDOC，否则用 PATH 里的 pandoc）
node scripts/doc-tool-contract/eval.js --pandoc /usr/bin/pandoc
```

需要 `pandoc`（本仓库 Dockerfile 里那份静态二进制就是它）+ Node ≥ 20。
结果写到 `outputs/doc-tool-contract-eval.json`（逐语料分数、每项检查明细、负样本结论）。

退出码：0 = 全部语料都过线、全部幂等、负样本都按预期掉分；1 = 有反例（会逐条列出）。

## 三列分数是什么意思

| 列 | 做法 | 看什么 |
| --- | --- | --- |
| 基线 | 裸 `pandoc a.md -o a.docx` | 现装工具链的真实水平 |
| +声明层 | `pandoc --reference-doc=<编译了契约的 reference.docx>` | 光靠样式的上限（字体/字号/行距/框线） |
| +管线 | 上一步产物再跑 `applyContract`（验 → 修 → 再验） | 最终交付物的水平 |

「+声明层」那一列是**故意**存在的：它证明哪些失分光靠样式解决不了（页边距、行不跨页、标题层级），
必须走产物后处理 —— 这是本方案分两层架构的原因，而不是实现偏好的问题。

## 负样本

| 代号 | 怎么弄坏 | 期望 |
| --- | --- | --- |
| N1 | 删掉样式里的 `tblBorders` | C1 归零，总分只掉 C1 的权重 |
| N2 | 把 `w:eastAsia` 改回 `w:eastAsiaTheme` | C2 归零 |
| N3 | 把 `pgMar w:top` 改成 720 | C3 掉 1/8（7/8 项仍对） |
| N4 | 删掉产物里所有 `m:oMath` | C4 掉分（需要源 Markdown 对照） |
| N5 | 把 ZIP 截掉一半 | `fatal`，唯一一项 C8 = 0 |

某份语料没有对应结构时（例如没有表格），该负样本记 `-`＝**不适用**，不算通过。
把这五个写成脚本而不是人工检查，是为了防止「评分函数退化成恒返回满分」这种静默失效。

## 语料

`corpus/01..07` 是静态 Markdown；`08-with-image` 在临时目录里现造（图片必须真的存在，
C5 才有意义；仓库里不放二进制）。覆盖：讲义、试卷（公式多）、公文报告（多表格）、
中英混排、标题跳级（C7 修不了，只能人工）、代码块里的假公式（C4 误判防护）、极简边界。

## 实测数字（2026-11，pandoc 3.12.1）

8 份语料：基线均值 **49.58**，+声明层均值 **80.83**，+管线均值 **99.58**；
终评分区间 96.67 ~ 100（唯一未满分的是 05 的 C7 跳级，属设计内不可自动修复项）；
8/8 幂等（第二遍 0 轮修复、sha256 相同）。具体每份的数字见 json 报告。
