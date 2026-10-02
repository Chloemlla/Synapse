import React, { useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  FaBan, FaUnlock, FaTrash, FaSync,
  FaExclamationTriangle, FaShieldAlt, FaClock,
  FaUserShield, FaTimes, FaList
} from 'react-icons/fa';
import { Link } from 'react-router-dom';
import { turnstileApi, IPBanStats, IPBanListSummary } from '../api/turnstile';
import { useAuth } from '../hooks/useAuth';
import { isSuperAdmin } from '../utils/rbac';
import { UnifiedLoadingSpinner } from './LoadingSpinner';
import { useNotification } from './Notification';
import BanListPanel from './ip-ban/BanListPanel';
import { parseBatchInput } from './ip-ban/ipValidation';
import {
  InfoBadge,
  InfoMetricCard,
  InfoPanel,
  InfoSectionTitle,
  studioDangerButtonClassName,
  studioFieldClassName,
  studioSecondaryButtonClassName,
  studioSurfaceClassName,
} from './studioTheme';

interface BanIPModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  mode: 'single' | 'batch';
  canWrite: boolean;
}

interface UnbanIPModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  mode: 'single' | 'batch';
  canWrite: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (!isRecord(error)) return fallback;
  const response = error.response;
  if (isRecord(response)) {
    const data = response.data;
    if (isRecord(data) && typeof data.error === 'string') return data.error;
    if (isRecord(data) && typeof data.message === 'string') return data.message;
  }
  return typeof error.message === 'string' ? error.message : fallback;
}

/**
 * 批量输入预览：提交前就告诉管理员「实际会提交几条、哪些会被忽略」。
 * 以前是原样发出去、只拿回一个数字，粘贴里混了空行/重复/非法行时无从对账。
 */
function BatchPreview({ raw }: { raw: string }) {
  if (!raw.trim()) return null;
  const { valid, duplicates, invalid } = parseBatchInput(raw);
  return (
    <div className="mt-2 space-y-2" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <InfoBadge tone={valid.length > 0 ? 'emerald' : 'rose'}>将提交 {valid.length} 条</InfoBadge>
        {duplicates.length > 0 ? (
          <InfoBadge tone="amber">重复 {duplicates.length} 条（已自动去重）</InfoBadge>
        ) : null}
        {invalid.length > 0 ? (
          <InfoBadge tone="rose">非法 {invalid.length} 条（将被忽略）</InfoBadge>
        ) : null}
      </div>
      {invalid.length > 0 ? (
        <p className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 font-mono text-[11px] leading-5 break-all text-rose-700">
          非法行：{invalid.slice(0, 5).join('、')}
          {invalid.length > 5 ? ` 等 ${invalid.length} 条` : ''}
        </p>
      ) : null}
    </div>
  );
}

