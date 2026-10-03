import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import {
  AlertCircle,
  CalendarDays,
  Copy,
  Download,
  Eye,
  FileCode2,
  FileJson,
  FileText,
  Globe2,
  Lock,
  RefreshCcw,
  Share2,
  Tags,
} from 'lucide-react';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { CodeHighlighter, resolveCodeLanguage } from '../utils/codeHighlight';
import { api } from '../api/api';
import MarkdownRenderer from './MarkdownRenderer';
import Mermaid from './Mermaid';
import { cn } from '../utils/cn';
import { studioFieldClassName, studioPrimaryButtonClassName, studioSurfaceClassName } from './studioTheme';

interface ArtifactData {
  shortId: string;
  title: string;
  contentType: string;
  language?: string;
  content: string;
  description?: string;
  tags: string[];
  viewCount: number;
  createdAt: string;
  expiresAt?: string;
}

type ArtifactPayload = Partial<ArtifactData> & {
  short_id?: string;
  content_type?: string;
  view_count?: number;
  created_at?: string;
  expires_at?: string;
};

type ArtifactApiResponse = {
  success?: boolean;
  data?: ArtifactPayload;
  error?: string;
  message?: string;
};

type ArtifactLoadError = {
  status?: number;
  error?: string;
  message?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function normalizeArtifactLoadError(error: unknown): ArtifactLoadError {
  if (!isRecord(error)) return {};

  const response = isRecord(error.response) ? error.response : null;
  const data = response && isRecord(response.data) ? response.data : null;

  // 只取后端给的文案：axios 的 `error.message` 是英文技术串（如
  // `Request failed with status code 404`），面向外部访客的落地页不能直接回显它。
  return {
    status: typeof response?.status === 'number' ? response.status : undefined,
    error: typeof data?.error === 'string' ? data.error : undefined,
    message: typeof data?.message === 'string' ? data.message : undefined,
  };
}

/** 后端没给可读文案时，按状态码给中文人话，兜底不再外泄技术报错。 */
function describeArtifactLoadError(loadError: ArtifactLoadError): string {
  if (loadError.message) return loadError.message;
  if (loadError.status === 404) return '该分享不存在或已过期。';
  if (loadError.status === 403) return '没有访问此分享的权限。';
  if (loadError.status && loadError.status >= 500) return '服务暂时不可用，请稍后重试。';
  return '加载分享内容失败，请稍后重试。';
}

const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  html: 'html',
  markdown: 'md',
  mermaid: 'mmd',
  json: 'json',
  svg: 'svg',
  latex: 'tex',
  csv: 'csv',
  xml: 'xml',
  text: 'txt',
};

const LANGUAGE_EXTENSION: Record<string, string> = {
  bash: 'sh',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  css: 'css',
  dart: 'dart',
  go: 'go',
  html: 'html',
  java: 'java',
  javascript: 'js',
  json: 'json',
  kotlin: 'kt',
  lua: 'lua',
  matlab: 'm',
  perl: 'pl',
  php: 'php',
  powershell: 'ps1',
  python: 'py',
  r: 'r',
  ruby: 'rb',
  scala: 'scala',
  shell: 'sh',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  typescript: 'ts',
  yaml: 'yaml',
};

const normalizeTags = (tags: unknown): string[] => {
  if (Array.isArray(tags)) {
    return tags.map((tag) => String(tag).trim()).filter(Boolean);
  }

  if (typeof tags === 'string') {
    return tags.split(',').map((tag) => tag.trim()).filter(Boolean);
  }

  return [];
};

const normalizeArtifact = (payload: ArtifactPayload): ArtifactData => {
  const contentType = String(payload.contentType ?? payload.content_type ?? 'text').toLowerCase();

  return {
    shortId: String(payload.shortId ?? payload.short_id ?? ''),
    title: String(payload.title ?? '未命名分享'),
    contentType,
    language: payload.language ? String(payload.language).toLowerCase() : undefined,
    content: String(payload.content ?? ''),
    description: payload.description ? String(payload.description) : undefined,
    tags: normalizeTags(payload.tags),
    viewCount: Number(payload.viewCount ?? payload.view_count ?? 0),
    createdAt: String(payload.createdAt ?? payload.created_at ?? new Date().toISOString()),
    expiresAt: payload.expiresAt || payload.expires_at ? String(payload.expiresAt ?? payload.expires_at) : undefined,
  };
};

