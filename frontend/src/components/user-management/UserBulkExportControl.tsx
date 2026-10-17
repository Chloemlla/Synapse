import React, { useCallback, useState } from 'react';
import { FaDownload, FaSyncAlt } from 'react-icons/fa';
import EstablishSecuritySession from '../EstablishSecuritySession';
import { useSecuritySession } from '../../hooks/useSecuritySession';
import {
  downloadAccountsData,
  extractAccountDataErrorMessage,
  extractAccountDataErrorCode,
} from '../../api/adminUserData';
import { studioSecondaryButtonClassName } from '../studioTheme';

/**
 * 批量导出所选账号的账户数据（用户管理页）。
 *
 * 从 UserManagement.tsx 抽出来的原因：那个文件贴着 1500 行体积闸门，而批量导出是一块
 * 自带状态（安全会话、忙碌、验证卡）的独立交互，留在页面里只会继续推高行数。
 *
 * 行为：
 * - 最多 10 个账号（与后端 ACCOUNT_EXPORT_MAX_USERS 同口径）；
 * - 需要安全会话：未建立时就地展示验证卡，验证成功后自动继续；
 * - 后端返回 SECURITY_SESSION_REQUIRED 时同样回到验证卡（会话可能在点击前过期）。
 */

type NotifyPayload = { type: 'success' | 'error' | 'warning'; message: string };

interface UserBulkExportControlProps {
  selectedUserIds: string[];
  notify: (payload: NotifyPayload) => void;
}

const MAX_BULK_EXPORT_USERS = 10;

const UserBulkExportControl: React.FC<UserBulkExportControlProps> = ({ selectedUserIds, notify }) => {
  const security = useSecuritySession();
  const [busy, setBusy] = useState(false);
  const [showVerify, setShowVerify] = useState(false);

  const runExport = useCallback(async () => {
    if (selectedUserIds.length === 0 || busy) return;
    setBusy(true);
    try {
      const result = await downloadAccountsData(selectedUserIds);
      const sizeMb = Math.max(0.1, Math.round((result.blob.size / 1024 / 1024) * 10) / 10);
      notify({ type: 'success', message: `已导出 ${selectedUserIds.length} 个账号（${sizeMb} MB）` });
    } catch (error: unknown) {
      const code = await extractAccountDataErrorCode(error);
      if (code === 'SECURITY_SESSION_REQUIRED' || code === 'SECURITY_SESSION_BINDING_CHANGED') {
        setShowVerify(true);
        notify({ type: 'warning', message: '请先完成一次身份验证再导出' });
      } else {
        notify({ type: 'error', message: await extractAccountDataErrorMessage(error, '批量导出失败') });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, notify, selectedUserIds]);

  const handleClick = useCallback(() => {
    if (selectedUserIds.length === 0) {
      notify({ type: 'warning', message: '请先选择用户' });
      return;
    }
    if (selectedUserIds.length > MAX_BULK_EXPORT_USERS) {
      notify({ type: 'error', message: `单次最多导出 ${MAX_BULK_EXPORT_USERS} 个账号，请减少选择` });
      return;
    }
    if (!security.isActive) {
      setShowVerify(true);
      return;
    }
    void runExport();
  }, [notify, runExport, security.isActive, selectedUserIds.length]);

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={handleClick}
        disabled={selectedUserIds.length === 0 || busy}
        className={studioSecondaryButtonClassName}
        title={`导出所选账号的数据（最多 ${MAX_BULK_EXPORT_USERS} 个；需要完成一次身份验证）`}
      >
        {busy ? <FaSyncAlt className="animate-spin" aria-hidden /> : <FaDownload aria-hidden />}
        导出所选数据
      </button>

      {showVerify ? (
        <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50/70 p-3">
          <p className="mb-2 text-[11px] font-semibold text-amber-800">
            导出含账号个人信息，需要先完成一次身份验证（密码 / TOTP / Passkey）。
          </p>
          <EstablishSecuritySession
            showActiveBar={false}
            onEstablished={() => {
              setShowVerify(false);
              void runExport();
            }}
          />
          <button
            type="button"
            onClick={() => setShowVerify(false)}
            className="mt-2 text-[11px] font-semibold text-amber-800 underline decoration-amber-300 underline-offset-2 hover:text-amber-900"
          >
            取消
          </button>
        </div>
      ) : null}
    </div>
  );
};

export default UserBulkExportControl;
