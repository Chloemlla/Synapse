import React, { useState, useEffect } from 'react';
import {
  FaExclamationTriangle,
  FaRocket,
  FaGlobe,
  FaMapMarkerAlt
} from 'react-icons/fa';
import getApiBaseUrl from '../api';
import { buildInfo } from '../config/buildInfo';

interface IPInfo {
  ip: string;
  country: string;
  region: string;
  city: string;
  isp: string;
}

interface BackendBuildInfo {
  version: string;
  shortSha: string;
}

// PERF-05: 页脚的网络信息与后端版本在同一个会话内不会变。原先两个 effect 每次挂载都直接
// fetch，而页脚在 shell 切换（登录/登出、768px 断点跨侧栏）时会重新挂载，于是重复请求。
// 这里加一层「sessionStorage + TTL」缓存，并用模块级 in-flight 表合并并发挂载的重复请求；
// TTL 与服务端 Cache-Control 对齐（/api/ip 120s、/api/status 30s，客户端取 60s 更保守）。
const IP_CACHE_KEY = 'synapse.footer.ip';
const BUILD_CACHE_KEY = 'synapse.footer.backendBuild';
const IP_CACHE_TTL_MS = 120_000;
const BUILD_CACHE_TTL_MS = 60_000;

const footerInFlight = new Map<string, Promise<unknown>>();

function readFooterCache<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { expiresAt?: unknown; data?: unknown };
    if (typeof parsed?.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) return null;
    return (parsed.data ?? null) as T | null;
  } catch {
    // sessionStorage 不可用（隐私模式 / 配额满）时退化为不缓存
    return null;
  }
}

function writeFooterCache<T>(key: string, data: T, ttlMs: number): void {
  try {
    sessionStorage.setItem(key, JSON.stringify({ expiresAt: Date.now() + ttlMs, data }));
  } catch {
    // 写入失败不影响功能，只是下次挂载会重新请求
  }
}

function dedupedFooterRequest<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = footerInFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = factory().finally(() => {
    footerInFlight.delete(key);
  });
  footerInFlight.set(key, promise);
  return promise;
}

/**
 * PERF-04: 运行时长按秒变化，但计时器原先落在 Footer 本体上，导致整块页脚每秒重渲染。
 * 把计时 + 格式化收进这个叶子组件，重渲染范围缩到一行文本。
 */
const UptimeClock: React.FC = () => {
  const [uptime, setUptime] = useState({ days: 0, hours: 0, minutes: 0, seconds: 0 });

  useEffect(() => {
    const startDate = new Date('2025-06-15T09:30:00');

    const updateUptime = () => {
      const now = new Date();
      const diff = now.getTime() - startDate.getTime();

      if (diff > 0) {
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        setUptime((current) => (
          current.days === days
          && current.hours === hours
          && current.minutes === minutes
          && current.seconds === seconds
            ? current
            : { days, hours, minutes, seconds }
        ));
      }
    };

    updateUptime();
    const interval = setInterval(updateUptime, 1000); // 每秒更新一次

    return () => clearInterval(interval);
  }, []);

  return (
    <span className="font-bold text-emerald-800">
      {uptime.days} 天 {uptime.hours} 小时 {uptime.minutes} 分钟 {uptime.seconds} 秒
    </span>
  );
};

