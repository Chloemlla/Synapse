import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import DOMPurify from 'dompurify';
import MarkdownRenderer from './MarkdownRenderer';
import getApiBaseUrl from '../api';
import { useNotification } from './Notification';
import { useConfirm } from './confirm/ConfirmDialogProvider';
import { useAuth } from '../hooks/useAuth';
import { isAdminRole, isSuperAdmin } from '../utils/rbac';
import {
  FaBullhorn,
  FaEdit,
  FaLock,
} from 'react-icons/fa';
import { cn } from '../utils/cn';
import {
  studioDangerButtonClassName,
  studioPanelClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
  studioSubPanelClassName,
  studioTextareaClassName,
} from './studioTheme';
import { StudioEmptyState, StudioErrorState, StudioLoadingState } from './studioFeedback';
import { useReducedMotion } from '../hooks/useReducedMotion';

const API_URL = getApiBaseUrl() + '/api/admin/announcement';

const AnnouncementManager: React.FC = () => {
  const { user } = useAuth();
  const canWrite = isSuperAdmin(user?.role);
  const [content, setContent] = useState('');
  const [format, setFormat] = useState<'markdown' | 'html'>('markdown');
  const [loading, setLoading] = useState(true);
  // F4-04：区分「加载失败」与「确实没有公告」，失败时给出重试入口
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const { setNotification } = useNotification();
  const confirm = useConfirm();
  const reducedMotion = useReducedMotion();

  // 获取公告
  const fetchAnnouncement = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(API_URL, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        switch (data.error) {
          case '未携带Token，请先登录':
            setNotification({ message: '请先登录后再操作', type: 'error' });
            break;
          case 'Token格式错误，需以Bearer开头':
          case 'Token为空':
          case '无效的认证令牌':
          case '认证令牌已过期':
            setNotification({ message: '登录状态已失效，请重新登录', type: 'error' });
            break;
          case '用户不存在':
            setNotification({ message: '用户不存在，请重新登录', type: 'error' });
            break;
          case '需要管理员权限':
          case '无权限':
            setNotification({ message: '需要管理员权限', type: 'error' });
            break;
          default:
            setNotification({ message: data.error || '获取公告失败', type: 'error' });
        }
        // F4-04：失败时保留已加载的公告内容与格式，不再清空成「暂无公告」的假空态
        setLoadError(data.error || '获取公告失败，请稍后重试');
        setLoading(false);
        return;
      }
      if (data.success && data.announcement) {
        setContent(data.announcement.content || '');
        setFormat(data.announcement.format || 'markdown');
      } else {
        setContent('');
      }
    } catch (e) {
      setNotification({ message: '获取公告失败：' + (e instanceof Error ? e.message : (e && e.toString ? e.toString() : '未知错误')), type: 'error' });
      setLoadError('获取公告失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAnnouncement();
  }, []);

  // 保存公告
  const saveAnnouncement = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content, format }),
      });
      const data = await res.json();
      if (!res.ok) {
        switch (data.error) {
          case '未携带Token，请先登录':
            setNotification({ message: '请先登录后再操作', type: 'error' });
            break;
          case 'Token格式错误，需以Bearer开头':
          case 'Token为空':
          case '无效的认证令牌':
          case '认证令牌已过期':
            setNotification({ message: '登录状态已失效，请重新登录', type: 'error' });
            break;
          case '用户不存在':
            setNotification({ message: '用户不存在，请重新登录', type: 'error' });
            break;
          case '需要管理员权限':
          case '无权限':
            setNotification({ message: '需要管理员权限', type: 'error' });
            break;
          default:
            setNotification({ message: data.error || '保存失败', type: 'error' });
        }
        return;
      }
      if (data.success) {
        setNotification({ message: '保存成功', type: 'success' });
        setEditing(false);
        fetchAnnouncement();
      } else {
        setNotification({ message: data.error || '保存失败', type: 'error' });
      }
    } catch (e) {
      setNotification({ message: '保存失败：' + (e instanceof Error ? e.message : (e && e.toString ? e.toString() : '未知错误')), type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  // 删除公告
  const deleteAnnouncement = async () => {
    if (deleting) return;
    const ok = await confirm({
      title: '删除所有公告？',
      description: '当前公告会被清空，站点将不再展示任何公告。此操作不可撤销。',
      tone: 'danger',
      confirmLabel: '删除公告',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await fetch(API_URL, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        switch (data.error) {
          case '未携带Token，请先登录':
            setNotification({ message: '请先登录后再操作', type: 'error' });
            break;
          case 'Token格式错误，需以Bearer开头':
          case 'Token为空':
          case '无效的认证令牌':
          case '认证令牌已过期':
            setNotification({ message: '登录状态已失效，请重新登录', type: 'error' });
            break;
          case '用户不存在':
            setNotification({ message: '用户不存在，请重新登录', type: 'error' });
            break;
          case '需要管理员权限':
          case '无权限':
            setNotification({ message: '需要管理员权限', type: 'error' });
            break;
          default:
            setNotification({ message: data.error || '删除失败', type: 'error' });
        }
        return;
      }
      if (data.success) {
        setContent('');
        setNotification({ message: '已删除', type: 'success' });
      } else {
        setNotification({ message: data.error || '删除失败', type: 'error' });
      }
    } catch (e) {
      setNotification({ message: '删除失败：' + (e instanceof Error ? e.message : (e && e.toString ? e.toString() : '未知错误')), type: 'error' });
    } finally {
      setDeleting(false);
    }
  };

  if (!user || !isAdminRole(user.role)) {
    return (
      <motion.div 
        className="space-y-6"
        initial={reducedMotion ? false : { opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <motion.div 
          className="rounded-2xl border border-rose-200 bg-rose-50 p-6"
          initial={reducedMotion ? false : { opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <h2 className="mb-3 flex items-center gap-2 text-2xl font-bold text-rose-700">
            <FaLock className="shrink-0" aria-hidden />
            访问被拒绝
          </h2>
          <div className="space-y-2 text-slate-600">
            <p>你不是管理员，禁止访问！请用管理员账号登录后再来。</p>
            <div className="text-sm italic text-rose-600">
              公告管理仅限管理员使用
            </div>
          </div>
        </motion.div>
      </motion.div>
    );
  }

  return (
    <motion.div 
      className="space-y-6"
      initial={reducedMotion ? false : { opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
    >
      {/* 标题和说明 */}
      <motion.div 
        className="rounded-2xl border border-slate-200 bg-slate-50/80 p-6"
        initial={reducedMotion ? false : { opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <h2 className="text-2xl font-bold text-slate-800 mb-3 flex items-center gap-2">
          <FaBullhorn className="text-2xl text-slate-600" />
          公告管理
        </h2>
        <div className="text-slate-600 space-y-2">
          <p>管理系统公告内容，支持 Markdown 和 HTML 格式。</p>
          <div className="flex items-start gap-2 text-sm">
            <div>
              <p className="font-semibold text-slate-800">功能说明：</p>
              <ul className="list-disc list-inside space-y-1 mt-1">
                <li>支持 Markdown 和 HTML 格式</li>
                <li>实时预览公告效果</li>
                <li>安全的内容过滤</li>
                <li>仅管理员可操作</li>
              </ul>
            </div>
          </div>
        </div>
      </motion.div>

      {/* 公告内容卡片 */}
      <motion.div 
        className={studioPanelClassName}
        initial={reducedMotion ? false : { opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-slate-800">
            <FaEdit className="text-lg text-slate-500" aria-hidden />
            公告内容
          </h3>
          <motion.button
            type="button"
            onClick={fetchAnnouncement}
            disabled={loading}
            className={cn(studioSecondaryButtonClassName, 'min-h-11 shrink-0')}
            whileTap={reducedMotion ? undefined : { scale: 0.95 }}
          >
            <svg className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            刷新
          </motion.button>
        </div>

        {loading ? (
          <StudioLoadingState text="正在读取公告..." minHeightClassName="min-h-[240px]" />
        ) : loadError ? (
          <StudioErrorState message={loadError} onRetry={() => void fetchAnnouncement()} />
        ) : (
          <AnimatePresence mode="wait">
            {editing ? (
              <motion.div
                key="edit"
                initial={reducedMotion ? false : { opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="space-y-4"
              >
                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    公告内容
                  </label>
                  <textarea
                    className={cn(studioTextareaClassName, 'h-40')}
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    placeholder="请输入公告内容"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-semibold text-slate-700 mb-2">
                    格式选择
                  </label>
                  <div className="flex items-center space-x-6">
                    <label className="flex items-center cursor-pointer">
                      <input
                        type="radio"
                        checked={format === 'markdown'}
                        onChange={() => setFormat('markdown')}
                        className="mr-2 text-slate-500"
                      />
                      <span className="text-sm">Markdown</span>
                    </label>
                    <label className="flex items-center cursor-pointer">
                      <input
                        type="radio"
                        checked={format === 'html'}
                        onChange={() => setFormat('html')}
                        className="mr-2 text-slate-500"
                      />
                      <span className="text-sm">HTML</span>
                    </label>
                  </div>
                </div>
                
                <div className="flex flex-col gap-3 sm:flex-row">
                  <motion.button
                    type="button"
                    className={cn(studioPrimaryButtonClassName, 'w-full sm:w-auto')}
                    onClick={saveAnnouncement}
                    disabled={!canWrite || !content.trim() || saving || deleting}
                    whileTap={reducedMotion ? undefined : { scale: 0.95 }}
                  >
                    {saving ? '保存中...' : '保存'}
                  </motion.button>
                  <motion.button
                    type="button"
                    className={cn(studioSecondaryButtonClassName, 'min-h-11 w-full sm:w-auto')}
                    onClick={() => setEditing(false)}
                    disabled={saving || deleting}
                    whileTap={reducedMotion ? undefined : { scale: 0.95 }}
                  >
                    取消
                  </motion.button>
                  <motion.button
                    type="button"
                    className={cn(studioDangerButtonClassName, 'min-h-11 w-full sm:w-auto')}
                    onClick={deleteAnnouncement}
                    disabled={saving || deleting}
                    whileTap={reducedMotion ? undefined : { scale: 0.95 }}
                  >
                    {deleting ? '删除中...' : '删除公告'}
                  </motion.button>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="view"
                initial={reducedMotion ? false : { opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="space-y-4"
              >
                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    公告预览
                  </label>
                  <div className={cn(studioSubPanelClassName, "min-h-[120px]")}>
                    {content ? (
                      format === 'markdown' ? (
                        <MarkdownRenderer content={content} density="compact" />
                      ) : (
                        <div 
                          className="prose prose-sm max-w-none"
                          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content) }} 
                        />
                      )
                    ) : (
                      <StudioEmptyState
                        message="还没有公告内容。点下面的「编辑公告」写第一条，读者会在站点顶部看到它。"
                        className="border-0 bg-transparent px-0 py-2"
                      />
                    )}
                  </div>
                </div>
                
                <div className="flex flex-col gap-3 sm:flex-row">
                  {canWrite && (
                  <motion.button
                    type="button"
                    className={cn(studioPrimaryButtonClassName, 'w-full sm:w-auto')}
                    onClick={() => setEditing(true)}
                    whileTap={reducedMotion ? undefined : { scale: 0.95 }}
                  >
                    编辑公告
                  </motion.button>
                  )}
                  {canWrite && content && (
                    <motion.button
                      type="button"
                      className={cn(studioDangerButtonClassName, 'min-h-11 w-full sm:w-auto')}
                      onClick={deleteAnnouncement}
                      disabled={deleting}
                      whileTap={reducedMotion ? undefined : { scale: 0.95 }}
                    >
                      {deleting ? '删除中...' : '删除公告'}
                    </motion.button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </motion.div>
    </motion.div>
  );
};

export default AnnouncementManager;
