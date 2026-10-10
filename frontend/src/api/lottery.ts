import { 
  BlockchainData, 
  LotteryRound, 
  LotteryWinner, 
  UserLotteryRecord, 
  LotteryStatistics,
  LotteryApiResponse 
} from '../types/lottery';
import getApiBaseUrl, { getApiBaseUrl as namedGetApiBaseUrl } from '../api';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';


// 修正API_BASE，确保所有请求都指向 /api/lottery
const API_BASE = getApiBaseUrl() + '/api/lottery';

// 通用API请求函数（返回完整信封，供需要 warning 等附加字段的调用方使用）
async function apiRequestEnvelope<T>(endpoint: string, options?: RequestInit): Promise<LotteryApiResponse<T>> {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options?.headers,
  };

  // 修正：如果 endpoint 不是以 / 开头，自动补/
  const url = endpoint.startsWith('/') ? `${API_BASE}${endpoint}` : `${API_BASE}/${endpoint}`;

  // 调试日志
  if (typeof window !== 'undefined') {
    console.log('[lottery-api] fetch', url, options);
  }

  const response = await fetchWithTimeout(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  // 新增：检查响应类型，防止解析 HTML
  const contentType = response.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    throw new Error('后端未返回 JSON，可能是 404、未部署 lottery API 或服务器错误');
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }

  const data: LotteryApiResponse<T> = await response.json();
  if (!data.success) {
    throw new Error(data.error || '请求失败');
  }

  return data;
}

// 通用API请求函数
async function apiRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const envelope = await apiRequestEnvelope<T>(endpoint, options);
  return envelope.data as T;
}

// 获取区块链数据
export async function getBlockchainData(): Promise<BlockchainData> {
  return apiRequest<BlockchainData>('/blockchain');
}

// 获取所有抽奖轮次
export async function getLotteryRounds(): Promise<LotteryRound[]> {
  return apiRequest<LotteryRound[]>('/rounds');
}

// 获取活跃的抽奖轮次
export async function getActiveRounds(): Promise<LotteryRound[]> {
  return apiRequest<LotteryRound[]>('/rounds/active');
}

// 获取轮次详情
export async function getRoundDetails(roundId: string): Promise<LotteryRound> {
  return apiRequest<LotteryRound>(`/rounds/${roundId}`);
}

// 参与抽奖：未中奖时后端返回 data=null（概率和 < 1 的剩余区间）。
// requestId 为幂等键（PRD §4）：同一 id 的重放直接返回上次结果，不再抽一次。
export async function participateInLottery(
  roundId: string,
  cfToken?: string,
  captchaProvider?: string,
  requestId?: string,
): Promise<LotteryWinner | null> {
  const body: any = {};

  if (cfToken) {
    // cfToken 为历史字段名；captchaProvider 告诉后端这次是哪个供应商签发的。
    body.cfToken = cfToken;
    body.captchaToken = cfToken;
    if (captchaProvider) body.captchaProvider = captchaProvider;
  }
  if (requestId) body.requestId = requestId;

  return apiRequest<LotteryWinner | null>(`/rounds/${roundId}/participate`, {
    method: 'POST',
    body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
  });
}

// 获取用户抽奖记录
export async function getUserRecord(): Promise<UserLotteryRecord | null> {
  return apiRequest<UserLotteryRecord | null>('/user/record');
}

// 获取排行榜
export async function getLeaderboard(limit: number = 10): Promise<UserLotteryRecord[]> {
  return apiRequest<UserLotteryRecord[]>(`/leaderboard?limit=${limit}`);
}

// 获取统计信息
export async function getStatistics(): Promise<LotteryStatistics> {
  return apiRequest<LotteryStatistics>('/statistics');
}

// 创建抽奖轮次（管理员）。返回后端的自动修正说明（warning）供界面提示。
export async function createLotteryRound(roundData: {
  name: string;
  description: string;
  startTime: string;
  endTime: string;
  prizes: any[];
}): Promise<{ round: LotteryRound; warning?: string }> {
  const envelope = await apiRequestEnvelope<LotteryRound>('/rounds', {
    method: 'POST',
    body: JSON.stringify(roundData),
  });
  return {
    round: envelope.data as LotteryRound,
    ...(typeof envelope.warning === 'string' && envelope.warning ? { warning: envelope.warning } : {}),
  };
}

// 更新轮次状态（管理员）
export async function updateRoundStatus(roundId: string, isActive: boolean): Promise<void> {
  return apiRequest<void>(`/rounds/${roundId}/status`, {
    method: 'PUT',
    body: JSON.stringify({ isActive }),
  });
}

// 重置轮次（管理员）
export async function resetRound(roundId: string): Promise<void> {
  return apiRequest<void>(`/rounds/${roundId}/reset`, {
    method: 'POST',
  });
}

// 删除所有抽奖轮次（管理员）
export async function deleteAllRounds(): Promise<void> {
  return apiRequest<void>('/rounds', {
    method: 'DELETE',
  });
}