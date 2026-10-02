import type { CrashGroup, FullCrashReport } from '@/api/crashReports';
import { buildCsv, downloadCsv } from '@/utils/csv';
import { formatTime, sourceLabel, topFrame } from './format';

// CSV 构造改用共用工具：崩溃堆栈 / 根因 / 进程名都是客户端上报的，裸拼字符串导出后
// 在 Excel 里会被当公式求值（CSV injection）。行分隔与 BOM 也一并交给共用实现。
const csvRows = (header: string[], rows: unknown[][]): string => buildCsv(header, rows);

export const buildGroupsCsv = (groups: CrashGroup[]): string =>
  csvRows(
    ['groupKey', 'risk', 'count', 'affectedUsers', 'versionCode', 'lastSeenAt', 'topFrame'],
    groups.map((group) => [
      group.groupKey,
      group.risk,
      group.count,
      group.affectedUsers,
      group.versionCode,
      formatTime(group.lastSeenAt),
      topFrame(group.cleanStack),
    ]),
  );

export const buildReportsCsv = (reports: FullCrashReport[]): string =>
  csvRows(
    [
      'reportId',
      'crashedAt',
      'exceptionType',
      'rootCause',
      'kind',
      'threadName',
      'processName',
      'packageName',
      'versionCode',
      'deviceInstallationId',
      'source',
      'userId',
      'durationMillis',
    ],
    reports.map((report) => [
      report.reportId,
      report.crashedAtText || formatTime(report.crashedAtMillis),
      report.exceptionType,
      report.rootCause,
      report.kind,
      report.threadName,
      report.processName,
      report.packageName,
      report.versionCode,
      report.deviceInstallationId,
      sourceLabel(report.userId),
      report.userId,
      report.durationMillis,
    ]),
  );

export const downloadTextFile = (
  filename: string,
  text: string,
  mime = 'text/plain;charset=utf-8',
): void => {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

/** Excel 只在有 BOM 时才按 UTF-8 识别 CSV（共用工具已含 BOM）。 */
export const downloadCsvFile = (filename: string, csv: string): void => downloadCsv(filename, csv);

export const downloadJsonFile = (filename: string, value: unknown): void =>
  downloadTextFile(filename, JSON.stringify(value, null, 2), 'application/json;charset=utf-8');

export const fileStamp = (): string =>
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
