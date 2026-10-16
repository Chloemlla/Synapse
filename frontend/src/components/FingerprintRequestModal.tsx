import React, { useState, useEffect, useCallback } from 'react';
import { FaFingerprint, FaCheck } from 'react-icons/fa';
import { useNotification } from './Notification';
import { StudioErrorNote, StudioModal, StudioModalHeader, StudioSuccessNote } from './studioFeedback';
import { studioPrimaryButtonClassName, studioSecondaryButtonClassName } from './studioTheme';
import { reportFingerprintOnce } from '../utils/fingerprint';

interface FingerprintRequestModalProps {
    isOpen: boolean;
    onClose: (isDismissed?: boolean) => void;
    onRequestComplete?: () => void;
    hasDismissedOnce?: boolean; // 用户是否已经关闭过一次（一生只能关闭一次）
    onDismissOnce?: () => Promise<boolean>; // 记录用户关闭操作的回调
}

const FingerprintRequestModal: React.FC<FingerprintRequestModalProps> = ({
    isOpen,
    onClose,
    onRequestComplete,
    hasDismissedOnce = false,
    onDismissOnce
}) => {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isSubmitted, setIsSubmitted] = useState(false);
    const [error, setError] = useState('');
    // 父组件只在自身重渲染时才会重新计算 isOpen，本地收起保证退出入口立刻生效
    const [collapsedLocally, setCollapsedLocally] = useState(false);
    const { setNotification } = useNotification();

    // 重置状态当弹窗打开时
    useEffect(() => {
        if (isOpen) {
            setIsSubmitted(false);
            setError('');
            setIsSubmitting(false);
        } else {
            setCollapsedLocally(false);
        }
    }, [isOpen]);

    const handleSubmit = async () => {
        if (isSubmitting || isSubmitted) return;

        setIsSubmitting(true);
        setError('');

        try {
            // 用户主动点击上报按钮，强制立即上报（绕过5分钟节流限制）
            await reportFingerprintOnce(true);

            setIsSubmitted(true);
            setNotification({ type: 'success', message: '指纹上报成功，感谢您的配合！' });

            // 通知父组件请求完成
            if (onRequestComplete) {
                onRequestComplete();
            }

            // 2秒后自动关闭（成功提交后不需要 dismissal tracking）
            setTimeout(() => {
                onClose(false);
            }, 2000);

        } catch (err) {
            // console 仅作诊断：用户可见的失败态由 error + notification 承担。
            console.error('指纹上报失败:', err);
            setError('指纹上报失败，请稍后重试');
            setNotification({ type: 'error', message: '指纹上报失败，请稍后重试' });
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDismiss = async () => {
        if (isSubmitting) return;

        // 如果用户已经关闭过一次，不允许再次关闭
        if (hasDismissedOnce) {
            setNotification({
                type: 'error',
                message: '您已经关闭过一次指纹请求，必须立即上报才能继续使用'
            });
            return;
        }

        // 调用后端 API 记录关闭操作
        if (onDismissOnce) {
            setIsSubmitting(true);
            const success = await onDismissOnce();
            setIsSubmitting(false);

            if (success) {
                setNotification({
                    type: 'warning',
                    message: '已记录您的关闭操作，这是您唯一一次关闭机会，下次必须上报'
                });
                setTimeout(() => {
                    onClose(true);
                }, 100);
            } else {
                setNotification({
                    type: 'error',
                    message: '记录关闭操作失败，请稍后重试'
                });
            }
        } else {
            // 降级处理：如果没有提供回调，使用原有逻辑
            setNotification({ type: 'warning', message: '您暂时跳过了指纹上报，管理员可能再次请求' });
            setTimeout(() => {
                onClose(true);
            }, 100);
        }
    };

    // 统一的退出入口（关闭按钮 / 遮罩点击 / Esc 都走这里，Esc 与焦点陷阱由 StudioModal 提供）。
    // 未关闭过的用户沿用原行为：不写冷却，父组件会再次请求（此时仍有「暂时跳过」这条出路）。
    // 已关闭过一次的用户若不给写冷却的出路就会被永久困住（B01），因此仅对这类用户收起并写冷却；
    // 后端「一生只能关闭一次」的计数语义不变——只有「暂时跳过」会消耗那唯一一次。
    const handleClose = useCallback(() => {
        if (isSubmitting) return;

        if (hasDismissedOnce) {
            // 父组件要等下一次重渲染才会重算 isOpen，这里先本地收起，保证出路立刻生效
            setCollapsedLocally(true);
            setNotification({
                type: 'info',
                message: '已暂时收起指纹请求，稍后会再次提醒您完成上报'
            });
        }

        // 延迟执行让动画完成
        setTimeout(() => {
            onClose(hasDismissedOnce);
        }, 100);
    }, [hasDismissedOnce, isSubmitting, onClose, setNotification]);

    return (
        <StudioModal
            open={isOpen && !collapsedLocally}
            onClose={handleClose}
            labelledBy="fingerprint-request-title"
            maxWidthClassName="max-w-md"
        >
            {isSubmitted ? (
                <StudioSuccessNote className="px-5 py-8 text-center">
                    <FaCheck className="mx-auto mb-3 h-8 w-8" />
                    <div className="text-base font-semibold">指纹上报成功</div>
                    <div className="mt-2 text-sm">您的浏览器指纹已成功上报，感谢您的配合！</div>
                </StudioSuccessNote>
            ) : (
                <>
                    <StudioModalHeader
                        title="指纹上报请求"
                        titleId="fingerprint-request-title"
                        description={hasDismissedOnce
                            ? '您已经关闭过一次指纹请求，这是最后的机会。请立即上报以继续使用；如需稍后处理，可以收起此窗口，我们会再次提醒。'
                            : '管理员请求上报您的浏览器指纹，用于安全验证和用户识别。此过程不会收集任何个人信息。'}
                        icon={<FaFingerprint className="h-6 w-6" />}
                        iconClassName="bg-slate-100 text-slate-600"
                        onClose={handleClose}
                        closeLabel="收起指纹上报请求"
                    />

                    {error ? <StudioErrorNote className="mt-4">{error}</StudioErrorNote> : null}

                    <div className="mt-5 flex gap-3">
                        {!hasDismissedOnce && (
                            <button
                                type="button"
                                onClick={handleDismiss}
                                disabled={isSubmitting}
                                className={`${studioSecondaryButtonClassName} flex-1`}
                            >
                                暂时跳过
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={handleSubmit}
                            disabled={isSubmitting}
                            aria-busy={isSubmitting}
                            className={`${studioPrimaryButtonClassName} ${hasDismissedOnce ? 'w-full' : 'flex-1'}`}
                        >
                            {isSubmitting ? '上报中...' : <><FaFingerprint className="h-4 w-4" aria-hidden />立即上报</>}
                        </button>
                    </div>
                </>
            )}

            {isSubmitted ? (
                <button
                    type="button"
                    onClick={() => {
                        // 确保状态已更新，shouldShowRequest 会变为 false，弹窗自动关闭
                        if (onRequestComplete) {
                            onRequestComplete();
                        }
                    }}
                    className={`${studioPrimaryButtonClassName} mt-4 w-full`}
                >
                    <FaCheck className="h-4 w-4" aria-hidden />
                    关闭窗口
                </button>
            ) : null}

            <div className="mt-4 border-t border-slate-200 pt-4">
                <div className="space-y-1 text-xs text-slate-500">
                    <p>• 指纹信息包含：浏览器类型、屏幕分辨率、时区等设备特征</p>
                    <p>• 此信息仅用于安全验证，不会识别您的个人身份</p>
                    <p>• 如需稍后处理，可以收起此窗口，管理员可能会再次请求</p>
                </div>
            </div>
        </StudioModal>
    );
};

export default FingerprintRequestModal;
