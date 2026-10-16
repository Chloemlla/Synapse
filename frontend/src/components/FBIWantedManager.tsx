import React, { useState, useEffect, useCallback, ChangeEvent, useRef } from 'react';
import ReactDOM from 'react-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { FaSearch, FaPlus, FaEye, FaEdit, FaTrash, FaExclamationTriangle, FaFilter, FaUser, FaTimes, FaImage, FaUpload, FaShieldAlt, FaUserSecret, FaSpinner, FaSave } from 'react-icons/fa';
import { useNotification } from './Notification';
import { useConfirm } from './confirm/ConfirmDialogProvider';
import getApiBaseUrl from '../api';
import { openDB } from 'idb';
import ImageUploadSection from './ImageUploadSection';
import { useAuth } from '../hooks/useAuth';
import { isSuperAdmin } from '../utils/rbac';
import { cn } from '../utils/cn';
import {
    studioBadgeClassName,
    studioDangerButtonClassName,
    studioFieldClassName,
    studioGhostButtonClassName,
    studioModalCardClassName,
    studioModalCloseButtonClassName,
    studioModalOverlayClassName,
    studioPrimaryButtonClassName,
    studioSecondaryButtonClassName,
    studioSurfaceClassName,
    studioTextareaClassName,
} from './studioTheme';
import { StudioEmptyState, StudioErrorNote, StudioErrorState, StudioLoadingState } from './studioFeedback';
import { DANGER_LEVEL_CONFIG, STATUS_CONFIG, type DangerLevel, type WantedStatus } from '../types/fbi';


// 通缉犯接口定义
interface FBIWanted {
    _id: string;
    name: string;
    aliases: string[];
    age: number;
    height: string;
    weight: string;
    eyes: string;
    hair: string;
    race: string;
    nationality: string;
    dateOfBirth: string;
    placeOfBirth: string;
    charges: string[];
    description: string;
    reward: number;
    photoUrl: string;
    fingerprints: string[];
    lastKnownLocation: string;
    dangerLevel: string;
    status: 'ACTIVE' | 'CAPTURED' | 'DECEASED' | 'REMOVED';
    dateAdded: string;
    lastUpdated: string;
    fbiNumber: string;
    ncicNumber: string;
    occupation: string;
    scarsAndMarks: string[];
    languages: string[];
    caution: string;
    remarks: string;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
}

// 统计信息接口
interface Statistics {
    total: number;
    active: number;
    captured: number;
    deceased: number;
    dangerLevels: Record<string, number>;
    recentAdded: Array<{
        name: string;
        fbiNumber: string;
        dateAdded: string;
        dangerLevel: string;
    }>;
}

