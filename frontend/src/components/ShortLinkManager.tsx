import React, { useEffect, useState, startTransition } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { FaTrash, FaCopy, FaSearch, FaSync, FaDice, FaLink, FaPlus, FaInfoCircle, FaExclamationTriangle, FaCheckCircle, FaArrowLeft, FaToggleOn, FaToggleOff, FaDownload, FaFileAlt, FaUpload, FaUserSecret } from 'react-icons/fa';
import { Link } from 'react-router-dom';
import { useNotification } from './Notification';
import { useConfirm } from './confirm/ConfirmDialogProvider';
import getApiBaseUrl from '../api';
import { useAuth } from '../hooks/useAuth';
import { isSuperAdmin } from '../utils/rbac';
import { signedFetch } from '../utils/requestSigner';
import { getBackendErrorMessage } from '../utils/backendError';
import { cn } from '../utils/cn';
import {
  studioDangerButtonClassName,
  studioFieldClassName,
  studioMainSurfaceClassName,
  studioPillClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
  studioSurfaceClassName,
} from './studioTheme';
import { StudioEmptyState, StudioErrorState, StudioLoadingState, StudioPager } from './studioFeedback';

interface ShortLink {
  _id: string;
  code: string;
  target: string;
  createdAt: string;
  userId?: string;
  username?: string;
}

const PAGE_SIZE = 10;