const Footer: React.FC = () => {
  const year = new Date().getFullYear();
  const [ipInfo, setIpInfo] = useState<IPInfo | null>(() => readFooterCache<IPInfo>(IP_CACHE_KEY));
  const [ipLoading, setIpLoading] = useState(() => readFooterCache<IPInfo>(IP_CACHE_KEY) === null);
  // 拉取失败时用自增令牌重跑上面的 effect，给页脚一个原地重试的出路（否则只能整页刷新）。
  const [ipRetryToken, setIpRetryToken] = useState(0);
  // 后端版本/SHA 以「刷新后向后端询问一次」的结果为准；
  // 初值用构建期注入的那份，查询失败时页脚不会出现空值。
  const [backendBuild, setBackendBuild] = useState<BackendBuildInfo>(
    () => readFooterCache<BackendBuildInfo>(BUILD_CACHE_KEY) ?? {
      version: buildInfo.backendVersion,
      shortSha: buildInfo.shortSha
    }
  );

  useEffect(() => {
    const cached = readFooterCache<IPInfo>(IP_CACHE_KEY);
    if (cached) {
      setIpInfo(cached);
      setIpLoading(false);
      return;
    }

    let cancelled = false;

    const fetchIPInfo = async () => {
      try {
        setIpLoading(true);
        const url = `${getApiBaseUrl()}/api/ip`;
        const response = await dedupedFooterRequest('ip', () => fetch(url, {
          headers: { 'Accept': 'application/json' }
        }));

        // 检查响应状态
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // 检查内容类型
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          throw new Error(`预期JSON响应，但收到: ${contentType}`);
        }

        const raw: any = await response.json();

        // 兼容多种字段命名
        const info: IPInfo = {
          ip: raw?.ip || raw?.query || '',
          country: raw?.country || raw?.country_name || raw?.countryName || '',
          region: raw?.region || raw?.province || raw?.state || raw?.regionName || '',
          city: raw?.city || '',
          isp: raw?.isp || raw?.org || raw?.as || raw?.operator || ''
        };

        if (!info.ip) {
          throw new Error('IP信息数据格式无效');
        }

        if (cancelled) return;
        writeFooterCache(IP_CACHE_KEY, info, IP_CACHE_TTL_MS);
        setIpInfo(info);
      } catch (error) {
        if (cancelled) return;
        console.error('获取IP信息失败:', error);
        setIpInfo(null);
      } finally {
        if (!cancelled) setIpLoading(false);
      }
    };

    fetchIPInfo();

    return () => {
      cancelled = true;
    };
  }, [ipRetryToken]);

  useEffect(() => {
    // 每次页面刷新只问一次：/api/status 是后端启动时算好的常量，公开、无鉴权。
    const cached = readFooterCache<BackendBuildInfo>(BUILD_CACHE_KEY);
    if (cached) {
      setBackendBuild(cached);
      return;
    }

    let cancelled = false;

    const fetchBackendBuild = async () => {
      try {
        const url = `${getApiBaseUrl()}/api/status`;
        const response = await dedupedFooterRequest('status', () => fetch(url, {
          headers: { 'Accept': 'application/json' }
        }));

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const raw: any = await response.json();
        const version = typeof raw?.version === 'string' ? raw.version.trim() : '';
        const shortSha = typeof raw?.shortSha === 'string' ? raw.shortSha.trim() : '';

        if (!version && !shortSha) {
          throw new Error('后端版本信息数据格式无效');
        }

        if (cancelled) return;
        const next = {
          version: version || buildInfo.backendVersion,
          shortSha: shortSha || buildInfo.shortSha
        };
        writeFooterCache(BUILD_CACHE_KEY, next, BUILD_CACHE_TTL_MS);
        setBackendBuild(next);
      } catch (error) {
        // 保留构建期注入的后端版本作为兜底，不把页脚打成空白。
        console.warn('获取后端版本信息失败:', error);
      }
    };

    fetchBackendBuild();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <footer className="text-center text-slate-500 mt-8 mb-2 text-sm select-none flex flex-col items-center gap-2">
      <div>
        Copyright ©{year} Synapse. All rights reserved.
      </div>
      {/* 四块信息不再死板地一列堆叠：按可用宽度自动 1 / 2 / 4 列重排（窄屏竖排，宽屏横排）。
          每块都是「拉伸等高 + 内容居中」：内容包一层单一子节点，
          否则 flex 会把行内图标/文本拆成多个子项而打乱排版。 */}
      <div className="grid w-full max-w-5xl grid-cols-1 items-stretch gap-2 px-4 sm:grid-cols-2 sm:px-6 xl:grid-cols-4">
        <div className="flex items-center justify-center rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700 text-xs">
          <div className="text-center">
            <FaExclamationTriangle className="inline mr-1" /> 本站为个人独立开发项目，与 OpenAI 官方无任何隶属或合作关系。请勿将本站内容视为 OpenAI 官方服务。
          </div>
        </div>
        <div className="flex items-center justify-center rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700 text-xs">
          <div className="text-center">
            <FaRocket className="inline mr-1" /> 自 2025年6月15日 9:30 以来，本站已稳定运行{' '}
            <UptimeClock />
          </div>
        </div>
        <div className="flex items-center justify-center rounded border border-slate-200 bg-slate-50 px-2 py-1 text-slate-700 text-xs">
          <div className="text-center">
            <FaGlobe className="inline mr-1" /> 您的网络信息：
            {ipLoading ? (
              <span className="font-mono font-bold text-slate-800">获取中...</span>
            ) : ipInfo ? (
              <div className="mt-1 space-y-0.5">
                <div className="font-mono font-bold text-slate-800">
                  IP: {ipInfo.ip}
                </div>
                <div className="text-slate-600">
                  <FaMapMarkerAlt className="inline mr-1" /> {ipInfo.country} {ipInfo.region} {ipInfo.city}
                </div>
                <div className="text-slate-600">
                  <FaGlobe className="inline mr-1" /> {ipInfo.isp}
                </div>
              </div>
            ) : (
              <span className="inline-flex items-center gap-2">
                <span className="font-mono font-bold text-rose-600">获取失败</span>
                <button
                  type="button"
                  onClick={() => setIpRetryToken((token) => token + 1)}
                  className="rounded border border-rose-200 bg-white px-2 py-0.5 text-[11px] font-semibold text-rose-600 transition hover:bg-rose-50"
                >
                  重试
                </button>
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center justify-center rounded border border-slate-200 bg-slate-100 px-2 py-1 text-slate-600 text-xs font-mono leading-relaxed">
          <div className="text-center">
            <div>前端 v{buildInfo.frontendVersion} ({buildInfo.shortSha})</div>
            <div>后端 v{backendBuild.version} ({backendBuild.shortSha})</div>
          </div>
        </div>
      </div>
    </footer>
  );
};

// PERF-04: Footer 无 props，父级（App shell）重渲染时无需跟着重渲染。
export default React.memo(Footer);
