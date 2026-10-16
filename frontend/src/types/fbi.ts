/**
 * FBI通缉犯相关类型定义
 * 统一管理所有FBI功能的TypeScript接口
 */

/**
 * FBI通缉犯完整信息
 */
export interface FBIWanted {
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
  dangerLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
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

/**
 * FBI统计信息
 */
export interface FBIStatistics {
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

/**
 * API响应格式（通用）
 */
export interface FBIApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

/**
 * 分页查询参数
 */
export interface FBIPaginationParams {
  page?: number;
  limit?: number;
  status?: string;
  dangerLevel?: string;
  search?: string;
}

/**
 * 创建/更新通缉犯的数据（部分字段）
 */
export type FBIWantedInput = Partial<Omit<FBIWanted, '_id' | 'createdAt' | 'updatedAt' | 'fbiNumber' | 'ncicNumber'>>;

/**
 * 危险等级选项
 */
export const DANGER_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'] as const;
export type DangerLevel = typeof DANGER_LEVELS[number];

/**
 * 状态选项
 */
export const STATUS_OPTIONS = ['ACTIVE', 'CAPTURED', 'DECEASED', 'REMOVED'] as const;
export type WantedStatus = typeof STATUS_OPTIONS[number];

/**
 * 徽标语义 tone。取值与 studioTheme 的 studioBadgeClassName 保持一致，
 * 消费组件直接 `studioBadgeClassName(tone)` 取色——类型层不再携带 Tailwind 类串，
 * 否则改一次配色就要回头改数据模型（FD-019）。
 */
export type FBIStatusTone = 'green' | 'yellow' | 'slate' | 'rose';

/**
 * 危险等级显示配置
 */
export const DANGER_LEVEL_CONFIG: Record<DangerLevel, { label: string; tone: FBIStatusTone }> = {
  LOW: {
    label: '低危',
    tone: 'green'
  },
  MEDIUM: {
    label: '中危',
    tone: 'yellow'
  },
  HIGH: {
    label: '高危',
    tone: 'rose'
  },
  EXTREME: {
    label: '极危',
    tone: 'rose'
  }
};

/**
 * 状态显示配置
 */
export const STATUS_CONFIG: Record<WantedStatus, { label: string; tone: FBIStatusTone }> = {
  ACTIVE: {
    label: '在逃',
    tone: 'rose'
  },
  CAPTURED: {
    label: '已抓获',
    tone: 'green'
  },
  DECEASED: {
    label: '已死亡',
    tone: 'slate'
  },
  REMOVED: {
    label: '已移除',
    tone: 'slate'
  }
};