const ShortLinkManager: React.FC = () => {
  const { user } = useAuth();
  const [links, setLinks] = useState<ShortLink[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [refreshing, setRefreshing] = useState(false);
  const [createTarget, setCreateTarget] = useState('');
  const [customCode, setCustomCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [codeValidation, setCodeValidation] = useState<{ isValid: boolean; message: string } | null>(null);
  const { setNotification } = useNotification();
  const confirm = useConfirm();

  // 优化动画：根据系统"减少动态"偏好降级，并用辅助函数避免重复创建对象
  const prefersReducedMotion = useReducedMotion();
  const hoverScale = React.useCallback((scale: number, enabled: boolean = true) => (
    enabled && !prefersReducedMotion ? { scale } : undefined
  ), [prefersReducedMotion]);
  const tapScale = React.useCallback((scale: number, enabled: boolean = true) => (
    enabled && !prefersReducedMotion ? { scale } : undefined
  ), [prefersReducedMotion]);

  // 虚拟滚动相关状态
  const [containerHeight, setContainerHeight] = useState(600);
  const [scrollTop, setScrollTop] = useState(0);
  const itemHeight = 120;
  const overscan = 5;

  // 批量选择相关状态
  const [selectedLinks, setSelectedLinks] = useState<Set<string>>(new Set());
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);

  // 导出相关状态
  const [exportingAll, setExportingAll] = useState(false);

  // 导入相关状态
  const [importingData, setImportingData] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importContent, setImportContent] = useState('');

  // 删除全部相关状态
  const [deletingAll, setDeletingAll] = useState(false);

  const fetchLinks = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/admin/shortlinks?search=${encodeURIComponent(search)}&page=${page}&pageSize=${PAGE_SIZE}`, { credentials: 'include' });
      const data = await res.json();

      if (!res.ok || !Array.isArray(data.items) || typeof data.total !== 'number') throw new Error('列表响应无效');
      const nextTotal = data.total;
      setLinks(data.items || []);
      setTotal(nextTotal);
      setTotalPages(Math.max(1, Math.ceil(nextTotal / PAGE_SIZE)));
    } catch {
      setLinks([]);
      setTotal(0);
      setTotalPages(1);
      setLoadError('获取短链列表失败，请刷新重试。');
      setNotification({ message: '获取短链列表失败，请重试', type: 'error' });
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchLinks();
    // eslint-disable-next-line
  }, [search, page]);

  const handleDelete = async (id: string) => {
    const ok = await confirm({
      title: '删除该短链？',
      description: '删除后原有链接会立即失效（404），已发出的短链无法再访问。',
      tone: 'danger',
      confirmLabel: '删除',
    });
    if (!ok) return;
    setHighlightedId(id);
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/admin/shortlinks/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        let message = '删除失败';
        try {
          const body = await res.json();
          message = body?.error || body?.message || message;
        } catch {
          // ignore parse errors
        }
        setNotification({ message, type: 'error' });
        return;
      }
      setNotification({ message: '删除成功', type: 'success' });
      await fetchLinks();
    } catch {
      setNotification({ message: '删除失败，请重试', type: 'error' });
    } finally {
      setTimeout(() => setHighlightedId(null), 800);
    }
  };

  const handleCopy = (code: string) => {
    const url = `${getApiBaseUrl()}/s/${code}`;
    navigator.clipboard.writeText(url);
    setNotification({ message: '短链已复制到剪贴板', type: 'info' });
    // 复制反馈走状态：原来的 classList.add/remove 会被 Tailwind 的类名变化漏掉。
    setCopiedCode(code);
    window.setTimeout(() => setCopiedCode((current) => (current === code ? null : current)), 600);
  };

  const handleRefresh = () => {
    setRefreshing(true);
    fetchLinks().then(() => {
      setRefreshing(false);
      setNotification({ message: '短链列表已刷新', type: 'success' });
    }).catch(() => {
      setRefreshing(false);
    });
  };

  const generateRandomCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    startTransition(() => setCustomCode(''));
    if (typeof window !== 'undefined' && 'requestAnimationFrame' in window) {
      requestAnimationFrame(() => {
        startTransition(() => setCustomCode(result));
      });
    } else {
      startTransition(() => setCustomCode(result));
    }
  };

  const clearCustomCode = () => {
    setCustomCode('');
    setCodeValidation(null);
  };

  const validateCustomCode = (code: string) => {
    if (!code.trim()) {
      setCodeValidation(null);
      return;
    }
    const trimmedCode = code.trim();
    if (trimmedCode.length < 1 || trimmedCode.length > 200) {
      setCodeValidation({ isValid: false, message: '长度必须在1-200个字符之间' });
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedCode)) {
      setCodeValidation({ isValid: false, message: '只能包含字母、数字、连字符和下划线' });
      return;
    }
    setCodeValidation({ isValid: true, message: '格式正确' });
  };

  const handleCreate = async () => {
    if (!createTarget.trim()) {
      setNotification({ message: '请输入目标地址', type: 'warning' });
      return;
    }
    if (customCode.trim()) {
      const trimmedCode = customCode.trim();
      if (trimmedCode.length < 1 || trimmedCode.length > 200) {
        setNotification({ message: '自定义短链接码长度必须在1-200个字符之间', type: 'warning' });
        return;
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(trimmedCode)) {
        setNotification({ message: '自定义短链接码只能包含字母、数字、连字符和下划线', type: 'warning' });
        return;
      }
    }
    setCreating(true);
    try {
      const requestBody: any = { target: createTarget.trim() };
      if (customCode.trim()) {
        requestBody.customCode = customCode.trim();
      }
      const res = await signedFetch(`${getApiBaseUrl()}/api/admin/shortlinks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });
      const data = await res.json();
      if (data.success) {
        setNotification({ message: '短链创建成功', type: 'success' });
        setCreateTarget('');
        setCustomCode('');
        setHighlightedId(data.doc?._id);
        setTimeout(() => setHighlightedId(null), 800);
        fetchLinks();
      } else {
        setNotification({ message: data.error || '创建失败', type: 'error' });
      }
    } catch {
      setNotification({ message: '创建失败', type: 'error' });
    }
    setCreating(false);
  };

  // 虚拟滚动计算
  const totalItems = links.length;
  const visibleCount = Math.ceil(containerHeight / itemHeight);
  const startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const endIndex = Math.min(totalItems, startIndex + visibleCount + overscan * 2);
  const visibleItems = links.slice(startIndex, endIndex);
  const offsetY = startIndex * itemHeight;
  const useVirtualScrolling = totalItems > 20;

  const containerRef = React.useRef<HTMLDivElement>(null);
  const mobileContainerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const updateContainerHeight = () => {
      const ref = window.innerWidth >= 768 ? containerRef.current : mobileContainerRef.current;
      if (ref) {
        const rect = ref.getBoundingClientRect();
        setContainerHeight(Math.max(400, window.innerHeight - rect.top - 100));
      }
    };
    updateContainerHeight();
    window.addEventListener('resize', updateContainerHeight);
    return () => window.removeEventListener('resize', updateContainerHeight);
  }, []);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  };

  const toggleSelectMode = () => {
    setIsSelectMode(!isSelectMode);
    if (isSelectMode) {
      setSelectedLinks(new Set());
    }
  };

  const toggleSelectLink = (linkId: string) => {
    const newSelected = new Set(selectedLinks);
    if (newSelected.has(linkId)) {
      newSelected.delete(linkId);
    } else {
      newSelected.add(linkId);
    }
    setSelectedLinks(newSelected);
  };

  const selectAllLinks = () => {
    setSelectedLinks(new Set(links.map(link => link._id)));
  };

  const clearSelection = () => {
    setSelectedLinks(new Set());
  };

  const handleBatchDelete = async () => {
    if (selectedLinks.size === 0) {
      setNotification({ message: '请选择要删除的短链', type: 'warning' });
      return;
    }
    const selectedArray = Array.from(selectedLinks);
    const selectedLinkObjects = links.filter(link => selectedArray.includes(link._id));
    const linkCodes = selectedLinkObjects.map(link => link.code).join(', ');
    const ok = await confirm({
      title: `删除选中的 ${selectedLinks.size} 个短链？`,
      description: `${linkCodes}\n\n删除后这些链接会立即失效，且不可撤销。`,
      tone: 'danger',
      confirmLabel: '批量删除',
    });
    if (ok) {
      setBatchDeleting(true);
      try {
        const response = await fetch(`${getApiBaseUrl()}/api/admin/shortlinks/batch-delete`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          credentials: 'include',
          body: JSON.stringify({ ids: selectedArray })
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || '批量删除失败');
        }
        setNotification({
          message: `批量删除成功！删除了 ${data.data?.deletedCount || selectedLinks.size} 个短链`,
          type: 'success'
        });
        setSelectedLinks(new Set());
        setIsSelectMode(false);
        fetchLinks();
      } catch (error) {
        console.error('批量删除短链失败:', error);
        setNotification({
          message: `批量删除失败：${getBackendErrorMessage(error, '请重试')}`,
          type: 'error'
        });
      } finally {
        setBatchDeleting(false);
      }
    }
  };

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages && newPage !== page) {
      setPage(newPage);
    }
  };

  // 导出所有短链数据（后端导出）
  const handleExportAll = async () => {
    setExportingAll(true);
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/shorturl/admin/export`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include'
      });
      if (!response.ok) {
        if (response.status === 404) {
          setNotification({ message: '没有短链数据可以导出', type: 'warning' });
          return;
        } else if (response.status === 403) {
          setNotification({ message: '权限不足，只有管理员可以导出短链数据', type: 'error' });
          return;
        }
        throw new Error(`导出失败: ${response.status}`);
      }
      const textContent = await response.text();
      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = `短链数据_${new Date().toISOString().split('T')[0]}.txt`;
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
        if (filenameMatch) {
          filename = decodeURIComponent(filenameMatch[1].replace(/['"]/g, ''));
        }
      }
      const isEncrypted = textContent.startsWith('# ShortUrl Export (Encrypted)') || /Algorithm:\s*AES-256-CBC/.test(textContent) || filename.endsWith('.enc.txt');
      if (!contentDisposition && isEncrypted) {
        filename = `短链数据_${new Date().toISOString().split('T')[0]}.enc.txt`;
      }
      const blob = new Blob([textContent], { type: 'text/plain; charset=utf-8' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      if (isEncrypted) {
        setNotification({ message: '已导出加密短链数据文件，请使用 AES_KEY 离线解密', type: 'success' });
      } else {
        const countMatch = textContent.match(/总数量:\s*(\d+)\s*个短链/);
        const exportCount = countMatch ? parseInt(countMatch[1]) : '未知数量';
        setNotification({ message: `成功导出 ${exportCount} 个短链数据`, type: 'success' });
      }
    } catch (error) {
      console.error('导出短链数据失败:', error);
      setNotification({ message: '导出短链数据失败，请重试', type: 'error' });
    } finally {
      setExportingAll(false);
      fetchLinks();
    }
  };

  const handleDeleteAll = async () => {
    if (links.length === 0) {
      setNotification({ message: '没有短链数据可以删除', type: 'warning' });
      return;
    }
    const ok = await confirm({
      title: '删除全站全部短链？',
      description: '将删除全站数据库中的所有短链，包括其他页面、其他用户及当前筛选未显示的短链。所有已发出的短链会立即失效，且不可撤销。',
      tone: 'danger',
      confirmLabel: '删除全站全部短链',
    });
    if (!ok) return;
    setDeletingAll(true);
    try {
      const response = await signedFetch(`${getApiBaseUrl()}/api/shorturl/admin/deleteall`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      if (!response.ok) {
        if (response.status === 403) {
          setNotification({ message: '权限不足，只有管理员可以删除所有短链数据', type: 'error' });
          return;
        }
        throw new Error(`删除失败: ${response.status}`);
      }
      const data = await response.json();
      setNotification({ message: `成功删除 ${data.data?.deletedCount ?? data.deletedCount ?? 0} 个短链数据`, type: 'success' });
      fetchLinks();
    } catch (error) {
      console.error('删除所有短链数据失败:', error);
      setNotification({ message: '删除所有短链数据失败，请重试', type: 'error' });
    } finally {
      setDeletingAll(false);
    }
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.txt')) {
      setNotification({ message: '请选择 .txt 格式的文件', type: 'warning' });
      event.target.value = '';
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setNotification({ message: '文件大小不能超过10MB', type: 'warning' });
      event.target.value = '';
      return;
    }
    setImportingData(true);
    try {
      const fileContent = await file.text();
      const response = await signedFetch(`${getApiBaseUrl()}/api/shorturl/admin/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content: fileContent })
      });
      if (!response.ok) {
        if (response.status === 403) {
          setNotification({ message: '权限不足，只有管理员可以导入短链数据', type: 'error' });
          return;
        }
        throw new Error(`导入失败: ${response.status}`);
      }
      const data = await response.json();
      let message = `导入完成！成功导入 ${data.importedCount} 个短链`;
      if (data.errorCount > 0) {
        message += `，跳过 ${data.errorCount} 个错误项`;
      }
      setNotification({ message, type: 'success' });
      fetchLinks();
    } catch (error) {
      console.error('导入短链数据失败:', error);
      setNotification({ message: '导入短链数据失败，请重试', type: 'error' });
    } finally {
      setImportingData(false);
      event.target.value = '';
    }
  };

  const handleImportData = async (content: string) => {
    if (!content.trim()) {
      setNotification({ message: '请输入要导入的数据', type: 'warning' });
      return;
    }
    setImportingData(true);
    try {
      const response = await signedFetch(`${getApiBaseUrl()}/api/shorturl/admin/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ content: content.trim() })
      });
      if (!response.ok) {
        if (response.status === 403) {
          setNotification({ message: '权限不足，只有管理员可以导入短链数据', type: 'error' });
          return;
        }
        throw new Error(`导入失败: ${response.status}`);
      }
      const data = await response.json();
      let message = `导入完成！成功导入 ${data.importedCount} 个短链`;
      if (data.errorCount > 0) {
        message += `，跳过 ${data.errorCount} 个错误项`;
      }
      setNotification({ message, type: 'success' });
      setImportContent('');
      setShowImportDialog(false);
      fetchLinks();
    } catch (error) {
      console.error('导入短链数据失败:', error);
      setNotification({ message: '导入短链数据失败，请重试', type: 'error' });
    } finally {
      setImportingData(false);
    }
  };

  if (!user || !isSuperAdmin(user.role)) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
        <span style={{ fontSize: 120, lineHeight: 1 }}><FaUserSecret aria-hidden /></span>
        <div className="text-3xl font-bold mt-6 mb-2 text-rose-600 drop-shadow-lg">你不是管理员，禁止访问！</div>
        <div className="text-lg text-slate-500 mb-8">请用管理员账号登录后再来玩哦~<br /><span className="text-rose-400">（小丑竟是你自己）</span></div>
        <div className="text-base text-slate-400 italic mt-4">仅限管理员使用，恶搞界面仅供娱乐。</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {loadError && (
        <StudioErrorState message={loadError} onRetry={() => void fetchLinks()} />
      )}
      {/* 标题和说明 — 头部横幅：纯色 bg-slate-900 */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className={studioSurfaceClassName}
      >
        <div className="bg-slate-900 px-6 py-5">
          <div className="flex items-center justify-between mb-2">
            <motion.h2
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="text-2xl font-bold text-white flex items-center gap-2"
            >
              <FaLink className="w-6 h-6 text-sky-300" />
              短链管理
            </motion.h2>
            <Link
              to="/"
              className={cn(studioSecondaryButtonClassName, 'w-full sm:w-auto')}
            >
              <FaArrowLeft className="w-3 h-3 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">返回主页</span>
              <span className="sm:hidden">返回</span>
            </Link>
          </div>
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.4 }}
            className="text-slate-300"
          >
            此功能用于管理短链接，支持创建、搜索、复制和删除短链，提供完整的短链生命周期管理。
          </motion.p>
        </div>
        <div className="bg-slate-50 px-6 py-4">
          <div className="flex items-start gap-2 text-sm">
            <FaInfoCircle className="w-4 h-4 text-sky-700 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-semibold text-slate-900">功能说明：</p>
              <ul className="list-disc list-inside space-y-1 mt-1 text-slate-600">
                <li>支持创建自定义或随机短链</li>
                <li>实时搜索和筛选短链</li>
                <li>一键复制短链到剪贴板</li>
                <li>安全的删除确认机制</li>
                <li>批量选择和删除多个短链</li>
                <li>一键导出所有短链数据到txt文件</li>
              </ul>
            </div>
          </div>
        </div>
      </motion.div>

      {/* 搜索和刷新 */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className={studioMainSurfaceClassName}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <FaSearch className="w-5 h-5 text-sky-700" />
            搜索和刷新
          </h3>
          <motion.button type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className={studioPrimaryButtonClassName}
            whileTap={tapScale(0.95)}>
            <FaSync className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            刷新
          </motion.button>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <input
            className={cn(studioFieldClassName, 'flex-1')}
            placeholder="搜索短链码或目标地址"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
      </motion.div>

      {/* 创建短链 */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className={studioMainSurfaceClassName}
      >
        <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
          <FaPlus className="w-5 h-5 text-sky-600" />
          创建短链
        </h3>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 sm:gap-0 mb-4">
          <div className="hidden sm:block"></div>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
            {/* 导出按钮 */}
            <motion.button type="button"
              onClick={handleExportAll}
              disabled={exportingAll || links.length === 0}
              className={cn(studioPrimaryButtonClassName, 'w-full sm:w-auto')}
              whileHover={hoverScale(1.02, !exportingAll && links.length > 0)}
              whileTap={tapScale(0.98, !exportingAll && links.length > 0)}>
              {exportingAll ? (
                <>
                  <FaSync className="animate-spin w-3 h-3 sm:w-4 sm:h-4" />
                  <span className="hidden sm:inline">导出中...</span>
                  <span className="sm:hidden">导出中</span>
                </>
              ) : (
                <>
                  <FaDownload className="w-3 h-3 sm:w-4 sm:h-4" />
                  <span className="hidden sm:inline">导出短链</span>
                  <span className="sm:hidden">导出</span>
                </>
              )}
            </motion.button>

            {/* 导入按钮 */}
            <div className="relative">
              <input
                type="file"
                accept=".txt"
                onChange={handleFileSelect}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={importingData}
              />
              <motion.button type="button"
                disabled={importingData}
                className={cn(studioSecondaryButtonClassName, 'w-full sm:w-auto')}
                whileHover={hoverScale(1.02, !importingData)}
                whileTap={tapScale(0.98, !importingData)}>
                {importingData ? (
                  <>
                    <FaSync className="animate-spin w-3 h-3 sm:w-4 sm:h-4" />
                    <span className="hidden sm:inline">导入中...</span>
                    <span className="sm:hidden">导入中</span>
                  </>
                ) : (
                  <>
                    <FaUpload className="w-3 h-3 sm:w-4 sm:h-4" />
                    <span className="hidden sm:inline">导入短链</span>
                    <span className="sm:hidden">导入</span>
                  </>
                )}
              </motion.button>
            </div>

            {/* 删除全部按钮 */}
            <motion.button type="button"
              onClick={handleDeleteAll}
              disabled={deletingAll || links.length === 0}
              className={cn(studioDangerButtonClassName, 'w-full sm:w-auto')}
              whileHover={hoverScale(1.02, !deletingAll && links.length > 0)}
              whileTap={tapScale(0.98, !deletingAll && links.length > 0)}>
              {deletingAll ? (
                <>
                  <FaSync className="animate-spin w-3 h-3 sm:w-4 sm:h-4" />
                  <span className="hidden sm:inline">删除中...</span>
                  <span className="sm:hidden">删除中</span>
                </>
              ) : (
                <>
                  <FaTrash className="w-3 h-3 sm:w-4 sm:h-4" />
                  <span className="hidden sm:inline">删除全部</span>
                  <span className="sm:hidden">删除全部</span>
                </>
              )}
            </motion.button>

            {/* 批量操作按钮 */}
            <motion.button type="button"
              onClick={toggleSelectMode}
              className={cn(isSelectMode ? studioPrimaryButtonClassName : studioSecondaryButtonClassName, 'w-full sm:w-auto')}
              whileHover={hoverScale(1.02)}
              whileTap={tapScale(0.98)}>
              {isSelectMode ? <FaToggleOn className="w-3 h-3 sm:w-4 sm:h-4" /> : <FaToggleOff className="w-3 h-3 sm:w-4 sm:h-4" />}
              <span className="hidden sm:inline">{isSelectMode ? '退出选择' : '批量选择'}</span>
              <span className="sm:hidden">{isSelectMode ? '退出' : '批量'}</span>
            </motion.button>
          </div>
        </div>

        {/* 批量操作控制栏 */}
        <AnimatePresence>
          {isSelectMode && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-4 pt-4 border-t border-slate-200"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-sm text-slate-600">
                    已选择 {selectedLinks.size} 个短链
                  </span>
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                    <motion.button type="button"
                      onClick={selectAllLinks}
                      className={cn(studioSecondaryButtonClassName, 'w-full sm:w-auto')}
                      whileTap={tapScale(0.95)}>
                      全选
                    </motion.button>
                    <motion.button type="button"
                      onClick={clearSelection}
                      className={cn(studioSecondaryButtonClassName, 'w-full sm:w-auto')}
                      whileTap={tapScale(0.95)}>
                      清空选择
                    </motion.button>
                  </div>
                </div>

                {selectedLinks.size > 0 && (
                  <motion.button type="button"
                    onClick={handleBatchDelete}
                    disabled={batchDeleting}
                    className={cn(studioDangerButtonClassName, 'w-full sm:w-auto')}
                    whileHover={hoverScale(1.02)}
                    whileTap={tapScale(0.98)}>
                    <FaTrash className="w-3 h-3 sm:w-4 sm:h-4" />
                    <span className="hidden sm:inline">{batchDeleting ? '删除中...' : `删除 ${selectedLinks.size} 个`}</span>
                    <span className="sm:hidden">{batchDeleting ? '删除中' : `删除${selectedLinks.size}个`}</span>
                  </motion.button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* 目标地址输入 */}
          <div>
            <label className="block text-sm font-medium text-slate-900 mb-2">
              目标地址 *
            </label>
            <input
              className={studioFieldClassName}
              placeholder="请输入要生成短链的目标地址（如 https://...）"
              value={createTarget}
              onChange={e => setCreateTarget(e.target.value)}
              disabled={creating}
            />
          </div>

          {/* 自定义码输入 */}
          <div>
            <label className="block text-sm font-medium text-slate-900 mb-2">
              自定义短链码（可选）
            </label>
            <div className="flex items-center gap-2">
              <input
                className={cn(studioFieldClassName, 'flex-1')}
                placeholder="自定义短链接码"
                value={customCode}
                onChange={e => {
                  setCustomCode(e.target.value);
                  validateCustomCode(e.target.value);
                }}
                disabled={creating}
              />
              <motion.button type="button"
                className={cn(studioPrimaryButtonClassName, 'min-h-11 px-3')}
                onClick={generateRandomCode}
                disabled={creating}
                title="生成随机短链接码"
                whileTap={tapScale(0.95)}>
                <FaDice className="w-4 h-4" />
              </motion.button>
            </div>
          </div>
        </div>

        {/* 验证提示 */}
        <AnimatePresence>
          {customCode.trim() && (
            <motion.div
              className="mt-3 flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
            >
              <span className="flex items-center gap-2">
                <FaInfoCircle className="text-sky-700" />
                自定义短链接码提示：只能包含字母、数字、连字符(-)和下划线(_)，长度1-200个字符。留空则自动生成随机短链接码。
              </span>
              <button type="button"
                className={cn(studioSecondaryButtonClassName, 'w-full sm:w-auto')}
                onClick={clearCustomCode}>
                清除
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 验证状态 */}
        <AnimatePresence>
          {codeValidation && (
            <motion.div
              className={`mt-3 flex items-center gap-2 rounded-2xl border p-3 text-sm ${codeValidation.isValid
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-rose-50 text-rose-700 border-rose-200'
                }`}
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
            >
              {codeValidation.isValid ? (
                <FaCheckCircle className="w-4 h-4 text-emerald-500" />
              ) : (
                <FaExclamationTriangle className="w-4 h-4 text-rose-500" />
              )}
              <span>{codeValidation.message}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 创建按钮 */}
        <div className="mt-4">
          <motion.button type="button"
            onClick={handleCreate}
            disabled={creating}
            className={cn(studioPrimaryButtonClassName, 'w-full py-2 sm:py-3')}
            whileHover={hoverScale(1.02, !creating)}
            whileTap={tapScale(0.98, !creating)}>
            {creating ? (
              <div className="flex items-center justify-center space-x-2">
                <div className="w-4 h-4 sm:w-5 sm:h-5 border-b-2 border-sky-500 rounded-full animate-spin" />
                <span className="hidden sm:inline">创建中...</span>
                <span className="sm:hidden">创建中</span>
              </div>
            ) : (
              <div className="flex items-center justify-center space-x-2">
                <FaPlus className="w-4 h-4 sm:w-5 sm:h-5" />
                <span className="hidden sm:inline">创建短链</span>
                <span className="sm:hidden">创建</span>
              </div>
            )}
          </motion.button>
        </div>
      </motion.div>

      {/* 短链列表 */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className={studioMainSurfaceClassName}
      >
        <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
          <FaLink className="w-5 h-5 text-sky-600" />
          短链列表
          {totalItems > 0 && (
            <span className="text-sm text-slate-500 bg-slate-100 px-2 py-1 rounded-full border border-slate-200">
              共 {totalItems} 个
              {search && ` (筛选后)`}
            </span>
          )}
        </h3>

        {/* 桌面端表格视图：表头与表体在同一滚动容器内，避免列错位 */}
        <div className="hidden md:block">
          <div
            ref={containerRef}
            className="overflow-auto rounded-2xl border border-slate-200"
            style={{ height: useVirtualScrolling ? `${containerHeight}px` : 'auto', maxHeight: `${containerHeight}px` }}
            onScroll={useVirtualScrolling ? handleScroll : undefined}
          >
            <table className="min-w-full table-fixed text-sm text-slate-900">
              <colgroup>
                {isSelectMode && <col className="w-12" />}
                <col className="w-[14%]" />
                <col className="w-[28%]" />
                <col className="w-[16%]" />
                <col className="w-[12%]" />
                <col className="w-[14%]" />
                <col className="w-[16%]" />
              </colgroup>
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-100 border-b border-slate-200">
                  {isSelectMode && (
                    <th className="py-3 px-3 text-center font-semibold text-slate-900">
                      <input
                        type="checkbox"
                        checked={links.length > 0 && links.every(link => selectedLinks.has(link._id))}
                        onChange={(e) => {
                          if (e.target.checked) {
                            selectAllLinks();
                          } else {
                            clearSelection();
                          }
                        }}
                        className="rounded border-slate-200 text-sky-600 focus:ring-slate-300"
                      />
                    </th>
                  )}
                  <th className="py-3 px-3 text-left font-semibold text-slate-900">短链码</th>
                  <th className="py-3 px-3 text-left font-semibold text-slate-900">目标地址</th>
                  <th className="py-3 px-3 text-left font-semibold text-slate-900">创建时间</th>
                  <th className="py-3 px-3 text-left font-semibold text-slate-900">用户</th>
                  <th className="py-3 px-3 text-left font-semibold text-slate-900">用户ID</th>
                  <th className="py-3 px-3 text-center font-semibold text-slate-900">操作</th>
                </tr>
              </thead>
              <tbody>
                {useVirtualScrolling && totalItems > 0 && (
                  <tr aria-hidden="true" style={{ height: `${offsetY}px` }}>
                    <td colSpan={isSelectMode ? 7 : 6} className="p-0 border-0" />
                  </tr>
                )}
                {loading ? (
                  <tr>
                    <td colSpan={isSelectMode ? 7 : 6}>
                      <StudioLoadingState minHeightClassName="min-h-[160px]" />
                    </td>
                  </tr>
                ) : totalItems === 0 && !loadError ? (
                  <tr>
                    <td colSpan={isSelectMode ? 7 : 6}>
                      <StudioEmptyState
                        message="还没有任何短链。"
                        action={<button type="button" onClick={generateRandomCode} className={studioSecondaryButtonClassName}>生成一个短链码</button>}
                      />
                    </td>
                  </tr>
                ) : (useVirtualScrolling ? visibleItems : links).map((link) => (
                  <tr
                    key={link._id}
                    className={`border-b border-slate-200 hover:bg-slate-50 ${highlightedId === link._id ? 'bg-amber-50' : ''}`}
                    style={{ height: `${itemHeight}px` }}
                  >
                    {isSelectMode && (
                      <td className="whitespace-nowrap px-3 py-3 text-center">
                        <input
                          type="checkbox"
                          checked={selectedLinks.has(link._id)}
                          onChange={() => toggleSelectLink(link._id)}
                          className="rounded border-slate-200 text-sky-600 focus:ring-slate-300"
                        />
                      </td>
                    )}
                    <td
                      className="py-3 px-3 font-mono text-sky-700 break-all cursor-pointer hover:text-slate-900 transition font-semibold"
                      onClick={() => window.open(`${getApiBaseUrl()}/s/${link.code}`, '_blank')}
                    >
                      {link.code}
                    </td>
                    <td className="py-3 px-3 break-all text-slate-900">{link.target}</td>
                    <td className="py-3 px-3 whitespace-nowrap text-slate-600">{new Date(link.createdAt).toLocaleString()}</td>
                    <td className="py-3 px-3 break-all text-slate-900 font-medium">{link.username || 'admin'}</td>
                    <td className="py-3 px-3 break-all text-slate-500 text-xs">{link.userId || 'admin'}</td>
                    <td className="py-3 px-3 text-center">
                      <div className="flex gap-2 justify-center">
                        <motion.button type="button"
                          className={cn(
                            'flex min-h-11 items-center justify-center gap-2 rounded-full border border-slate-200 bg-white/80 px-2.5 py-1 text-sky-700 transition hover:bg-slate-100',
                            copiedCode === link.code && studioPillClassName(true),
                          )}
                          title="复制短链"
                          onClick={() => handleCopy(link.code)}
                          whileHover={hoverScale(1.1)}
                          whileTap={tapScale(0.9)}>
                          <FaCopy className="w-4 h-4" />
                        </motion.button>
                        <motion.button type="button"
                          className="flex min-h-11 items-center justify-center rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-rose-600 transition hover:bg-rose-100"
                          title="删除"
                          onClick={() => handleDelete(link._id)}
                          whileHover={hoverScale(1.1)}
                          whileTap={tapScale(0.9)}>
                          <FaTrash className="w-4 h-4" />
                        </motion.button>
                      </div>
                    </td>
                  </tr>
                ))}
                {useVirtualScrolling && totalItems > 0 && (
                  <tr aria-hidden="true" style={{ height: `${Math.max(0, totalItems * itemHeight - offsetY - (useVirtualScrolling ? visibleItems.length : totalItems) * itemHeight)}px` }}>
                    <td colSpan={isSelectMode ? 7 : 6} className="p-0 border-0" />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* 移动端卡片列表视图 */}
        <div className="md:hidden">
          <div
            ref={mobileContainerRef}
            className="overflow-auto"
            style={{ height: useVirtualScrolling ? `${containerHeight}px` : 'auto', maxHeight: `${containerHeight}px` }}
            onScroll={useVirtualScrolling ? handleScroll : undefined}
          >
            <div style={{ height: useVirtualScrolling ? `${totalItems * itemHeight}px` : 'auto', position: 'relative' }}>
              <div style={{ transform: useVirtualScrolling ? `translateY(${offsetY}px)` : 'none' }} className="space-y-3">
                {loading ? (
                  <StudioLoadingState minHeightClassName="min-h-[160px]" />
                ) : totalItems === 0 && !loadError ? (
                  <StudioEmptyState
                    message="还没有任何短链。"
                    action={<button type="button" onClick={generateRandomCode} className={studioSecondaryButtonClassName}>生成一个短链码</button>}
                  />
                ) : (useVirtualScrolling ? visibleItems : links).map((link) => (
                  <div
                    key={link._id}
                    className={`rounded-2xl border border-slate-200 bg-white/80 p-4 shadow-sm ${highlightedId === link._id ? 'ring-2 ring-amber-200 bg-amber-50' : ''}`}
                    style={{ minHeight: `${itemHeight}px` }}
                  >
                    {/* 短链码区域 */}
                    <div className="flex items-center justify-between mb-3 gap-2">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        {isSelectMode && (
                          <input
                            type="checkbox"
                            checked={selectedLinks.has(link._id)}
                            onChange={() => toggleSelectLink(link._id)}
                            className="rounded border-slate-200 text-sky-600 focus:ring-slate-300 mr-2 flex-shrink-0"
                          />
                        )}
                        <div
                          className="font-mono text-lg font-bold text-sky-700 cursor-pointer truncate"
                          onClick={() => window.open(`${getApiBaseUrl()}/s/${link.code}`, '_blank')}
                        >
                          {link.code}
                        </div>
                      </div>
                      <div className="flex gap-1 flex-shrink-0">
                        <motion.button type="button"
                          className={cn(
                            'flex min-h-11 items-center justify-center gap-2 rounded-full border border-slate-200 bg-white/80 px-2.5 py-1 text-sky-700 transition hover:bg-slate-100',
                            copiedCode === link.code && studioPillClassName(true),
                          )}
                          title="复制短链"
                          onClick={() => handleCopy(link.code)}
                          whileHover={hoverScale(1.1)}
                          whileTap={tapScale(0.9)}>
                          <FaCopy className="w-3 h-3 sm:w-4 sm:h-4" />
                        </motion.button>
                        <motion.button type="button"
                          className="flex min-h-11 items-center justify-center rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-rose-600 transition hover:bg-rose-100"
                          title="删除"
                          onClick={() => handleDelete(link._id)}
                          whileHover={hoverScale(1.1)}
                          whileTap={tapScale(0.9)}>
                          <FaTrash className="w-3 h-3 sm:w-4 sm:h-4" />
                        </motion.button>
                      </div>
                    </div>

                    {/* 目标地址 */}
                    <div className="mb-3">
                      <div className="text-xs text-slate-500 mb-1">目标地址</div>
                      <div className="text-sm text-slate-900 break-all">{link.target}</div>
                    </div>

                    {/* 底部信息 */}
                    <div className="flex flex-col gap-2 text-xs text-slate-500">
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1">
                          <span className="text-slate-400">用户:</span>
                          <span className="text-slate-900">{link.username || 'admin'}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-slate-400">时间:</span>
                          <span className="text-slate-900">{new Date(link.createdAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                      <div className="text-slate-400">
                        {new Date(link.createdAt).toLocaleTimeString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* 分页控件 */}
      {totalPages > 1 && (
        <div className={studioMainSurfaceClassName}>
          <StudioPager
            page={page}
            pageSize={PAGE_SIZE}
            total={total}
            loading={loading}
            onPageChange={handlePageChange}
          />
        </div>
      )}
    </div>
  );
};

export default ShortLinkManager;
