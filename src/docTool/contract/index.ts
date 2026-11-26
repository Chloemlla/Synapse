// 契约流水线：verify → repair → verify …（最多 accept.maxRepairRounds 轮）。
//
// 为什么先验后修、而不是先修后验：
//   1) pandoc 的产物有一半项目本来就该是对的（C4 公式、C5 图片由 pandoc 自己保证），
//      先验能避免「为了修页边距，把已经正确的产物重写一遍」；
//   2) 报告要回答的问题是「这份产物 vs 契约差在哪」，先验拿到的才是原始差距。
//
// 为什么修复走 switch(缺陷) 而不是「无脑把所有 pass 跑一遍」：
//   无脑跑会把「契约里没开这项」变成「偷偷修了」—— 用户明明关掉了 tableBorders，
//   我们却给表格加了框线，那契约就不算契约了。repairPlan() 里那条
//   `contract.passes.includes(defect.fixable)` 就是这条边界的执行点。
//
// 幂等性：每个 pass 都「有就跳过」，所以「同一份输入 + 同一批 pass」两次执行结果必须逐字节相同。
// checkIdempotent() 把这条判据做成了可执行的函数（而不是一句声明），评测脚本会拿它跑全部语料。
import crypto from "node:crypto";
import { applyPasses } from "./passes";
import { readZip } from "./zipRead";
import { rewriteZip } from "./zipRewrite";
import { isBalanced } from "./xmlScan";
import { contractHash, type PassId, type StyleContract } from "./types";
import { repairPlan, verifyDocx, type Verdict } from "./verify";

export interface ContractRunInput {
  /** pandoc 刚产出的 docx 字节 */
  docx: Buffer;
  contract: StyleContract;
  /** 源 Markdown 原文：C4/C5 需要它来算「应该有几个公式/图片」 */
  sourceMarkdown?: string;
}

export interface ContractRunResult {
  /** 修复后的 docx 字节（可能等于输入，表示无需修复） */
  docx: Buffer;
  verdict: Verdict;
  /** 实际执行的修复轮数（0 = 产物本来就合格） */
  rounds: number;
  /** 实际执行过的 pass（幂等、去重、按固定顺序） */
  applied: PassId[];
  /** 非致命告警：例如「修复后 XML 不配平，已回退」——这类事必须留痕，不能静默吞掉 */
  warnings: string[];
}

const sha256 = (buf: Buffer): string => crypto.createHash("sha256").update(buf).digest("hex");

export function applyContract(input: ContractRunInput): ContractRunResult {
  const { contract, sourceMarkdown } = input;
  const warnings: string[] = [];
  const applied: PassId[] = [];
  let current = input.docx;
  let rounds = 0;
  let verdict = verifyDocx(current, { contract, sourceMarkdown });

  // 上限之外还要一个「没进展就退出」的保险：某个 pass 若对某份文档完全无效，
  // 只看 maxRepairRounds 会白转两轮，日志里还会出现「修了两轮还是同一批缺陷」的噪音。
  const maxRounds = Math.max(0, Math.floor(contract.accept.maxRepairRounds));
  while (rounds < maxRounds) {
    const plan = repairPlan(verdict, contract);
    if (!plan.length) break;
    let archive;
    try {
      archive = readZip(current);
    } catch {
      break;
    }
    const docXml = archive.text("word/document.xml");
    if (!docXml) break;
    const nextXml = applyPasses(docXml, contract, plan);
    if (nextXml === docXml) break; // 所有 pass 都判定「已经有了」，再跑也是原地踏步
    if (!isBalanced(nextXml)) {
      // 改写把 XML 写坏了：宁可交回上一版（能打开）也不交一版打不开的
      warnings.push(`修复轮 ${rounds + 1} 后 document.xml 不再配平，已回退到上一版`);
      break;
    }
    current = rewriteZip(archive, new Map([["word/document.xml", Buffer.from(nextXml, "utf8")]])).buffer;
    rounds += 1;
    for (const id of plan) if (!applied.includes(id)) applied.push(id);
    verdict = verifyDocx(current, { contract, sourceMarkdown });
  }

  return { docx: current, verdict, rounds, applied, warnings };
}

export interface IdempotencyResult {
  stable: boolean;
  /** 首轮产物与「把全部 pass 再跑一遍」的产物 sha256 */
  hashFirst: string;
  hashSecond: string;
  detail: string;
}

/**
 * 幂等性判据（可执行版）：把管线**对产物再跑一遍**，必须 0 轮修复、字节完全相同。
 *
 * 为什么不写成「把全部 pass 再跑一遍」：那是另一个问题（「pass 是否幂等」）。用户真正在意的是
 * 「同一个任务重试一次，会不会得到不一样的文件」—— 而重试的路径就是再走一遍 applyContract。
 * 只要第二遍 0 轮，就说明第一遍已经把该改的全改完了；字节相等说明改写在字节层面也是确定的。
 *
 * 这条判据实际否掉了两种「看起来能跑」的实现：
 *   —— 用正则做非贪婪整块替换（第二遍会重复插入）；
 *   —— 用当前时间做 ZIP 时间戳（第二遍字节必然不同，幂等性根本无法验证）。
 */
export function checkIdempotent(input: ContractRunInput): IdempotencyResult {
  const first = applyContract(input);
  const second = applyContract({ ...input, docx: first.docx });
  const hashFirst = sha256(first.docx);
  const hashSecond = sha256(second.docx);
  const stable = hashFirst === hashSecond && second.rounds === 0;
  return {
    stable,
    hashFirst,
    hashSecond,
    detail: stable
      ? `第二遍管线 0 轮修复，产物逐字节相同（首轮 ${first.rounds} 轮，改了 ${first.applied.join(",") || "无"}）`
      : `第二遍管线仍执行了 ${second.rounds} 轮（${second.applied.join(",") || "无"}），产物字节${hashFirst === hashSecond ? "相同" : "不同"}`,
  };
}

/** 契约指纹：产物文件名/缓存目录用它，避免同一份契约重复编译。 */
export { contractHash };

export * from "./types";
export { compileReferenceDoc, compileStyles, contractFromDocx } from "./compile";
export { applyPasses, PASS_IMPL } from "./passes";
export { readZip } from "./zipRead";
export { rewriteZip } from "./zipRewrite";
export { verifyDocx, repairPlan, countSourceMath, countSourceImages, CHECK_WEIGHTS, CHECK_NAMES } from "./verify";
export type { CheckId, CheckResult, Defect, Verdict } from "./verify";
