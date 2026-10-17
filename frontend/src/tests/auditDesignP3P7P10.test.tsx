import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P3（认证/验证）、P7（商店/工具）、P10（票据/杂项，排除 ticket/**）收尾闸门。
 *
 * 对应清单：docs/audit/audit-2026-10-16-frontend-design-language.md
 * 这些用例只做**源码静态断言**，与 `scripts/governance/check-frontend-design-language.js`
 * 的规则保持一致，但把范围钉死到本批文件：
 *   - FD-011/012/013/015/026～028/031/049：禁用色、任意颜色值、语义色漂移、非 2xl 圆角
 *   - FD-035：页面外壳复用 studio token（而不是手写同款 Tailwind 串）
 *   - FD-044/050/070：弹窗走 StudioModal（层级压过 MobileNav、Esc/focus trap）
 *   - FD-056～062：四态原语来自 studioFeedback
 *   - FD-063：framer-motion 文件接 reduced-motion（MotionConfig / useReducedMotion）
 *
 * 只读源码，不依赖构建产物，不引入业务 mock。
 */

const source = (...segments: string[]) =>
  fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');

// 本批允许编辑的组件（与审计批次表 P3 + P7 + P10 对齐；P10 排除 ticket 相关文件）。
const BATCH_FILES = [
  // P3 auth/验证
  'LoginPage.tsx',
  'RegisterPage.tsx',
  'ForgotPasswordPage.tsx',
  'ResetPasswordPage.tsx',
  'ResetPasswordLinkPage.tsx',
  'MobileLoginPanel.tsx',
  'EmailVerifyPage.tsx',
  'GoogleAuthButton.tsx',
  'LinuxDoAuthButton.tsx',
  'LinuxDoAuthCallbackPage.tsx',
  'TOTPManager.tsx',
  'TOTPSetup.tsx',
  'TOTPVerification.tsx',
  'PasskeySetup.tsx',
  'PasskeyVerifyModal.tsx',
  'BackupCodesModal.tsx',
  'VerificationMethodSelector.tsx',
  'VerifyCodeInput.tsx',
  'EstablishSecuritySession.tsx',
  'StepUpGate.tsx',
  'FirstVisitVerification.tsx',
  'SmartHumanCheck.tsx',
  'SmartHumanCheckTraces.tsx',
  'SmartHumanCheckTestPage.tsx',
  'TurnstileWidget.tsx',
  'HCaptchaWidget.tsx',
  'CapWidget.tsx',
  'ManagedCaptcha.tsx',
  'CaptchaVerificationPage.tsx',
  'CaptchaVerificationExample.tsx',
  'CloudflareChallengePage.tsx',
  'FeatureConsentGate.tsx',
  'FingerprintManager.tsx',
  'FingerprintRequestModal.tsx',
  // P7 商店/工具
  'ResourceStoreManager.tsx',
  'ResourceStoreDetail.tsx',
  'CDKStoreManager.tsx',
  'CommandManager.tsx',
  'ApiKeyManager.tsx',
  'AntiCounterfeitPage.tsx',
  'ApiDocs.tsx',
  'AgeCalculatorPage.tsx',
  'CaseConverter.tsx',
  'WordCountPageSimple.tsx',
  'CommandManager/ResourceAnalysisPanel.tsx',
  'CommandManager/ResourceTrendChart.tsx',
  // P10 票据/杂项（排除 TicketSystem.tsx 与 components/ticket/**）
  'DataCollectionManager.tsx',
  'EcoEnchantsAdminPage.tsx',
  'EcoEnchantsOpsPanel.tsx',
  'GitHubBillingDashboard.tsx',
  'GitHubBillingCacheManager.tsx',
  'IPBanManager.tsx',
  'LotteryAdmin.tsx',
  'LotteryPage.tsx',
  'BroadcastManager.tsx',
  'BroadcastModal.tsx',
  'BroadcastModalView.tsx',
  'AnnouncementManager.tsx',
  'AnnouncementModal.tsx',
  'OAuthClientManager.tsx',
  'OAuthAuthorizePage.tsx',
  'OAuthOidcEndpointPanel.tsx',
  'ProductDetails.tsx',
  'ProductQueryForm.tsx',
  'PromptModal.tsx',
  'AlertModal.tsx',
  'ConfirmModal.tsx',
  'DebugInfoModal.tsx',
  'ModalPortal.tsx',
  'RegistrationInviteManager.tsx',
  'NexAISecurityDashboard.tsx',
  'SystemManager.tsx',
  'WsConnector.tsx',
  'LegacyApiChoicePage.tsx',
  'CampusEmergencyPage.tsx',
  'PenaltyAppealActions.tsx',
  'PenaltyAppealHost.tsx',
  'ProviderBindPage.tsx',
  'ip-ban/BanListPanel.tsx',
  'confirm/ConfirmDialogProvider.tsx',
] as const;