const getContentTypeIcon = (contentType: string) => {
  switch (contentType) {
    case 'html':
      return Globe2;
    case 'code':
      return FileCode2;
    case 'json':
      return FileJson;
    default:
      return FileText;
  }
};

const getFileExtension = (artifact: ArtifactData): string => {
  if (artifact.contentType === 'code' && artifact.language) {
    return LANGUAGE_EXTENSION[artifact.language] || 'txt';
  }

  return CONTENT_TYPE_EXTENSION[artifact.contentType] || 'txt';
};

const buildDownloadName = (artifact: ArtifactData): string => {
  const safeTitle = artifact.title.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ') || 'artifact';
  return `${safeTitle}.${getFileExtension(artifact)}`;
};

const formatDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const csvRows = (content: string): string[][] => {
  return content
    .trim()
    .split(/\r?\n/)
    .map((row) => row.split(',').map((cell) => cell.trim()));
};

const ArtifactSharePage: React.FC = () => {
  const { shortId } = useParams<{ shortId: string }>();
  const navigate = useNavigate();
  const [artifact, setArtifact] = useState<ArtifactData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [showPasswordInput, setShowPasswordInput] = useState(false);
  const [copied, setCopied] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [shared, setShared] = useState(false);

  const contentIcon = useMemo(() => {
    return getContentTypeIcon(artifact?.contentType ?? 'text');
  }, [artifact?.contentType]);
  const ContentIcon = contentIcon;

  const fetchArtifact = async (pwd?: string) => {
    if (!shortId) {
      setError('分享链接不完整，缺少分享标识。');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const headers: Record<string, string> = {};
      if (pwd) {
        headers['X-Password'] = pwd;
      }

      const response = await api.get<ArtifactApiResponse>(
        `/api/nexai/artifacts/${encodeURIComponent(shortId)}`,
        { headers },
      );
      const payload = response.data.data;

      if (!payload) {
        throw new Error(response.data.message || '分享内容为空。');
      }

      setArtifact(normalizeArtifact(payload));
      setShowPasswordInput(false);
      await recordView();
    } catch (error: unknown) {
      const loadError = normalizeArtifactLoadError(error);

      if (loadError.status === 403 && loadError.error === 'password_required') {
        setShowPasswordInput(true);
        setError(null);
        return;
      }

      if (loadError.status === 403 && loadError.error === 'invalid_password') {
        setShowPasswordInput(true);
        setError('访问密码不正确，请重试。');
        return;
      }

      setError(describeArtifactLoadError(loadError));
    } finally {
      setLoading(false);
    }
  };

  const recordView = async () => {
    if (!shortId) return;

    try {
      await api.post(`/api/nexai/artifacts/${encodeURIComponent(shortId)}/view`, {
        referer: document.referrer,
        user_agent: navigator.userAgent,
      });
    } catch {
      // View tracking must not block rendering.
    }
  };

  useEffect(() => {
    void fetchArtifact();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shortId]);

  const handlePasswordSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (password.trim()) {
      void fetchArtifact(password.trim());
    }
  };

  const handleCopy = async () => {
    if (!artifact) return;

    await navigator.clipboard.writeText(artifact.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!artifact) return;

    const blob = new Blob([artifact.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = buildDownloadName(artifact);
    anchor.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
    window.setTimeout(() => setDownloaded(false), 2000);
  };

  const handleShare = async () => {
    const url = window.location.href;

    if (navigator.share) {
      try {
        await navigator.share({
          title: artifact?.title || 'NexAI Artifact',
          url,
        });
        return;
      } catch {
        // Fall through to clipboard when the native share sheet is cancelled or unavailable.
      }
    }

    await navigator.clipboard.writeText(url);
    setShared(true);
    window.setTimeout(() => setShared(false), 2000);
  };

  const renderContent = () => {
    if (!artifact) return null;

    switch (artifact.contentType) {
      case 'html':
        return (
          <div className="space-y-2">
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
              此内容由第三方提交，已在受限沙箱中展示：脚本无法访问本站 Cookie 或存储，且不允许弹窗与外部导航。
            </div>
            <iframe
              title={`${artifact.title} 预览`}
              srcDoc={artifact.content}
              ref={(el) => {
                // G12-06：React 类型未收录 iframe 的 csp 属性，这里在挂载时用原生 API 设置，
                // 作为 sandbox 之外的第二道防线，禁止 iframe 内脚本自由 fetch 外域。
                if (el && el.getAttribute('csp') === null) {
                  el.setAttribute('csp', "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:");
                }
              }}
              sandbox="allow-scripts allow-forms allow-downloads"
              referrerPolicy="no-referrer"
              className="h-[72vh] min-h-[300px] w-full border-0 bg-white sm:min-h-[560px]"
            />
          </div>
        );

      case 'svg':
        return (
          <div
            className="flex min-h-[300px] w-full items-center justify-center bg-white p-4 sm:min-h-[560px] [&>svg]:max-h-[520px] [&>svg]:max-w-full"
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(artifact.content, { USE_PROFILES: { svg: true, svgFilters: true } }),
            }}
          />
        );

      case 'markdown':
        return (
          <div className="bg-white p-6 text-slate-900 sm:p-8">
            <MarkdownRenderer
              content={artifact.content}
              controls={{
                showCopy: true,
                showSourceToggle: true,
                showExpandToggle: false,
              }}
            />
          </div>
        );

      case 'mermaid':
        return (
          <div className="bg-white p-6 sm:p-8">
            <Mermaid code={artifact.content} />
          </div>
        );

      case 'json':
        return renderHighlightedCode(artifact, 'json', safeFormatJson(artifact.content));

      case 'xml':
        return renderHighlightedCode(artifact, 'xml', artifact.content);

      case 'latex':
        return renderHighlightedCode(artifact, 'latex', artifact.content);

      case 'csv':
        return renderCsv(artifact.content);

      case 'code':
        return renderHighlightedCode(artifact, artifact.language || 'text', artifact.content);

      case 'text':
      default:
        return (
          <pre className="max-h-[72vh] overflow-auto whitespace-pre-wrap break-words bg-white p-6 font-mono text-sm leading-7 text-slate-800 sm:p-8">
            {artifact.content}
          </pre>
        );
    }
  };

  if (loading) {
    return (
      <ArtifactStateShell statusRole>
        <RefreshCcw className="h-8 w-8 animate-spin text-slate-500" aria-hidden="true" />
        <h1 className="mt-5 text-xl font-semibold text-slate-950">正在加载分享内容…</h1>
      </ArtifactStateShell>
    );
  }

  if (showPasswordInput) {
    return (
      <ArtifactStateShell>
        <Lock className="h-9 w-9 text-slate-700" aria-hidden="true" />
        <h1 className="mt-5 text-xl font-semibold text-slate-950">需要访问密码</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">该分享受密码保护，请输入密码后查看。</p>
        <form onSubmit={handlePasswordSubmit} className="mt-6 w-full max-w-sm space-y-3">
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="请输入访问密码"
            aria-label="访问密码"
            className={cn(studioFieldClassName, "border border-slate-300 bg-white focus:border-slate-500 focus:ring-slate-200")}
            autoFocus
          />
          {error && (
            <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}
          <button
            type="submit"
            className={cn(studioPrimaryButtonClassName, "w-full bg-slate-950 px-4 py-3")}
          >
            解锁查看
          </button>
        </form>
      </ArtifactStateShell>
    );
  }

  if (error || !artifact) {
    return (
      <ArtifactStateShell>
        <AlertCircle className="h-9 w-9 text-red-500" aria-hidden="true" />
        <h1 className="mt-5 text-xl font-semibold text-slate-950">分享暂不可用</h1>
        <p className="mt-2 max-w-md text-sm leading-6 text-slate-600" role="alert">
          {error || '该分享不存在或已过期。'}
        </p>
        <button
          type="button"
          onClick={() => navigate('/')}
          className={cn(studioPrimaryButtonClassName, "mt-6 bg-slate-950 px-4 py-2.5")}
        >
          返回 Synapse 首页
        </button>
      </ArtifactStateShell>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-950">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-5 rounded-2xl border border-slate-200 bg-white px-5 py-5 shadow-sm sm:px-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex items-start gap-3">
                <div className="mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-700">
                  <ContentIcon className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h1 className="break-words text-2xl font-semibold tracking-normal text-slate-950 sm:text-3xl">
                    {artifact.title}
                  </h1>
                  {artifact.description && (
                    <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                      {artifact.description}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-5 flex flex-wrap gap-2 text-xs font-medium text-slate-600">
                <MetadataPill>
                  <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                  {artifact.contentType}
                </MetadataPill>
                {artifact.language && (
                  <MetadataPill>
                    <FileCode2 className="h-3.5 w-3.5" aria-hidden="true" />
                    {artifact.language}
                  </MetadataPill>
                )}
                <MetadataPill>
                  <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                  {artifact.viewCount} 次浏览
                </MetadataPill>
                <MetadataPill>
                  <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                  {formatDate(artifact.createdAt)}
                </MetadataPill>
              </div>

              {artifact.tags.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {artifact.tags.map((tag) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600"
                    >
                      <Tags className="h-3 w-3" aria-hidden="true" />
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2 lg:w-40 lg:grid-cols-1">
              <ActionButton active={copied} label={copied ? '已复制' : '复制'} onClick={handleCopy}>
                <Copy className="h-4 w-4" aria-hidden="true" />
              </ActionButton>
              <ActionButton active={downloaded} label={downloaded ? '已保存' : '下载'} onClick={handleDownload}>
                <Download className="h-4 w-4" aria-hidden="true" />
              </ActionButton>
              <ActionButton active={shared} label={shared ? '链接已复制' : '分享'} onClick={handleShare}>
                <Share2 className="h-4 w-4" aria-hidden="true" />
              </ActionButton>
            </div>
          </div>
        </header>

        <main className={cn(studioSurfaceClassName, "flex-1 bg-white")}>
          {renderContent()}
        </main>

        <footer className="py-5 text-center text-xs text-slate-500">
          由 NexAI Artifacts 提供支持
        </footer>
      </div>
    </div>
  );
};

const ArtifactStateShell: React.FC<{ children: React.ReactNode; statusRole?: boolean }> = ({ children, statusRole }) => (
  <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10 text-center">
    <div
      className="flex w-full max-w-md flex-col items-center rounded-2xl border border-slate-200 bg-white px-6 py-8 shadow-sm"
      role={statusRole ? 'status' : undefined}
      aria-live={statusRole ? 'polite' : undefined}
      aria-busy={statusRole ? true : undefined}
    >
      {children}
    </div>
  </div>
);

const MetadataPill: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5">
    {children}
  </span>
);

const ActionButton: React.FC<{
  active: boolean;
  children: React.ReactNode;
  label: string;
  onClick: () => void | Promise<void>;
}> = ({ active, children, label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-2xl px-3 py-2 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
      active
        ? 'bg-emerald-600 text-white focus-visible:ring-emerald-400'
        : 'border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50 focus-visible:ring-slate-300'
    }`}
  >
    {children}
    <span className="truncate">{label}</span>
  </button>
);

const renderHighlightedCode = (artifact: ArtifactData, language: string, content: string) => {
  // 产物里的 language 来自用户数据，可能是不受支持的语法。
  // PrismLight 遇到未注册语言会直接抛 `Unknown language`，所以未命中白名单时退化成等宽纯文本。
  const highlightLanguage = resolveCodeLanguage(language);
  const containerStyle: React.CSSProperties = {
    margin: 0,
    minHeight: '560px',
    maxHeight: '72vh',
    overflow: 'auto',
    borderRadius: 0,
    padding: '1.5rem',
    fontSize: '14px',
    lineHeight: '1.6',
  };

  if (!highlightLanguage) {
    return (
      <pre style={containerStyle} className="bg-slate-900 text-slate-100">
        <code aria-label={`${artifact.title} 源码`}>{content}</code>
      </pre>
    );
  }

  return (
    <CodeHighlighter
      language={highlightLanguage}
      style={vscDarkPlus}
      showLineNumbers
      wrapLongLines
      customStyle={containerStyle}
      codeTagProps={{ 'aria-label': `${artifact.title} 源码` }}
    >
      {content}
    </CodeHighlighter>
  );
};

const renderCsv = (content: string) => {
  const rows = csvRows(content);
  const [header = [], ...body] = rows;

  return (
    <div className="max-h-[72vh] overflow-auto bg-white p-4">
      <table className="min-w-full border-collapse text-left text-sm">
        <thead className="sticky top-0 bg-slate-50">
          <tr>
            {header.map((cell, index) => (
              <th key={`${cell}-${index}`} className="border border-slate-200 px-3 py-2 font-semibold text-slate-700">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex % 2 === 0 ? 'bg-white' : 'bg-slate-50/70'}>
              {row.map((cell, cellIndex) => (
                <td key={`${rowIndex}-${cellIndex}`} className="border border-slate-200 px-3 py-2 text-slate-700">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const safeFormatJson = (content: string): string => {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
};

export default ArtifactSharePage;
