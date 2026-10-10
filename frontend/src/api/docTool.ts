// doc-tool（Markdown → Word 批量转换）前端 API 客户端。
//
// 请求一律走共享 axios 实例 `./api`：处罚态申诉入口、人机校验、401 兜底都挂在那条响应拦截器上，
// 用裸 fetch 会让这些全局兜底在本页静默失效。
//
// 类型与后端 `src/docTool/types.ts` 对齐。前端不能直接 import 服务端文件，只能保留一份手抄契约，
// 改动任意一侧都要同步另一侧（见 docs/plans/2026-10-10-doctool-md2docx-port.md §5）。

import { api } from './api';

const BASE = '/api/doc-tool';

/** 目标 .docx 已存在时的处理方式。默认 rename：不覆盖用户已有产物。 */
export type ConflictMode = 'skip' | 'rename' | 'overwrite';

/** alongside = 与上传的 .md 同目录；custom = 落到相对 outDir 下（保留子目录结构）。 */
export type OutMode = 'alongside' | 'custom';

export type DocJobStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
export type DocItemStatus = 'ok' | 'skipped' | 'failed';
export type DocFileFreshness = 'new' | 'stale' | 'fresh';

export interface DocPrefs {
  conflict: ConflictMode;
  outMode: OutMode;
  /** outMode=custom 时的输出相对目录（相对用户工作目录，空表示 out） */
  outDir: string;
  recursive: boolean;
  /** 参考样式文档（用户工作目录内的相对路径，空表示不用） */
  referenceDoc: string;
}

export interface DocLimits {
  maxUploadBytes: number;
  maxFileBytes: number;
  maxFilesPerJob: number;
  maxActiveJobs: number;
  retentionDays: number;
}

export interface DocFileEntry {
  rel: string;
  sizeBytes: number;
  /** epoch ms，界面自己格式化 */
  mtime: number;
  /** 本次会写出的 .docx 相对路径（rename 模式下已是「会另存为」的名字） */
  destRel: string;
  status: DocFileFreshness;
  /** true = 目标已存在、本次会另存为新名（界面显示「会另存为 xxx (2).docx」） */
  willRename: boolean;
}

/** GET /files 附带的分组计数。界面自己也从 files 算一份，缺字段时不至于显示空白。 */
export interface DocFileCounts {
  total: number;
  new: number;
  stale: number;
  fresh: number;
}

export interface CreateJobInput {
  files?: string[];
  recursive?: boolean;
  outMode?: OutMode;
  outDir?: string;
  conflict?: ConflictMode;
  referenceDoc?: string;
}

export interface DocJobItem {
  rel: string;
  destRel: string;
  status: DocItemStatus;
  sizeBytes?: number;
  ms?: number;
  /** 实际写了新名字（旧文件保留） */
  renamed?: boolean;
  error?: string;
}

export interface DocJobLog {
  /** epoch 秒 */
  t: number;
  text: string;
}

export interface DocJobRecord {
  id: string;
  userId: string;
  createdBy: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  status: DocJobStatus;
  /** 当前阶段的中文短句（进度条下方一行） */
  stage: string;
  /** 0-100 */
  progress: number;
  total: number;
  done: number;
  ok: number;
  skipped: number;
  failed: number;
  input: {
    files: string[];
    outMode: OutMode;
    outDir: string;
    conflict: ConflictMode;
    referenceDoc: string;
  };
  items: DocJobItem[];
  logs: DocJobLog[];
  error?: string;
  cancelRequested: boolean;
}

export interface PandocStatus {
  available: boolean;
  /** 形如 "pandoc 3.12.1"，探测失败时为空 */
  version: string;
  bin: string;
  /** 探测失败原因，只在「详情」折叠区展示 */
  error?: string;
}

export interface ReferenceTemplate {
  name: string;
  rel: string;
  sizeBytes: number;
  mtime: number;
}

export interface DocSettingsView {
  pandoc: PandocStatus;
  limits: DocLimits;
  prefs: DocPrefs;
  /** 用户工作目录内的模板清单（生成过的 reference.docx） */
  templates: ReferenceTemplate[];
}

export interface DocUploadRejected {
  name: string;
  reason: string;
}

export interface DocUploadResult {
  files: DocFileEntry[];
  rejected: DocUploadRejected[];
}

export interface DocListFilesResult {
  files: DocFileEntry[];
  counts?: DocFileCounts;
}

/** 待上传的一项：file 是浏览器给的文件对象，relPath 用来还原子目录结构。 */
export interface DocUploadPick {
  file: File;
  relPath: string;
}

/** 默认偏好：与本机版 md2docx 一致 —— 已存在就自动重命名不覆盖，来源递归收集默认开。 */
export const DEFAULT_DOC_PREFS: DocPrefs = {
  conflict: 'rename',
  outMode: 'custom',
  outDir: 'out',
  recursive: true,
  referenceDoc: '',
};

export const CONFLICT_MODES: ConflictMode[] = ['skip', 'rename', 'overwrite'];
export const OUT_MODES: OutMode[] = ['alongside', 'custom'];

const toQuery = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

const fileNameOf = (rel: string): string => rel.replace(/\\/g, '/').split('/').pop() || 'download';

