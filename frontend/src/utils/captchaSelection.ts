import CryptoJS from 'crypto-js';

/**
 * G9-26：注意——这里的"AES 加密"密钥由客户端已知值（fingerprint + 分钟桶）派生，
 * 任何拿到指纹的人都能重算密钥与 hash，因此整套机制是防呆/混淆而非密码学加密。
 * 选择结果本身不含机密信息，防御价值趋近于零。若仅为防重放，应由服务端签发一次性
 * nonce（见 G9-26 跨组依赖，由后端配合落实）；此处保留以与后端 configHandlers 校验对齐。
 */

// CAPTCHA 验证方式枚举
export enum CaptchaType {
  TURNSTILE = 'turnstile',
  HCAPTCHA = 'hcaptcha',
  /** 自托管 Cap（trycap）：无第三方、无追踪的 PoW（hashwx）验证。
   *  注意：Cap 的 instrumentation 只有在 CSP 允许 'unsafe-eval' 时才可能通过
   *  （载荷用 eval 做反篡改探针，被拦后不回消息 → 20s 超时）。本仓生产 CSP 刻意禁 eval，
   *  所以站点密钥必须保持 instrumentation:false，详见 docs/audit/audit-2026-10-01-cap-instrumentation-csp.md。 */
  TRYCAP = 'trycap'
}

// 加密选择结果的接口
export interface EncryptedCaptchaSelection {
  encryptedData: string;
  timestamp: number;
  hash: string;
}

// 解密后的选择结果接口
export interface CaptchaSelection {
  type: CaptchaType;
  timestamp: number;
  fingerprint: string;
  random: number;
}

/**
 * 生成安全的随机CAPTCHA选择
 * @param fingerprint 浏览器指纹
 * @param availableTypes 可用的验证方式
 * @returns 加密的选择结果
 */
export function generateSecureCaptchaSelection(
  fingerprint: string,
  availableTypes: CaptchaType[] = [CaptchaType.TURNSTILE, CaptchaType.HCAPTCHA, CaptchaType.TRYCAP]
): EncryptedCaptchaSelection {
  // 生成时间戳（毫秒）
  const timestamp = Date.now();
  
  // 生成安全随机数
  const randomArray = new Uint32Array(1);
  crypto.getRandomValues(randomArray);
  const random = randomArray[0];
  
  // 基于随机数选择验证方式
  const selectedIndex = random % availableTypes.length;
  const selectedType = availableTypes[selectedIndex];
  
  // 创建选择对象
  const selection: CaptchaSelection = {
    type: selectedType,
    timestamp,
    fingerprint,
    random
  };
  
  // 生成密钥（基于时间戳和指纹）
  const keyMaterial = `${fingerprint}_${Math.floor(timestamp / 60000)}`; // 每分钟更换密钥
  const encryptionKey = CryptoJS.SHA256(keyMaterial).toString();
  
  // 加密选择数据
  const dataToEncrypt = JSON.stringify(selection);
  const encrypted = CryptoJS.AES.encrypt(dataToEncrypt, encryptionKey).toString();
  
  // 生成完整性哈希
  const hashData = `${encrypted}_${timestamp}_${fingerprint}`;
  const hash = CryptoJS.SHA256(hashData).toString();
  
  return {
    encryptedData: encrypted,
    timestamp,
    hash
  };
}

/**
 * 验证加密选择的完整性
 * @param encryptedSelection 加密的选择结果
 * @param fingerprint 浏览器指纹
 * @returns 是否有效
 */