const RULES: Array<{ id: string; re: RegExp }> = [
  {
    id: 'FD-011/012/013 禁用色族',
    re: /\b(?:bg|text|border|from|to|via|ring|shadow|fill|stroke|divide|placeholder|outline|accent|caret|decoration)-(?:indigo|purple|fuchsia|pink)(?:-\d{2,3})?(?:\/\d+)?\b/,
  },
  {
    id: 'FD-021/026/027/028 任意颜色值',
    re: /\b(?:bg|text|border|from|to|via|ring|shadow|fill|stroke|outline|divide|placeholder|caret|decoration)-\[(?:#|rgb|hsl|oklch|color-mix)[^\]]*\]/,
  },
  {
    id: 'FD-031～034 语义色/中性色漂移',
    re: /\b(?:bg|text|border|from|to|via|ring|divide|placeholder|shadow|outline|fill|stroke)-(?:red|green|yellow|gray|zinc|neutral|stone)-\d{2,3}\b/,
  },
  {
    id: 'FD-049 非 2xl 圆角',
    re: /\brounded-(?:sm|md|lg|xl)\b/,
  },
  {
    id: '高饱和渐变',
    re: /\bbg-gradient-to-[a-z]+\b/,
  },
  {
    id: '第二套品牌色字面量',
    re: /#(?:6366f1|818cf8|4f46e5|8b5cf6|a855f7|007AFF|0A84FF|2563eb|3b82f6|1d4ed8)\b/i,
  },
];

describe('P3/P7/P10 设计语言静态闸门', () => {
  it.each(RULES)('$id：本批文件零命中', ({ re }) => {
    const offenders = BATCH_FILES.filter((file) => re.test(source('components', file)));
    expect(offenders).toEqual([]);
  });

  it('页面外壳复用 studio token 与四态原语', () => {
    const resourceStore = source('components', 'ResourceStoreManager.tsx');
    expect(resourceStore).toContain('studioPageClassName');
    expect(resourceStore).toContain('studioHeroCardClassName');
    expect(resourceStore).toContain('StudioErrorState');

    const apiKey = source('components', 'ApiKeyManager.tsx');
    expect(apiKey).toContain('StudioLoadingState');
    expect(apiKey).toContain('StudioErrorState');
    expect(apiKey).toContain('StudioEmptyState');

    const totpManager = source('components', 'TOTPManager.tsx');
    expect(totpManager).toContain('StudioLoadingState');
    expect(totpManager).toContain('StudioErrorState');

    expect(source('components', 'DataCollectionManager.tsx')).toContain('StudioPager');
    expect(source('components', 'SmartHumanCheck.tsx')).toContain('StudioErrorNote');
  });

  it('弹窗统一走 StudioModal（层级盖过 MobileNav，内置 Esc/focus trap）', () => {
    for (const file of [
      'LotteryPage.tsx',
      'PromptModal.tsx',
      'AlertModal.tsx',
      'ConfirmModal.tsx',
      'DebugInfoModal.tsx',
      'PasskeyVerifyModal.tsx',
      'BackupCodesModal.tsx',
      'FingerprintRequestModal.tsx',
      'PenaltyAppealHost.tsx',
      'PenaltyAppealActions.tsx',
    ]) {
      expect(source('components', file), file).toContain('StudioModal');
    }
  });

  it('P10 数据收集弹窗层级不再低于 MobileNav（z-[10050]）', () => {
    const collection = source('components', 'DataCollectionManager.tsx');
    expect(collection).not.toMatch(/z-\[9999\]/);
    expect(collection).toContain('z-[10050]');

    const ipBan = source('components', 'IPBanManager.tsx');
    expect(ipBan).not.toMatch(/z-\[9999\]/);
    expect(ipBan).toContain('z-[10050]');
  });

  it('framer-motion 页面接 reduced-motion', () => {
    for (const file of [
      'ResourceStoreManager.tsx',
      'ResourceStoreDetail.tsx',
      'CDKStoreManager.tsx',
      'CommandManager.tsx',
      'ApiKeyManager.tsx',
      'AntiCounterfeitPage.tsx',
      'AgeCalculatorPage.tsx',
      'CaseConverter.tsx',
      'WordCountPageSimple.tsx',
      'GitHubBillingDashboard.tsx',
    ]) {
      const fileSource = source('components', file);
      expect(
        fileSource.includes('MotionConfig') || fileSource.includes('useReducedMotion'),
        file,
      ).toBe(true);
    }
  });

  it('大文件按钮显式声明 type（FD-064）', () => {
    for (const file of [
      'ResourceStoreManager.tsx',
      'CDKStoreManager.tsx',
      'CommandManager.tsx',
      'ApiKeyManager.tsx',
      'DataCollectionManager.tsx',
      'LotteryAdmin.tsx',
      'IPBanManager.tsx',
      'GitHubBillingDashboard.tsx',
      'CaseConverter.tsx',
      'TOTPVerification.tsx',
      'VerificationMethodSelector.tsx',
    ]) {
      const fileSource = source('components', file);
      // 只检查单行可直接判定的标签；多行标签由 TypeScript/JSX 解析兜底。
      expect(fileSource, file).not.toMatch(/<button(?![^>\n]*\btype=)[^>\n]*>/);
      expect(fileSource, file).not.toMatch(/<motion\.button(?![^>\n]*\btype=)[^>\n]*>/);
      expect(fileSource, file).not.toMatch(/<m\.button(?![^>\n]*\btype=)[^>\n]*>/);
    }
  });
});
