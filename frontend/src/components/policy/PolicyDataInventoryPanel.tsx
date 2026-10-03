import React from 'react';
import { FaInfoCircle, FaTable } from 'react-icons/fa';
import type { PolicyDataInventoryEntry } from '../../types/policy';
import { cn } from '../../utils/cn';
import { InfoPanel, InfoSectionTitle } from '../studioTheme';
import { HighlightedText } from './policyCards';

/**
 * 数据清单表：逐项说明「收集什么 / 为什么收集 / 保存多久 / 能否导出 / 删除账户时怎么办」。
 *
 * 这些条目**不是前端手写的**：它们来自后端 `GET /api/policy/document` 的 `dataInventory`，
 * 而后者由 `docs/governance/privacy-data-map.json`（隐私治理的机器可读契约）生成。
 * 于是「页面说的数据实践」与「后端实际实现」不可能各写一份：改契约→重新生成→页面随之变化，
 * CI 里的 `check:privacy-data-map` 负责拦住漏重新生成的情况。
 *
 * 除了这张表，正文里「数据清单：我们到底存了什么」章节也把同样的条目写成可检索、可打印的条文，
 * 因此即使不渲染表格，用户也能读到完整内容（表格是可读性增强，不是唯一入口）。
 */

const EXPORT_LABEL: Record<PolicyDataInventoryEntry['exportable'], string> = {
  full: '可导出',
  partial: '部分导出',
  none: '不可自助导出',
};

const EXPORT_TONE: Record<PolicyDataInventoryEntry['exportable'], string> = {
  full: 'bg-emerald-50 text-emerald-700 border-emerald-100',
  partial: 'bg-amber-50 text-amber-700 border-amber-100',
  none: 'bg-slate-50 text-slate-500 border-slate-200',
};

const DELETE_LABEL: Record<string, string> = {
  delete_document: '一并删除',
  retain_until_expiry: '按期限保留',
  retain_until_ttl: '到期自动清理',
  not_linked: '不随账户删除',
  not_applicable: '不适用',
  not_automated_today: '待补齐',
  gap: '仍有缺口',
  client_only: '仅存本地',
};

const PolicyDataInventoryPanel: React.FC<{
  entries: PolicyDataInventoryEntry[];
  /** 数据地图最后更新日，用于标注清单依据 */
  updatedAt: string;
  /** 当前检索词（命中时高亮） */
  searchQuery: string;
  /** 章节 id → 标题，用于「详见第 N 章」的定位链接 */
  sectionTitles: Record<string, string>;
  /** 点击「详见」时滚动到对应章节 */
  onJumpToSection: (sectionId: string) => void;
}> = ({ entries, updatedAt, searchQuery, sectionTitles, onJumpToSection }) => {
  const categories = React.useMemo(() => {
    const order: string[] = [];
    for (const entry of entries) {
      if (!order.includes(entry.category)) order.push(entry.category);
    }
    return order;
  }, [entries]);

  if (entries.length === 0) return null;

  return (
    <InfoPanel className="print:border-0 print:shadow-none">
      <InfoSectionTitle
        eyebrow="Data Inventory"
        title="数据清单（逐项）"
        description={`共 ${entries.length} 项，按类别分组。列出每一类信息的收集内容、用途、保存期限与删除方式；本表由后端隐私数据地图生成${updatedAt ? `（依据更新于 ${updatedAt}）` : ''}。`}
        icon={FaTable}
      />

      <div className="mb-4 flex items-start gap-2 rounded-2xl border border-slate-100 bg-slate-50/70 px-4 py-3 text-xs leading-6 text-slate-600">
        <FaInfoCircle className="mt-1 shrink-0 text-slate-400" aria-hidden />
        <span>
          「不可自助导出」不等于不能要：安全遥测类数据只用于人工排查，避免导出后外泄风险；
          如需其中与你相关的内容，请通过支持邮箱说明用途，我们会按「用户权利与行使方式」处理。
        </span>
      </div>

      <div className="space-y-5">
        {categories.map((category) => (
          <div key={category}>
            <h4 className="mb-2 text-xs font-semibold tracking-[0.12em] text-slate-400 uppercase">
              {category}
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th scope="col" className="py-2 pr-3 font-semibold">数据项</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">收集内容</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">用途</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">保存期限</th>
                    <th scope="col" className="py-2 pr-3 font-semibold">导出</th>
                    <th scope="col" className="py-2 font-semibold">删除账户</th>
                  </tr>
                </thead>
                <tbody>
                  {entries
                    .filter((entry) => entry.category === category)
                    .map((entry) => (
                      <tr key={entry.id} className="border-b border-slate-100 align-top">
                        <td className="py-2.5 pr-3">
                          <div className="font-semibold text-slate-800">
                            <HighlightedText text={entry.label} query={searchQuery} />
                          </div>
                          <button
                            type="button"
                            onClick={() => onJumpToSection(entry.policySection)}
                            className="mt-1 text-[11px] font-medium text-indigo-600 hover:underline print:hidden"
                          >
                            详见「{sectionTitles[entry.policySection] ?? entry.policySection}」
                          </button>
                        </td>
                        <td className="max-w-[20rem] py-2.5 pr-3 text-xs leading-6 text-slate-600">
                          <HighlightedText text={entry.what} query={searchQuery} />
                        </td>
                        <td className="max-w-[18rem] py-2.5 pr-3 text-xs leading-6 text-slate-600">
                          <HighlightedText text={entry.why} query={searchQuery} />
                        </td>
                        <td className="max-w-[16rem] py-2.5 pr-3 text-xs leading-6 text-slate-600">
                          <HighlightedText text={entry.retention} query={searchQuery} />
                        </td>
                        <td className="py-2.5 pr-3">
                          <span
                            className={cn(
                              'inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold',
                              EXPORT_TONE[entry.exportable],
                            )}
                          >
                            {EXPORT_LABEL[entry.exportable]}
                          </span>
                        </td>
                        <td className="py-2.5 text-xs text-slate-600">
                          {DELETE_LABEL[entry.deleteOnUserDelete] ?? '见章节说明'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </InfoPanel>
  );
};

export default PolicyDataInventoryPanel;