function BanIPModal({ isOpen, onClose, onSuccess, mode, canWrite }: BanIPModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    ipAddress: '',
    ipAddresses: '',
    reason: '',
    durationMinutes: 60
  });
  const { setNotification } = useNotification();

  useEffect(() => {
    if (isOpen) {
      setError('');
      setFormData({
        ipAddress: '',
        ipAddresses: '',
        reason: '',
        durationMinutes: 60
      });
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    setError('');

    if (mode === 'single') {
      if (!formData.ipAddress.trim()) {
        setError('请输入IP地址');
        return;
      }
    } else if (!formData.ipAddresses.trim()) {
      setError('请输入IP地址列表');
      return;
    }

    setLoading(true);
    try {
      if (mode === 'single') {
        await turnstileApi.banIP(formData.ipAddress, formData.reason, formData.durationMinutes);
        setNotification({
          message: `成功封禁IP: ${formData.ipAddress}`,
          type: 'success'
        });
      } else {
        // 提交前用与后端同口径的校验去空行/去重/挑出非法行，并告知实际会提交多少条 ——
        // 以前是把粘贴内容原样发出去，非法行只在后端逐条报错（而接口只返回一个数字）。
        const parsed = parseBatchInput(formData.ipAddresses);
        if (parsed.valid.length === 0) {
          setError('没有可提交的合法 IP 或 CIDR');
          return;
        }
        const result = await turnstileApi.banIPs(parsed.valid, formData.reason, formData.durationMinutes);
        const skipped: string[] = [];
        if (parsed.invalid.length > 0) skipped.push(`忽略非法 ${parsed.invalid.length} 条`);
        if (parsed.duplicates.length > 0) skipped.push(`忽略重复 ${parsed.duplicates.length} 条`);
        setNotification({
          message: `已提交 ${parsed.valid.length} 条，封禁生效 ${result.bannedCount} 条${skipped.length ? `（${skipped.join('，')}）` : ''}`,
          type: 'success'
        });
      }
      onSuccess();
      onClose();
    } catch (err: unknown) {
      console.error('封禁IP失败:', err);
      const msg = getErrorMessage(err, '封禁失败，请重试');
      setError(msg);
      setNotification({ message: msg, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return ReactDOM.createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9999] h-full w-full overflow-y-auto bg-black/50 p-4 backdrop-blur-sm sm:p-0"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          className={`${studioSurfaceClassName} relative top-0 mx-auto my-4 max-h-[95vh] w-full max-w-2xl overflow-y-auto p-4 sm:top-16 sm:my-0 sm:p-5`}
        >
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
                <FaBan className="h-5 w-5 text-slate-500" />
                {mode === 'single' ? '封禁IP' : '批量封禁IP'}
              </h3>
              <button onClick={onClose} className="inline-flex items-center justify-center p-1 text-slate-400 transition-colors hover:text-slate-600">
                <FaTimes className="w-5 h-5" />
              </button>
            </div>
            
            <form onSubmit={handleSubmit} className="space-y-4">
              {mode === 'single' ? (
                <div>
                  <label className="block text-sm font-semibold text-slate-700">IP地址或IP段（CIDR）</label>
                  <input
                    type="text"
                    required
                    disabled={!canWrite}
                    className={`${studioFieldClassName} mt-1`}
                    value={formData.ipAddress}
                    onChange={(e) => setFormData({ ...formData, ipAddress: e.target.value })}
                    placeholder="例如: 192.168.1.100 或 192.168.1.0/24"
                  />
                  <p className="mt-1 text-xs text-slate-500">支持单个IP或CIDR格式（IPv4: 192.168.1.0/24，IPv6: 2001:db8::/32）</p>
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-semibold text-slate-700">IP地址列表或IP段（CIDR）</label>
                  <textarea
                    required
                    rows={6}
                    disabled={!canWrite}
                    className={`${studioFieldClassName} mt-1`}
                    value={formData.ipAddresses}
                    onChange={(e) => setFormData({ ...formData, ipAddresses: e.target.value })}
                    placeholder="每行一个IP或IP段，例如：&#10;192.168.1.100&#10;192.168.1.0/24&#10;10.0.0.0/8&#10;2001:db8::/32"
                  />
                  <p className="mt-1 text-xs text-slate-500">每行输入一个IP地址或CIDR IP段（支持IPv4和IPv6）</p>
                  <BatchPreview raw={formData.ipAddresses} />
                </div>
              )}

              <div>
                <label className="block text-sm font-semibold text-slate-700">封禁原因</label>
                <textarea
                  required
                  rows={3}
                  disabled={!canWrite}
                  className={`${studioFieldClassName} mt-1`}
                  value={formData.reason}
                  onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                  placeholder="请输入封禁原因..."
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700">封禁时长（分钟）</label>
                <input
                  type="number"
                  min="1"
                  max="1440"
                  required
                  disabled={!canWrite}
                  className={`${studioFieldClassName} mt-1`}
                  value={formData.durationMinutes}
                  onChange={(e) => setFormData({ ...formData, durationMinutes: parseInt(e.target.value) || 60 })}
                />
                <p className="mt-1 text-xs text-slate-500">1分钟到24小时（1440分钟）</p>
              </div>

              {error && (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 p-3">
                  <p className="text-sm text-rose-700">{error}</p>
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-3 pt-4">
                <button
                  type="button"
                  onClick={onClose}
                  className={studioSecondaryButtonClassName}
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={loading || !canWrite}
                  className={studioDangerButtonClassName}
                >
                  {loading ? '处理中...' : (mode === 'single' ? '封禁IP' : '批量封禁')}
                </button>
              </div>
            </form>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  , document.body);
}

function UnbanIPModal({ isOpen, onClose, onSuccess, mode, canWrite }: UnbanIPModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [formData, setFormData] = useState({
    ipAddress: '',
    ipAddresses: ''
  });
  const { setNotification } = useNotification();

  useEffect(() => {
    if (isOpen) {
      setError('');
      setFormData({
        ipAddress: '',
        ipAddresses: ''
      });
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canWrite) return;
    setError('');

    if (mode === 'single') {
      if (!formData.ipAddress.trim()) {
        setError('请输入IP地址');
        return;
      }
    } else if (!formData.ipAddresses.trim()) {
      setError('请输入IP地址列表');
      return;
    }

    setLoading(true);
    try {
      if (mode === 'single') {
        await turnstileApi.unbanIP(formData.ipAddress);
        setNotification({
          message: `成功解封IP: ${formData.ipAddress}`,
          type: 'success'
        });
      } else {
        const parsed = parseBatchInput(formData.ipAddresses);
        if (parsed.valid.length === 0) {
          setError('没有可提交的合法 IP 或 CIDR');
          return;
        }
        const result = await turnstileApi.unbanIPs(parsed.valid);
        setNotification({
          message: `已提交 ${parsed.valid.length} 条，解除 ${result.unbannedCount} 条${parsed.invalid.length ? `（忽略非法 ${parsed.invalid.length} 条）` : ''}`,
          type: 'success'
        });
      }
      onSuccess();
      onClose();
    } catch (err: unknown) {
      console.error('解封IP失败:', err);
      const msg = getErrorMessage(err, '解封失败，请重试');
      setError(msg);
      setNotification({ message: msg, type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return ReactDOM.createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9999] h-full w-full overflow-y-auto bg-black/50 p-4 backdrop-blur-sm sm:p-0"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 20 }}
          className={`${studioSurfaceClassName} relative top-0 mx-auto my-4 max-h-[95vh] w-full max-w-2xl overflow-y-auto p-4 sm:top-16 sm:my-0 sm:p-5`}
        >
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="flex items-center gap-2 text-xl font-semibold text-slate-900">
                <FaUnlock className="h-5 w-5 text-slate-500" />
                {mode === 'single' ? '解封IP' : '批量解封IP'}
              </h3>
              <button onClick={onClose} className="inline-flex items-center justify-center p-1 text-slate-400 transition-colors hover:text-slate-600">
                <FaTimes className="w-5 h-5" />
              </button>
            </div>
            
            <form onSubmit={handleSubmit} className="space-y-4">
              {mode === 'single' ? (
                <div>
                  <label className="block text-sm font-semibold text-slate-700">IP地址或IP段（CIDR）</label>
                  <input
                    type="text"
                    required
                    disabled={!canWrite}
                    className={`${studioFieldClassName} mt-1`}
                    value={formData.ipAddress}
                    onChange={(e) => setFormData({ ...formData, ipAddress: e.target.value })}
                    placeholder="例如: 192.168.1.100 或 192.168.1.0/24"
                  />
                  <p className="mt-1 text-xs text-slate-500">支持单个IP或CIDR格式（IPv4: 192.168.1.0/24，IPv6: 2001:db8::/32）</p>
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-semibold text-slate-700">IP地址列表或IP段（CIDR）</label>
                  <textarea
                    required
                    rows={6}
                    disabled={!canWrite}
                    className={`${studioFieldClassName} mt-1`}
                    value={formData.ipAddresses}
                    onChange={(e) => setFormData({ ...formData, ipAddresses: e.target.value })}
                    placeholder="每行一个IP或IP段，例如：&#10;192.168.1.100&#10;192.168.1.0/24&#10;10.0.0.0/8&#10;2001:db8::/32"
                  />
                  <p className="mt-1 text-xs text-slate-500">每行输入一个IP地址或CIDR IP段（支持IPv4和IPv6）</p>
                  <BatchPreview raw={formData.ipAddresses} />
                </div>
              )}

              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700"
                >
                  <FaExclamationTriangle className="w-4 h-4" />
                  {error}
                </motion.div>
              )}

              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={onClose}
                  className={studioSecondaryButtonClassName}
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={loading || !canWrite}
                  className={studioSecondaryButtonClassName}
                >
                  {loading ? <UnifiedLoadingSpinner size="sm" /> : <FaUnlock />}
                  {mode === 'single' ? '解封IP' : '批量解封'}
                </button>
              </div>
            </form>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  , document.body);
}

export default function IPBanManager() {
  const [stats, setStats] = useState<IPBanStats | null>(null);
  const [summary, setSummary] = useState<IPBanListSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [showBanModal, setShowBanModal] = useState(false);
  const [showUnbanModal, setShowUnbanModal] = useState(false);
  const [banMode, setBanMode] = useState<'single' | 'batch'>('single');
  const [unbanMode, setUnbanMode] = useState<'single' | 'batch'>('single');
  const { setNotification } = useNotification();
  const { user } = useAuth();
  const canWrite = isSuperAdmin(user?.role);

  const handleSummary = React.useCallback((next: IPBanListSummary) => {
    setSummary(next);
  }, []);

  const fetchStats = async () => {
    try {
      const data = await turnstileApi.getIPBanStats();
      setStats(data);
    } catch (error) {
      console.error('获取IP封禁统计失败:', error);
      setNotification({
        message: '获取IP封禁统计失败',
        type: 'error'
      });
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await fetchStats();
    // 同一按钮同时刷新统计与名单：两处数据分属不同接口，各刷各的会看到互相矛盾的瞬时值。
    setReloadToken((prev) => prev + 1);
    setRefreshing(false);
    setNotification({
      message: 'IP封禁统计已刷新',
      type: 'success'
    });
  };

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      await fetchStats();
      setLoading(false);
    };
    loadData();
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-[min(24rem,50dvh)] items-center justify-center">
        <UnifiedLoadingSpinner size="lg" text="加载IP封禁管理..." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <InfoPanel>
        <InfoSectionTitle
          eyebrow="Access Control"
          title="IP封禁管理"
          description="管理 IP 与 CIDR 封禁列表：查看名单、检索与批量核销，支持单个和批量封禁/解封以及实时统计刷新。"
          icon={FaShieldAlt}
          action={
            <Link to="/admin" className={studioSecondaryButtonClassName}>
              <FaTimes className="w-4 h-4" />
              返回仪表板
            </Link>
          }
        />
        {!canWrite ? (
          <p className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            当前账号为普通管理员：可查看名单与统计，封禁 / 解封操作只对超级管理员开放。
          </p>
        ) : null}
      </InfoPanel>

      {/* 统计信息 */}
      {stats && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <InfoMetricCard label="总封禁数" value={stats.totalBanned} detail="历史封禁记录" icon={FaBan} />
          <InfoMetricCard label="活跃封禁" value={stats.activeBans} detail="当前仍生效" icon={FaShieldAlt} />
          <InfoMetricCard label="已过期" value={stats.expiredBans} detail="等待清理或同步" icon={FaUnlock} />
          <InfoMetricCard label="最近封禁" value={stats.recentBans} detail="近期新增记录" icon={FaClock} />
        </div>
      )}

      {/* 来源构成：手工封与自动封在库里都是 violationCount >= 阈值，只有 source 能区分 */}
      {summary ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span className="font-semibold text-slate-500">封禁来源</span>
          <InfoBadge tone="violet">手工封禁 {summary.manual}</InfoBadge>
          <InfoBadge tone="slate">自动触发 {summary.automatic}</InfoBadge>
          <span className="text-slate-400">合计 {summary.total} 条（生效中 {summary.active} / 已过期 {summary.expired}）</span>
        </div>
      ) : null}

      {/* 操作按钮 */}
      <InfoPanel>
        <div className="space-y-4">
          <InfoSectionTitle eyebrow="Actions" title="封禁操作" icon={FaUserShield} />
          
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <motion.button
              onClick={() => {
                setBanMode('single');
                setShowBanModal(true);
              }}
              disabled={!canWrite}
              className={studioDangerButtonClassName}
              whileHover={{ scale: canWrite ? 1.02 : 1 }}
              whileTap={{ scale: canWrite ? 0.98 : 1 }}
            >
              <FaBan className="w-4 h-4" />
              单个封禁
            </motion.button>

            <motion.button
              onClick={() => {
                setBanMode('batch');
                setShowBanModal(true);
              }}
              disabled={!canWrite}
              className={studioDangerButtonClassName}
              whileHover={{ scale: canWrite ? 1.02 : 1 }}
              whileTap={{ scale: canWrite ? 0.98 : 1 }}
            >
              <FaList className="w-4 h-4" />
              批量封禁
            </motion.button>

            <motion.button
              onClick={() => {
                setUnbanMode('single');
                setShowUnbanModal(true);
              }}
              disabled={!canWrite}
              className={studioSecondaryButtonClassName}
              whileHover={{ scale: canWrite ? 1.02 : 1 }}
              whileTap={{ scale: canWrite ? 0.98 : 1 }}
            >
              <FaUnlock className="w-4 h-4" />
              单个解封
            </motion.button>

            <motion.button
              onClick={() => {
                setUnbanMode('batch');
                setShowUnbanModal(true);
              }}
              disabled={!canWrite}
              className={studioSecondaryButtonClassName}
              whileHover={{ scale: canWrite ? 1.02 : 1 }}
              whileTap={{ scale: canWrite ? 0.98 : 1 }}
            >
              <FaUnlock className="w-4 h-4" />
              批量解封
            </motion.button>

            <motion.button
              onClick={handleRefresh}
              disabled={refreshing}
              className={studioSecondaryButtonClassName}
              whileHover={{ scale: refreshing ? 1 : 1.02 }}
              whileTap={{ scale: refreshing ? 1 : 0.98 }}
            >
              <FaSync className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              刷新
            </motion.button>
          </div>
        </div>
      </InfoPanel>

      {/* 模态框 */}
      <BanIPModal
        isOpen={showBanModal}
        onClose={() => setShowBanModal(false)}
        onSuccess={handleRefresh}
        mode={banMode}
        canWrite={canWrite}
      />

      <UnbanIPModal
        isOpen={showUnbanModal}
        onClose={() => setShowUnbanModal(false)}
        onSuccess={handleRefresh}
        mode={unbanMode}
        canWrite={canWrite}
      />

      {/* 封禁名单：这一页以前只有 4 个数字，封禁是「只写不读」的操作 */}
      <BanListPanel
        canWrite={canWrite}
        reloadToken={reloadToken}
        onSummary={handleSummary}
      />
    </div>
  );
}