const FBIWantedManager: React.FC = () => {
    const { setNotification } = useNotification();
    const confirm = useConfirm();
    const { user } = useAuth();
    const canWrite = isSuperAdmin(user?.role);

    // 图片上传限制
    const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
    const ALLOWED_TYPES = [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/bmp'
    ];
    const [wantedList, setWantedList] = useState<FBIWanted[]>([]);
    const [statistics, setStatistics] = useState<Statistics | null>(null);
    const [loading, setLoading] = useState(false);
    const [listError, setListError] = useState('');
    const [statsError, setStatsError] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('ALL');
    const [dangerFilter, setDangerFilter] = useState('ALL');
    const [currentPage, setCurrentPage] = useState(1);
    const [totalPages, setTotalPages] = useState(1);
    const [selectedWanted, setSelectedWanted] = useState<FBIWanted | null>(null);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [showEditModal, setShowEditModal] = useState(false);
    const [showViewModal, setShowViewModal] = useState(false);
    const [pendingPhoto, setPendingPhoto] = useState<string>('');
    const [photoPreview, setPhotoPreview] = useState<string>('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [formData, setFormData] = useState<Partial<FBIWanted>>({});
    const [chargesDraft, setChargesDraft] = useState('');
    const listRequestRef = useRef(0);
    const draftVersionRef = useRef(0);

    // 获取通缉犯列表
    const fetchWantedList = useCallback(async () => {
        const request = ++listRequestRef.current;
        try {
            setLoading(true);
            setListError('');
            const params = new URLSearchParams({
                page: currentPage.toString(),
                limit: '20',
                ...(statusFilter !== 'ALL' && { status: statusFilter }),
                ...(dangerFilter !== 'ALL' && { dangerLevel: dangerFilter }),
                ...(searchTerm && { search: searchTerm })
            });

            const response = await fetch(`${getApiBaseUrl()}/api/fbi-wanted?${params}`, {
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include'
            });

            if (response.ok) {
                const data = await response.json();
                if (request !== listRequestRef.current) return;
                const pages = Math.max(1, Number(data.pagination.pages) || 1);
                setWantedList(data.data);
                setTotalPages(pages);
                setCurrentPage(page => Math.min(page, pages));
            } else if (request === listRequestRef.current) {
                setListError('通缉信息加载失败，请重试。');
            }
        } catch (error) {
            console.error('获取通缉犯列表失败:', error);
            if (request === listRequestRef.current) setListError('通缉信息加载失败，请检查网络后重试。');
        } finally {
            if (request === listRequestRef.current) setLoading(false);
        }
    }, [currentPage, statusFilter, dangerFilter, searchTerm]);

    // 获取统计信息
    const fetchStatistics = useCallback(async () => {
        try {
            setStatsError('');
            const response = await fetch(`${getApiBaseUrl()}/api/fbi-wanted/statistics`, {
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include'
            });

            if (response.ok) {
                const data = await response.json();
                setStatistics(data.data);
            } else {
                setStatsError('统计数据加载失败，请重试。');
            }
        } catch (error) {
            console.error('获取统计信息失败:', error);
            setStatsError('统计数据加载失败，请检查网络后重试。');
        }
    }, []);

    useEffect(() => {
        fetchWantedList();
        fetchStatistics();
    }, [fetchWantedList, fetchStatistics]);

    // 语义 tone 由 types/fbi.ts 提供，这里只负责映射到 studio 徽标 token。
    const dangerLevelBadgeClass = (level: string) =>
        studioBadgeClassName(DANGER_LEVEL_CONFIG[level as DangerLevel]?.tone ?? 'slate');

    const statusBadgeClass = (status: string) =>
        studioBadgeClassName(STATUS_CONFIG[status as WantedStatus]?.tone ?? 'slate');

    // 创建通缉犯
    const handleCreateWanted = async () => {
        if (!canWrite) return;
        try {
            setLoading(true);
            const dataToSubmit = {
                ...formData,
                charges: chargesDraft.split(',').map(charge => charge.trim()).filter(Boolean),
                photoUrl: pendingPhoto || formData.photoUrl || ''
            };

            // DEBUG: log submitted age and related fields
            console.log('[FBIWanted][Create] Submitting payload age:', (dataToSubmit as any).age, 'DOB:', (dataToSubmit as any).dateOfBirth, dataToSubmit);

            const response = await fetch(`${getApiBaseUrl()}/api/fbi-wanted`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include',
                body: JSON.stringify(dataToSubmit)
            });

            if (response.ok) {
                // DEBUG: attempt to read response json to inspect returned age
                try {
                    const created = await response.json();
                    const returnedAge = created?.data?.age ?? created?.age;
                    console.log('[FBIWanted][Create] Response age:', returnedAge, created);
                } catch (e) {
                    console.log('[FBIWanted][Create] No JSON body in create response or parse failed');
                }
                setShowCreateModal(false);
                resetForm();
                fetchWantedList();
                fetchStatistics();
                setNotification({ message: '通缉犯创建成功！', type: 'success' });
            } else {
                const error = await response.json();
                setNotification({ message: `创建失败: ${error.message || '未知错误'}`, type: 'error' });
            }
        } catch (error) {
            console.error('创建通缉犯失败:', error);
            setNotification({ message: '创建失败，请检查网络连接', type: 'error' });
        } finally {
            setLoading(false);
        }
    };

    // 更新通缉犯
    const handleUpdateWanted = async () => {
        if (!canWrite || !selectedWanted) return;

        try {
            setLoading(true);
            // 构建提交数据，确保包含照片更新
            const dataToSubmit = {
                ...formData,
                charges: chargesDraft.split(',').map(charge => charge.trim()).filter(Boolean),
                photoUrl: pendingPhoto || (formData as any).photoUrl || selectedWanted?.photoUrl || ''
            } as any;
            // DEBUG: log updated payload before sending
            console.log('[FBIWanted][Update] Submitting payload:', {
                age: (dataToSubmit as any).age,
                DOB: (dataToSubmit as any).dateOfBirth,
                photoUrl: (dataToSubmit as any).photoUrl
            }, dataToSubmit);
            const response = await fetch(`${getApiBaseUrl()}/api/fbi-wanted/${selectedWanted._id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include',
                body: JSON.stringify(dataToSubmit)
            });

            if (response.ok) {
                // DEBUG: attempt to read response json to inspect returned age after update
                try {
                    const updated = await response.json();
                    const returnedAge = updated?.data?.age ?? updated?.age;
                    console.log('[FBIWanted][Update] Response age:', returnedAge, updated);
                } catch (e) {
                    console.log('[FBIWanted][Update] No JSON body in update response or parse failed');
                }
                setShowEditModal(false);
                resetForm();
                setSelectedWanted(null);
                fetchWantedList();
                fetchStatistics();
                setNotification({ message: '通缉犯信息更新成功！', type: 'success' });
            } else {
                const error = await response.json();
                setNotification({ message: `更新失败: ${error.message || '未知错误'}`, type: 'error' });
            }
        } catch (error) {
            console.error('更新通缉犯失败:', error);
            setNotification({ message: '更新失败，请检查网络连接', type: 'error' });
        } finally {
            setLoading(false);
        }
    };

    // 根据条件批量删除
    const handleBatchDelete = async (filter: object, confirmationMessage: string, confirmAll = false) => {
        if (!canWrite) return;
        const ok = await confirm({
          title: '确认执行该操作？',
          description: confirmationMessage,
          tone: 'danger',
          confirmLabel: '确认',
        });
        if (ok !== true) {
            return;
        }

        try {
            setLoading(true);
            const response = await fetch(`${getApiBaseUrl()}/api/fbi-wanted/multiple`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include',
                body: JSON.stringify({ filter, ...(confirmAll ? { confirmAll: true } : {}) })
            });

            const result = await response.json();

            if (response.ok) {
                setNotification({ message: result.message || '批量删除成功！', type: 'success' });
                fetchWantedList();
                fetchStatistics();
            } else {
                setNotification({ message: result.message || '批量删除失败', type: 'error' });
            }
        } catch (error) {
            console.error('批量删除失败:', error);
            setNotification({ message: '操作失败，请检查网络连接', type: 'error' });
        } finally {
            setLoading(false);
        }
    };

    // 删除通缉犯
    const handleDeleteWanted = async (id: string) => {
        if (!canWrite) return;
        try {
            setLoading(true);
            const response = await fetch(`${getApiBaseUrl()}/api/fbi-wanted/${id}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json'
                },
                credentials: 'include'
            });

            if (response.ok) {
                fetchWantedList();
                fetchStatistics();
                setNotification({ message: '通缉犯记录删除成功！', type: 'success' });
            } else {
                const error = await response.json();
                setNotification({ message: `删除失败: ${error.message || '未知错误'}`, type: 'error' });
            }
        } catch (error) {
            console.error('删除通缉犯失败:', error);
            setNotification({ message: '删除失败，请检查网络连接', type: 'error' });
        } finally {
            setLoading(false);
        }
    };

    // 重置表单
    const resetForm = () => {
        draftVersionRef.current++;
        setChargesDraft('');
        setFormData({
            name: '',
            fbiNumber: '',
            age: 0,
            dangerLevel: 'LOW',
            status: 'ACTIVE',
            reward: 0,
            charges: [],
            description: ''
        });
        setPendingPhoto('');
        setPhotoPreview('');
    };

    // 处理图片上传
    const handleImageUpload = async (e: ChangeEvent<HTMLInputElement>) => {
        if (!canWrite) return;
        const draftVersion = draftVersionRef.current;
        const file = e.target.files?.[0];
        if (!file) return;

        // 验证文件类型
        if (!ALLOWED_TYPES.includes(file.type)) {
            setNotification({ message: '请选择有效的图片格式 (JPEG, PNG, WebP, GIF)', type: 'error' });
            return;
        }

        // 验证文件大小
        if (file.size > MAX_IMAGE_SIZE) {
            setNotification({ message: '图片大小不能超过 5MB', type: 'error' });
            return;
        }

        try {
            setLoading(true);
            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch(`${getApiBaseUrl()}/api/ipfs/upload`, {
                method: 'POST',
                body: formData,
                credentials: 'include'
            });

            const result = await response.json();
            if (draftVersion !== draftVersionRef.current) return;

            if (response.ok && result?.data) {
                const url = result.data.web2url || result.data.url;
                if (url) {
                    setPendingPhoto(url);
                    setPhotoPreview(url);
                    setNotification({ message: '图片上传成功', type: 'success' });
                } else {
                    setNotification({ message: '上传成功但未返回图片URL', type: 'warning' as any });
                }
            } else {
                setNotification({ message: (result && (result.message || result.error)) || '图片上传失败', type: 'error' });
            }
        } catch (error) {
            if (draftVersion !== draftVersionRef.current) return;
            setNotification({ message: '图片上传失败，请检查网络连接', type: 'error' });
        } finally {
            setLoading(false);
        }
    };

    // 图片预览组件
    const ImagePreview = ({ src, alt = '通缉犯照片' }: { src?: string; alt?: string }) => {
        const [error, setError] = useState(false);

        if (!src || error) {
            return (
                <div className="w-full h-48 bg-slate-100 rounded-2xl flex items-center justify-center">
                    <FaUser className="text-4xl text-slate-400" />
                </div>
            );
        }

        return (
            <img
                src={src}
                alt={alt}
                className="w-full h-48 object-cover rounded-2xl"
                onError={() => setError(true)}
            />
        );
    };

    const prefersReducedMotion = useReducedMotion();
    const hoverScale = React.useCallback((scale: number, enabled: boolean = true) => (
        enabled && !prefersReducedMotion ? { scale } : undefined
    ), [prefersReducedMotion]);
    const tapScale = React.useCallback((scale: number, enabled: boolean = true) => (
        enabled && !prefersReducedMotion ? { scale } : undefined
    ), [prefersReducedMotion]);

    return (
        <div className="min-h-screen rounded-2xl bg-slate-50/60 px-4 py-8">
            <div className="max-w-7xl mx-auto px-4 space-y-8">
                {/* 标题和统计信息部分 */}
                <motion.div
                    className={studioSurfaceClassName}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6 }}
                >
                    <div className="bg-slate-900 text-white p-6">
                        <div className="text-center">
                            <motion.div
                                className="flex items-center justify-center gap-3 mb-4"
                                initial={{ scale: 0.9 }}
                                animate={{ scale: 1 }}
                                transition={{ duration: 0.5, delay: 0.2 }}
                            >
                                <FaUserSecret className="text-4xl text-sky-300" />
                                <h1 className="text-4xl font-bold">FBI通缉犯管理系统</h1>
                            </motion.div>
                            <motion.p
                                className="text-slate-300 text-lg"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                transition={{ duration: 0.5, delay: 0.4 }}
                            >
                                权威的FBI通缉犯信息管理平台
                            </motion.p>
                        </div>
                    </div>

                    {/* 统计信息 */}
                    {statistics ? (
                        <div className="p-6">
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                                <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <FaExclamationTriangle className="text-rose-600" />
                                        <h3 className="font-semibold text-rose-700">在逃通缉犯</h3>
                                    </div>
                                    <p className="text-2xl font-bold text-rose-600">{statistics.active}</p>
                                </div>

                                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <FaShieldAlt className="text-emerald-600" />
                                        <h3 className="font-semibold text-emerald-700">已抓获</h3>
                                    </div>
                                    <p className="text-2xl font-bold text-emerald-600">{statistics.captured}</p>
                                </div>

                                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <FaUserSecret className="text-sky-700" />
                                        <h3 className="text-slate-900 font-semibold">总计</h3>
                                    </div>
                                    <p className="text-2xl font-bold text-slate-900">{statistics.total}</p>
                                </div>

                                <div className="rounded-2xl border border-slate-200 bg-slate-100 p-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <FaExclamationTriangle className="text-sky-700" />
                                        <h3 className="text-slate-900 font-semibold">极度危险</h3>
                                    </div>
                                    <p className="text-2xl font-bold text-slate-900">
                                        {statistics.dangerLevels.EXTREME || 0}
                                    </p>
                                </div>
                            </div>
                        </div>
                    ) : statsError ? (
                        <div className="p-6">
                            <StudioErrorNote>{statsError}</StudioErrorNote>
                        </div>
                    ) : null}
                </motion.div>

                {/* 搜索和过滤部分 */}
                <motion.div
                    className={studioSurfaceClassName}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, delay: 0.1 }}
                >
                    <div className="flex flex-col lg:flex-row gap-4 items-center justify-between">
                        <div className="flex flex-col sm:flex-row gap-4 flex-1">
                            <div className="relative flex-1">
                                <FaSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400" />
                                <input
                                    type="text"
                                    placeholder="搜索通缉犯姓名、FBI编号或罪名..."
                                    value={searchTerm}
                                    onChange={(e) => { listRequestRef.current++; setSearchTerm(e.target.value); setCurrentPage(1); }}
                                    className={cn(studioFieldClassName, 'pl-10')}
                                />
                            </div>

                            <select
                                value={statusFilter}
                                onChange={(e) => { listRequestRef.current++; setStatusFilter(e.target.value); setCurrentPage(1); }}
                                className={studioFieldClassName}
                            >
                                <option value="ALL">所有状态</option>
                                <option value="ACTIVE">在逃</option>
                                <option value="CAPTURED">已抓获</option>
                                <option value="DECEASED">已死亡</option>
                                <option value="REMOVED">已移除</option>
                            </select>

                            <select
                                value={dangerFilter}
                                onChange={(e) => { listRequestRef.current++; setDangerFilter(e.target.value); setCurrentPage(1); }}
                                className={studioFieldClassName}
                            >
                                <option value="ALL">所有危险等级</option>
                                <option value="LOW">低危险</option>
                                <option value="MEDIUM">中等危险</option>
                                <option value="HIGH">高危险</option>
                                <option value="EXTREME">极度危险</option>
                            </select>
                        </div>

                        <div className="flex flex-col sm:flex-row gap-4">
                            <motion.button type="button"
                                onClick={() => handleBatchDelete({ status: 'DECEASED' }, '确定要删除所有已死亡的通缉犯记录吗？此操作不可逆！')}
                                disabled={!canWrite}
                                className={studioDangerButtonClassName}
                                whileHover={hoverScale(1.02)}
                                whileTap={tapScale(0.98)}>
                                <FaTrash />
                                <span>删除死亡记录</span>
                            </motion.button>
                            <motion.button type="button"
                                onClick={() => handleBatchDelete({}, '警告：确定要删除所有的通缉犯记录吗？此操作将清空数据库，不可逆！', true)}
                                disabled={!canWrite}
                                className={studioDangerButtonClassName}
                                whileHover={hoverScale(1.02)}
                                whileTap={tapScale(0.98)}>
                                <FaExclamationTriangle />
                                <span>删除所有记录</span>
                            </motion.button>
                            <motion.button type="button"
                                onClick={() => { resetForm(); setShowCreateModal(true); }}
                                disabled={!canWrite}
                                className={studioPrimaryButtonClassName}
                                whileHover={hoverScale(1.02)}
                                whileTap={tapScale(0.98)}>
                                <FaPlus />
                                <span>添加通缉犯</span>
                            </motion.button>
                        </div>
                    </div>
                </motion.div>

                {/* 通缉犯列表 */}
                <motion.div
                    className={studioSurfaceClassName}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.6, delay: 0.2 }}
                >
                    {loading ? (
                        <StudioLoadingState minHeightClassName="min-h-[220px]" />
                    ) : listError ? (
                        <div className="p-6">
                            <StudioErrorState message={listError} onRetry={() => void fetchWantedList()} />
                        </div>
                    ) : wantedList.length === 0 ? (
                        <div className="p-6">
                            <StudioEmptyState
                                message="没有匹配的通缉记录。"
                                action={<button type="button" onClick={() => { setSearchTerm(''); setStatusFilter('ALL'); setDangerFilter('ALL'); setCurrentPage(1); }} className={studioSecondaryButtonClassName}>清除筛选条件</button>}
                            />
                        </div>
                    ) : (
                        <>
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead className="bg-slate-50">
                                        <tr>
                                            <th className="px-6 py-4 text-left text-xs font-medium text-slate-900 uppercase tracking-wider">
                                                通缉犯信息
                                            </th>
                                            <th className="px-6 py-4 text-left text-xs font-medium text-slate-900 uppercase tracking-wider">
                                                危险等级
                                            </th>
                                            <th className="px-6 py-4 text-left text-xs font-medium text-slate-900 uppercase tracking-wider">
                                                状态
                                            </th>
                                            <th className="px-6 py-4 text-left text-xs font-medium text-slate-900 uppercase tracking-wider">
                                                悬赏金额
                                            </th>
                                            <th className="px-6 py-4 text-left text-xs font-medium text-slate-900 uppercase tracking-wider">
                                                操作
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="bg-white/80 divide-y divide-slate-200">
                                        {wantedList.map((wanted) => (
                                            <tr key={wanted._id} className="hover:bg-slate-50">
                                                <td className="px-6 py-4 whitespace-nowrap">
                                                    <div className="flex items-center">
                                                        <div className="flex-shrink-0 h-12 w-12">
                                                            {wanted.photoUrl ? (
                                                                <img
                                                                    className="h-12 w-12 rounded-full object-cover"
                                                                    src={wanted.photoUrl}
                                                                    alt={wanted.name}
                                                                />
                                                            ) : (
                                                                <div className="h-12 w-12 rounded-full bg-slate-100 flex items-center justify-center">
                                                                    <FaUserSecret className="text-slate-500" />
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="ml-4">
                                                            <div className="text-sm font-medium text-slate-900">
                                                                {wanted.name}
                                                            </div>
                                                            <div className="text-sm text-slate-500">
                                                                FBI: {wanted.fbiNumber}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap">
                                                    <span className={dangerLevelBadgeClass(wanted.dangerLevel)}>
                                                        {wanted.dangerLevel}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap">
                                                    <span className={statusBadgeClass(wanted.status)}>
                                                        {wanted.status}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-slate-900">
                                                    ${wanted.reward.toLocaleString()}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium space-x-2">
                                                    <motion.button type="button"
                                                        onClick={() => {
                                                            setSelectedWanted(wanted);
                                                            setShowViewModal(true);
                                                        }}
                                                        className="inline-flex min-h-11 min-w-11 items-center justify-center text-sky-700 transition-colors hover:text-slate-900"
                                                        whileHover={hoverScale(1.1)}
                                                        whileTap={tapScale(0.95)}>
                                                        <FaEye />
                                                    </motion.button>
                                                    <motion.button type="button"
                                                        onClick={() => {
                                                            setSelectedWanted(wanted);
                                                            resetForm();
                                                            setFormData(wanted);
                                                            setChargesDraft(wanted.charges.join(', '));
                                                            setShowEditModal(true);
                                                        }}
                                                        disabled={!canWrite}
                                                        className="inline-flex min-h-11 min-w-11 items-center justify-center text-sky-700 transition-colors hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                                                        whileHover={hoverScale(1.1)}
                                                        whileTap={tapScale(0.95)}>
                                                        <FaEdit />
                                                    </motion.button>
                                                    <motion.button type="button"
                                                        onClick={async () => {
                                                            const ok = await confirm({
                                                                title: '删除这条通缉犯记录？',
                                                                description: '该条记录及其关联图片会被删除，不可恢复。',
                                                                tone: 'danger',
                                                                confirmLabel: '删除',
                                                            });
                                                            if (ok) {
                                                                handleDeleteWanted(wanted._id);
                                                            }
                                                        }}
                                                        disabled={!canWrite}
                                                        className="inline-flex min-h-11 min-w-11 items-center justify-center text-rose-600 transition-colors hover:text-rose-900 disabled:cursor-not-allowed disabled:opacity-50"
                                                        whileHover={hoverScale(1.1)}
                                                        whileTap={tapScale(0.95)}>
                                                        <FaTrash />
                                                    </motion.button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            {/* 分页 */}
                            {totalPages > 1 && (
                                <div className="px-6 py-4 bg-slate-50 border-t border-slate-200">
                                    <div className="flex items-center justify-between">
                                        <div className="text-sm text-slate-600">
                                            第 {currentPage} 页，共 {totalPages} 页
                                        </div>
                                        <div className="flex space-x-2">
                                            <button type="button"
                                                onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                                                disabled={currentPage === 1}
                                                className={studioGhostButtonClassName}>
                                                上一页
                                            </button>
                                            <button type="button"
                                                onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                                                disabled={currentPage === totalPages}
                                                className={studioGhostButtonClassName}>
                                                下一页
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </motion.div>

                {/* 创建通缉犯模态框 — Portal 到 body */}
                {ReactDOM.createPortal(
                <AnimatePresence>
                    {showCreateModal && (
                        <motion.div
                            className={studioModalOverlayClassName}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                        >
                            <motion.div
                                className={cn(studioModalCardClassName, 'w-full max-w-2xl max-h-[90vh] overflow-y-auto')}
                                initial={{ scale: 0.9, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0.9, opacity: 0 }}
                            >
                                <div className="bg-slate-900 text-white p-6 rounded-t-2xl">
                                    <div className="flex items-center justify-between">
                                        <h2 className="text-2xl font-bold">添加通缉犯</h2>
                                        <button type="button"
                                            onClick={() => {
                                                setShowCreateModal(false);
                                                resetForm();
                                            }}
                                            className={studioModalCloseButtonClassName}>
                                            <FaTimes size={24} />
                                        </button>
                                    </div>
                                </div>

                                <div className="p-6 space-y-4">
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">姓名 *</label>
                                            <input
                                                type="text"
                                                value={formData.name || ''}
                                                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                                placeholder="输入通缉犯姓名"
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">年龄</label>
                                            <input
                                                type="number"
                                                value={formData.age || ''}
                                                onChange={(e) => setFormData({ ...formData, age: parseInt(e.target.value) || 0 })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                                placeholder="输入年龄"
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">身高</label>
                                            <input
                                                type="text"
                                                value={formData.height || ''}
                                                onChange={(e) => setFormData({ ...formData, height: e.target.value })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                                placeholder="例如：180cm 或 未知"
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">体重</label>
                                            <input
                                                type="text"
                                                value={formData.weight || ''}
                                                onChange={(e) => setFormData({ ...formData, weight: e.target.value })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                                placeholder="例如：75kg 或 未知"
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">眼睛颜色</label>
                                            <input
                                                type="text"
                                                value={formData.eyes || ''}
                                                onChange={(e) => setFormData({ ...formData, eyes: e.target.value })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                                placeholder="例如：棕色/蓝色/未知"
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">头发颜色</label>
                                            <input
                                                type="text"
                                                value={formData.hair || ''}
                                                onChange={(e) => setFormData({ ...formData, hair: e.target.value })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                                placeholder="例如：黑色/金色/未知"
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">种族</label>
                                            <input
                                                type="text"
                                                value={formData.race || ''}
                                                onChange={(e) => setFormData({ ...formData, race: e.target.value })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                                placeholder="例如：亚洲人/白人/未知"
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">国籍</label>
                                            <input
                                                type="text"
                                                value={formData.nationality || ''}
                                                onChange={(e) => setFormData({ ...formData, nationality: e.target.value })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                                placeholder="例如：中国/美国/未知"
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">危险等级 *</label>
                                            <select
                                                value={formData.dangerLevel || 'LOW'}
                                                onChange={(e) => setFormData({ ...formData, dangerLevel: e.target.value as any })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                            >
                                                <option value="LOW">低危险</option>
                                                <option value="MEDIUM">中等危险</option>
                                                <option value="HIGH">高危险</option>
                                                <option value="EXTREME">极度危险</option>
                                            </select>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">状态</label>
                                            <select
                                                value={formData.status || 'ACTIVE'}
                                                onChange={(e) => setFormData({ ...formData, status: e.target.value as any })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                            >
                                                <option value="ACTIVE">在逃</option>
                                                <option value="CAPTURED">已抓获</option>
                                                <option value="DECEASED">已死亡</option>
                                                <option value="REMOVED">已移除</option>
                                            </select>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">奖金 ($)</label>
                                            <input
                                                type="number"
                                                value={formData.reward || ''}
                                                onChange={(e) => setFormData({ ...formData, reward: parseInt(e.target.value) || 0 })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                                placeholder="输入奖金金额"
                                            />
                                        </div>
                                    </div>

                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 mb-2">罪名</label>
                                        <input
                                            type="text"
                                            value={chargesDraft}
                                            onChange={(e) => setChargesDraft(e.target.value)}
                                            disabled={!canWrite}
                                            className={studioFieldClassName}
                                            placeholder="输入罪名，多个罪名用逗号分隔"
                                        />
                                    </div>

                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 mb-2">描述</label>
                                        <textarea
                                            value={formData.description || ''}
                                            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                            disabled={!canWrite}
                                            rows={3}
                                            className={studioTextareaClassName}
                                            placeholder="输入详细描述"
                                        />
                                    </div>

                                    {/* 图片上传区域 */}
                                    <ImageUploadSection
                                        photoPreview={photoPreview}
                                        pendingPhoto={pendingPhoto}
                                        photoUrl={formData.photoUrl || ''}
                                        loading={loading}
                                        onImageUpload={handleImageUpload}
                                        onUrlChange={(url) => setFormData({ ...formData, photoUrl: url })}
                                        onPreviewChange={(url) => setPhotoPreview(url)}
                                    />
                                </div>

                                <div className="px-6 py-4 bg-slate-50/80 rounded-b-2xl flex justify-end space-x-3">
                                    <button type="button"
                                        onClick={() => {
                                            setShowCreateModal(false);
                                            resetForm();
                                        }}
                                        className={studioGhostButtonClassName}>
                                        取消
                                    </button>
                                    <button type="button"
                                        onClick={handleCreateWanted}
                                        disabled={
                                            !canWrite ||
                                            loading ||
                                            !formData.name ||
                                            !chargesDraft.split(',').some(charge => charge.trim()) ||
                                            !(typeof formData.reward === 'number' && formData.reward >= 0)
                                        }
                                        className={studioPrimaryButtonClassName}>
                                        {loading ? <FaSpinner className="animate-spin" /> : <FaSave />}
                                        {loading ? '创建中...' : '创建'}
                                    </button>
                                </div>
                            </motion.div>
                        </motion.div>
                    )}
                </AnimatePresence>
                , document.body)}

                {/* 编辑通缉犯模态框 — Portal 到 body */}
                {ReactDOM.createPortal(
                <AnimatePresence>
                    {showEditModal && selectedWanted && (
                        <motion.div
                            className={studioModalOverlayClassName}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                        >
                            <motion.div
                                className={cn(studioModalCardClassName, 'w-full max-w-2xl max-h-[90vh] overflow-y-auto')}
                                initial={{ scale: 0.9, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0.9, opacity: 0 }}
                            >
                                <div className="bg-slate-900 text-white p-6 rounded-t-2xl">
                                    <div className="flex items-center justify-between">
                                        <h2 className="text-2xl font-bold">编辑通缉犯</h2>
                                        <button type="button"
                                            onClick={() => {
                                                setShowEditModal(false);
                                                resetForm();
                                                setSelectedWanted(null);
                                                setFormData({});
                                            }}
                                            className={studioModalCloseButtonClassName}>
                                            <FaTimes size={24} />
                                        </button>
                                    </div>
                                </div>

                                <div className="p-6 space-y-4">
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">姓名 *</label>
                                            <input
                                                type="text"
                                                value={formData.name || ''}
                                                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                                placeholder="输入通缉犯姓名"
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">年龄</label>
                                            <input
                                                type="number"
                                                value={formData.age || ''}
                                                onChange={(e) => setFormData({ ...formData, age: parseInt(e.target.value) || 0 })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                                placeholder="输入年龄"
                                            />
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">危险等级 *</label>
                                            <select
                                                value={formData.dangerLevel || 'LOW'}
                                                onChange={(e) => setFormData({ ...formData, dangerLevel: e.target.value as any })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                            >
                                                <option value="LOW">低危险</option>
                                                <option value="MEDIUM">中等危险</option>
                                                <option value="HIGH">高危险</option>
                                                <option value="EXTREME">极度危险</option>
                                            </select>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">状态</label>
                                            <select
                                                value={formData.status || 'ACTIVE'}
                                                onChange={(e) => setFormData({ ...formData, status: e.target.value as any })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                            >
                                                <option value="ACTIVE">在逃</option>
                                                <option value="CAPTURED">已抓获</option>
                                                <option value="DECEASED">已死亡</option>
                                                <option value="REMOVED">已移除</option>
                                            </select>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-2">奖金 ($)</label>
                                            <input
                                                type="number"
                                                value={formData.reward || ''}
                                                onChange={(e) => setFormData({ ...formData, reward: parseInt(e.target.value) || 0 })}
                                                disabled={!canWrite}
                                                className={studioFieldClassName}
                                                placeholder="输入奖金金额"
                                            />
                                        </div>
                                    </div>

                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 mb-2">罪名</label>
                                        <input
                                            type="text"
                                            value={chargesDraft}
                                            onChange={(e) => setChargesDraft(e.target.value)}
                                            disabled={!canWrite}
                                            className={studioFieldClassName}
                                            placeholder="输入罪名，多个罪名用逗号分隔"
                                        />
                                    </div>

                                    <div>
                                        <label className="block text-sm font-medium text-slate-700 mb-2">描述</label>
                                        <textarea
                                            value={formData.description || ''}
                                            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                            disabled={!canWrite}
                                            rows={3}
                                            className={studioTextareaClassName}
                                            placeholder="输入详细描述"
                                        />
                                    </div>
                                </div>

                                <div className="px-6 py-4 bg-slate-50/80 rounded-b-2xl flex justify-end space-x-3">
                                    <button type="button"
                                        onClick={() => {
                                            setShowEditModal(false);
                                            resetForm();
                                            setSelectedWanted(null);
                                            setFormData({});
                                        }}
                                        className={studioGhostButtonClassName}>
                                        取消
                                    </button>
                                    <button type="button"
                                        onClick={handleUpdateWanted}
                                        disabled={!canWrite || loading || !formData.name || !formData.fbiNumber}
                                        className={studioPrimaryButtonClassName}>
                                        {loading ? <FaSpinner className="animate-spin" /> : <FaSave />}
                                        {loading ? '更新中...' : '更新'}
                                    </button>
                                </div>
                            </motion.div>
                        </motion.div>
                    )}
                </AnimatePresence>
                , document.body)}

                {/* 查看通缉犯详情模态框 — Portal 到 body */}
                {ReactDOM.createPortal(
                <AnimatePresence>
                    {showViewModal && selectedWanted && (
                        <motion.div
                            className={studioModalOverlayClassName}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                        >
                            <motion.div
                                className={cn(studioModalCardClassName, 'w-full max-w-2xl max-h-[90vh] overflow-y-auto')}
                                initial={{ scale: 0.9, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0.9, opacity: 0 }}
                            >
                                <div className="bg-slate-900 text-white p-6 rounded-t-2xl">
                                    <div className="flex items-center justify-between">
                                        <h2 className="text-2xl font-bold">通缉犯详情</h2>
                                        <button type="button"
                                            onClick={() => {
                                                setShowViewModal(false);
                                                setSelectedWanted(null);
                                            }}
                                            className={studioModalCloseButtonClassName}>
                                            <FaTimes size={24} />
                                        </button>
                                    </div>
                                </div>

                                <div className="p-6 space-y-4">
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">姓名</label>
                                            <p className="text-lg font-semibold">{selectedWanted?.name}</p>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">FBI编号</label>
                                            <p className="text-lg">{selectedWanted?.fbiNumber}</p>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">年龄</label>
                                            <p className="text-lg">{selectedWanted?.age || '未知'}</p>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">身高</label>
                                            <p className="text-lg">{selectedWanted?.height || '未知'}</p>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">体重</label>
                                            <p className="text-lg">{selectedWanted?.weight || '未知'}</p>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">眼睛颜色</label>
                                            <p className="text-lg">{selectedWanted?.eyes || '未知'}</p>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">头发颜色</label>
                                            <p className="text-lg">{selectedWanted?.hair || '未知'}</p>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">种族</label>
                                            <p className="text-lg">{selectedWanted?.race || '未知'}</p>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">国籍</label>
                                            <p className="text-lg">{selectedWanted?.nationality || '未知'}</p>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">危险等级</label>
                                            <span className={dangerLevelBadgeClass(selectedWanted?.dangerLevel || '')}>
                                                {selectedWanted?.dangerLevel}
                                            </span>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">状态</label>
                                            <span className={statusBadgeClass(selectedWanted?.status || '')}>
                                                {selectedWanted?.status}
                                            </span>
                                        </div>

                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">奖金</label>
                                            <p className="text-lg font-semibold text-emerald-600">${(selectedWanted?.reward || 0).toLocaleString()}</p>
                                        </div>
                                    </div>

                                    {selectedWanted?.charges && selectedWanted.charges.length > 0 && (
                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">罪名</label>
                                            <div className="flex flex-wrap gap-2">
                                                {selectedWanted.charges.map((charge, index) => (
                                                    <span key={index} className={studioBadgeClassName('rose')}>
                                                        {charge}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {selectedWanted?.description && (
                                        <div className="mt-4 pt-4 border-t">
                                            <label className="block text-sm font-medium text-slate-700 mb-1">描述</label>
                                            <p className="text-slate-800 bg-slate-50/80 p-3 rounded-2xl">{selectedWanted.description}</p>
                                        </div>
                                    )}

                                    <div className="mt-4 pt-4 border-t grid grid-cols-1 md:grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">FBI 编号</label>
                                            <p className="rounded-full bg-slate-100 p-2 font-mono text-slate-800">{selectedWanted?.fbiNumber}</p>
                                        </div>
                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">NCIC 编号</label>
                                            <p className="rounded-full bg-slate-100 p-2 font-mono text-slate-800">{selectedWanted?.ncicNumber || 'N/A'}</p>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">身高</label>
                                            <p className="text-slate-800">{selectedWanted?.height || '未知'}</p>
                                        </div>
                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">体重</label>
                                            <p className="text-slate-800">{selectedWanted?.weight || '未知'}</p>
                                        </div>
                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">眼睛颜色</label>
                                            <p className="text-slate-800">{selectedWanted?.eyes || '未知'}</p>
                                        </div>
                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">头发颜色</label>
                                            <p className="text-slate-800">{selectedWanted?.hair || '未知'}</p>
                                        </div>
                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">种族</label>
                                            <p className="text-slate-800">{selectedWanted?.race || '未知'}</p>
                                        </div>
                                        <div>
                                            <label className="block text-sm font-medium text-slate-700 mb-1">国籍</label>
                                            <p className="text-slate-800">{selectedWanted?.nationality || '未知'}</p>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm text-slate-600">
                                        <div>
                                            <label className="block font-medium mb-1">添加时间</label>
                                            <p>{new Date(selectedWanted?.dateAdded || '').toLocaleString()}</p>
                                        </div>

                                        <div>
                                            <label className="block font-medium mb-1">最后更新</label>
                                            <p>{new Date(selectedWanted?.lastUpdated || '').toLocaleString()}</p>
                                        </div>
                                    </div>
                                </div>

                                <div className="px-6 py-4 bg-slate-50/80 rounded-b-2xl flex justify-end">
                                    <button type="button"
                                        onClick={() => {
                                            setShowViewModal(false);
                                            setSelectedWanted(null);
                                        }}
                                        className={studioSecondaryButtonClassName}>
                                        关闭
                                    </button>
                                </div>
                            </motion.div>
                        </motion.div>
                    )}
                </AnimatePresence>
                , document.body)}
            </div>
        </div>
    );
};

export default FBIWantedManager;
