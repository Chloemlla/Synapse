export interface WebhookEventItem {
  _id: string;
  provider?: string;
  routeKey?: string | null;
  eventId?: string;
  type: string;
  title?: string;
  content?: string;
  renderedContent?: string;
  created_at?: string;
  to?: unknown;
  subject?: string;
  status?: string;
  data?: unknown;
  raw?: unknown;
  receivedAt?: string;
  updatedAt?: string;
}

export interface WebhookStats {
  total: number;
  last24h: number;
  failed: number;
  byStatus: CountRow[];
  byProvider: CountRow[];
  byRouteKey: CountRow[];
  byType: CountRow[];
}

export interface CountRow {
  key: string | null;
  total: number;
}

export interface GroupRow extends CountRow {
  routeKey?: string | null;
}

export interface WebhookSecretSetting {
  key: string;
  secret: string | null;
  updatedAt: string | null;
}

export type ActivePanel = 'usage' | 'test' | 'secrets';
export type EditMode = 'create' | 'edit';

export const STATUS_OPTIONS = [
  'received',
  'testing',
  'processed',
  'replayed',
  'ignored',
  'failed',
  'delivered',
  'bounced',
  'complained',
];

// F4-22：下拉与表格里渲染中文名，原始枚举值仍作为 option 的 value 提交给后端。
export const STATUS_LABELS: Record<string, string> = {
  received: '已接收',
  testing: '测试中',
  processed: '已处理',
  replayed: '已重放',
  ignored: '已忽略',
  failed: '失败',
  delivered: '已投递',
  bounced: '邮件退回',
  complained: '投诉',
};

export const statusLabel = (status?: string | null) => (status ? STATUS_LABELS[status] || status : '');

export const defaultStats: WebhookStats = {
  total: 0,
  last24h: 0,
  failed: 0,
  byStatus: [],
  byProvider: [],
  byRouteKey: [],
  byType: [],
};

export const samplePayload = {
  type: 'demo.notification',
  title: 'Webhook 测试',
  content: '来自 {{value}} 的事件，状态：{{value}}',
  values: ['Synapse', 'OK'],
  status: 'received',
  timestamp: Date.now(),
  data: {
    source: 'admin-console',
  },
};