export function validateEncryptedSelection(
  encryptedSelection: EncryptedCaptchaSelection,
  fingerprint: string
): boolean {
  try {
    const { encryptedData, timestamp, hash } = encryptedSelection;
    
    // 检查时间戳有效性（5分钟内）
    const now = Date.now();
    const timeDiff = now - timestamp;
    if (timeDiff < 0 || timeDiff > 5 * 60 * 1000) {
      console.warn('CAPTCHA选择时间戳无效:', { timestamp, now, timeDiff });
      return false;
    }
    
    // 验证完整性哈希
    const expectedHashData = `${encryptedData}_${timestamp}_${fingerprint}`;
    const expectedHash = CryptoJS.SHA256(expectedHashData).toString();
    
    if (hash !== expectedHash) {
      console.warn('CAPTCHA选择哈希验证失败');
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('验证加密选择失败:', error);
    return false;
  }
}

/**
 * 解密CAPTCHA选择（仅用于调试，生产环境应在后端解密）
 * @param encryptedSelection 加密的选择结果
 * @param fingerprint 浏览器指纹
 * @returns 解密的选择结果或null
 */
export function decryptCaptchaSelection(
  encryptedSelection: EncryptedCaptchaSelection,
  fingerprint: string
): CaptchaSelection | null {
  try {
    if (!validateEncryptedSelection(encryptedSelection, fingerprint)) {
      return null;
    }
    
    const { encryptedData, timestamp } = encryptedSelection;
    
    // 生成解密密钥
    const keyMaterial = `${fingerprint}_${Math.floor(timestamp / 60000)}`;
    const decryptionKey = CryptoJS.SHA256(keyMaterial).toString();
    
    // 解密数据
    const decryptedBytes = CryptoJS.AES.decrypt(encryptedData, decryptionKey);
    const decryptedText = decryptedBytes.toString(CryptoJS.enc.Utf8);
    
    if (!decryptedText) {
      console.warn('CAPTCHA选择解密失败');
      return null;
    }
    
    const selection: CaptchaSelection = JSON.parse(decryptedText);
    
    // 验证解密后的数据完整性
    if (selection.timestamp !== timestamp || selection.fingerprint !== fingerprint) {
      console.warn('解密后的CAPTCHA选择数据不一致');
      return null;
    }
    
    return selection;
  } catch (error) {
    console.error('解密CAPTCHA选择失败:', error);
    return null;
  }
}

/**
 * 获取CAPTCHA类型的显示名称
 * @param type CAPTCHA类型
 * @returns 显示名称
 */
export function getCaptchaDisplayName(type: CaptchaType): string {
  switch (type) {
    case CaptchaType.TURNSTILE:
      return 'Cloudflare Turnstile';
    case CaptchaType.HCAPTCHA:
      return 'hCaptcha';
    case CaptchaType.TRYCAP:
      return 'trycap';
    default:
      return '未知验证方式';
  }
}

/**
 * 下发场景：与后端 `CaptchaScenario`（src/services/turnstile/types.ts）一一对应。
 * 场景决定用哪套权重与分配策略 —— 首访门禁与独立验证页可以分配给不同供应商。
 */
export type CaptchaScenario = 'default' | 'first_visit' | 'standalone' | 'step_up';

// 与后端 CAPTCHA_SCENARIOS 同一组（服务端枚举的唯一真相源在
// src/services/turnstile/types.ts）。新增场景时两处必须同时改；
// 漏改的表现是“后端返回 step_up、前端当未知场景丢掉”。
export const CAPTCHA_SCENARIOS: readonly CaptchaScenario[] = ['default', 'first_visit', 'standalone', 'step_up'];

export type CaptchaWidgetTheme = 'auto' | 'light' | 'dark';
export type CaptchaWidgetSize = 'normal' | 'compact' | 'flexible';

/** 管理端在 /admin/captcha-providers 统一调控的控件外观（公开项，经 secure-captcha-config 下发）。 */
export interface CaptchaWidgetAppearance {
  theme: CaptchaWidgetTheme;
  size: CaptchaWidgetSize;
  language: string;
  showProviderLabel: boolean;
}

export const DEFAULT_CAPTCHA_WIDGET_APPEARANCE: CaptchaWidgetAppearance = {
  theme: 'auto',
  size: 'normal',
  language: 'auto',
  showProviderLabel: true,
};

const WIDGET_THEMES: readonly CaptchaWidgetTheme[] = ['auto', 'light', 'dark'];
const WIDGET_SIZES: readonly CaptchaWidgetSize[] = ['normal', 'compact', 'flexible'];
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** 防御性归一化：后端已校验，前端再兜一层，避免坏配置把控件渲染成空白。 */
export function normalizeCaptchaWidgetAppearance(value: unknown): CaptchaWidgetAppearance {
  const source = (value ?? {}) as Record<string, unknown>;
  const theme = WIDGET_THEMES.includes(source.theme as CaptchaWidgetTheme)
    ? (source.theme as CaptchaWidgetTheme)
    : DEFAULT_CAPTCHA_WIDGET_APPEARANCE.theme;
  const size = WIDGET_SIZES.includes(source.size as CaptchaWidgetSize)
    ? (source.size as CaptchaWidgetSize)
    : DEFAULT_CAPTCHA_WIDGET_APPEARANCE.size;
  const language =
    typeof source.language === 'string' && source.language && source.language !== 'auto' && LANGUAGE_PATTERN.test(source.language)
      ? source.language
      : DEFAULT_CAPTCHA_WIDGET_APPEARANCE.language;

  return {
    theme,
    size,
    language,
    showProviderLabel: source.showProviderLabel !== false,
  };
}

/** 深色主题下给 Cap 宿主用的 CSS 变量（Cap 用 --cap-* 变量描述自己的外观）。 */
export function getCapThemeStyle(theme: CaptchaWidgetTheme): Record<string, string> | undefined {
  const prefersDark =
    theme === 'dark' ||
    (theme === 'auto' && typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches));
  if (!prefersDark) return undefined;
  return {
    '--cap-background': '#1e1e2e',
    '--cap-color': '#cdd6f4',
    '--cap-border-color': '#45475a',
    '--cap-invalid-border-color': '#f38ba8',
    '--cap-checkbox-background': '#313244',
    '--cap-checkbox-border-color': '#585b70',
  };
}