const saveBlob = (blob: Blob, fileName: string): void => {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // 立刻 revoke 会让部分浏览器拿不到内容，留一个延时释放。
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
};

const safeId = (id: string): string => id.replace(/[^a-zA-Z0-9_-]/g, '');

const fetchReportText = async (id: string): Promise<string> => {
  const res = await api.get<string>(`${BASE}/jobs/${encodeURIComponent(id)}/report`, {
    responseType: 'text',
  });
  return typeof res.data === 'string' ? res.data : String(res.data ?? '');
};

export const docToolApi = {
  /** 限额 + 引擎可用性 + 该用户上次用的偏好 + 已生成的模板。 */
  getSettings: async (): Promise<DocSettingsView> => {
    const res = await api.get(`${BASE}/settings`);
    const data = (res.data ?? {}) as Partial<DocSettingsView>;
    // templates 当可选处理：后端只回 pandoc/limits/prefs 时，面板也不该因为字段缺失崩掉。
    return { ...(data as DocSettingsView), templates: data.templates ?? [] };
  },

  /** 偏好落服务端，下次打开面板自动带出。 */
  updateSettings: async (prefs: DocPrefs): Promise<DocPrefs> => {
    const res = await api.put(`${BASE}/settings`, { prefs });
    return res.data?.prefs ?? prefs;
  },

  /** 列已上传的 .md；conflict/输出位置都会改变 destRel 与 willRename，所以换了就必须重新列。 */
  listFiles: async (params: {
    recursive: boolean;
    conflict: ConflictMode;
    outMode?: OutMode;
    outDir?: string;
  }): Promise<DocListFilesResult> => {
    const query = toQuery({
      recursive: params.recursive ? 'true' : 'false',
      conflict: params.conflict,
      outMode: params.outMode,
      outDir: params.outDir,
    });
    const res = await api.get(`${BASE}/files${query}`);
    return { files: res.data?.files ?? [], counts: res.data?.counts };
  },

  /** 多文件上传：relPaths 与 files 严格同序，后端按索引贴回相对路径。 */
  uploadFiles: async (picks: DocUploadPick[]): Promise<DocUploadResult> => {
    const form = new FormData();
    for (const pick of picks) form.append('files', pick.file);
    for (const pick of picks) form.append('relPaths', pick.relPath);
    const res = await api.post(`${BASE}/upload`, form, {
      // api 实例默认 Content-Type=application/json：不显式声明 multipart，axios 会把 FormData
      // 直接 JSON 化（文件体变成空对象），multer 收不到任何文件。boundary 交给浏览器自己填。
      headers: { 'Content-Type': 'multipart/form-data' },
      // 上传耗时随文件数线性增长，15s 默认超时不合适。
      timeout: 0,
    });
    return { files: res.data?.files ?? [], rejected: res.data?.rejected ?? [] };
  },

  createJob: async (input: CreateJobInput): Promise<string> => {
    const res = await api.post(`${BASE}/jobs`, input);
    const jobId = res.data?.jobId;
    if (typeof jobId !== 'string' || !jobId) {
      throw new Error('服务端未返回任务编号');
    }
    return jobId;
  },

  /**
   * 任务详情。兼容两种响应包装：`{ job }` 与直接回记录本身
   * （同批开发的后端还没定死外层包装，这里两种都认，避免前端白屏）。
   */
  getJob: async (id: string): Promise<DocJobRecord | null> => {
    const res = await api.get(`${BASE}/jobs/${encodeURIComponent(id)}`);
    const data = res.data ?? {};
    if (data.job) return data.job as DocJobRecord;
    if (data.id) return data as DocJobRecord;
    return null;
  },

  cancelJob: async (id: string): Promise<void> => {
    await api.post(`${BASE}/jobs/${encodeURIComponent(id)}/cancel`, {});
  },

  /** 报告是 text/plain：复制到剪贴板直接用这份文本。 */
  fetchReport: fetchReportText,

  downloadReport: async (id: string): Promise<void> => {
    const text = await fetchReportText(id);
    saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `doc-tool-${safeId(id) || 'job'}.txt`);
  },

  /** 成功产物打成一个 zip（后端内置 zip，无第三方依赖）。 */
  downloadBundle: async (id: string): Promise<void> => {
    const res = await api.get(`${BASE}/jobs/${encodeURIComponent(id)}/bundle`, { responseType: 'blob' });
    saveBlob(res.data as Blob, `doc-tool-${safeId(id) || 'job'}.zip`);
  },

  /** 单个产物下载；文件名用相对路径的 basename。 */
  downloadFile: async (rel: string): Promise<void> => {
    const res = await api.get(`${BASE}/files/download${toQuery({ path: rel })}`, { responseType: 'blob' });
    saveBlob(res.data as Blob, fileNameOf(rel));
  },

  /** 用 pandoc 内置的 reference.docx 生成一份默认样式模板，之后可在 Word 里改字体/标题样式。 */
  createTemplate: async (name?: string): Promise<void> => {
    await api.post(`${BASE}/templates`, name && name.trim() ? { name: name.trim() } : {});
  },
};

export default docToolApi;
