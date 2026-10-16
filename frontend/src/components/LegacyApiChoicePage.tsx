import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowRight, CheckCircle, Monitor, Server } from 'lucide-react';
import { cn } from '../utils/cn';
import {
  studioEyebrowPillClassName,
  studioPageClassName,
  studioPanelClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from './studioTheme';
import { StudioErrorNote } from './studioFeedback';

const CHOICE_QUERY_PARAM = '__legacy_api_choice';
const REMEMBER_QUERY_PARAM = '__legacy_api_remember';
const STATE_QUERY_PARAM = '__legacy_api_state';

// 返回体带 rejected：地址里的一段被安全规则退回时，页面必须把「已回退到默认值」说出来，
// 否则用户看到的是一条貌似正常、实际被改写过的地址。
function normalizeLocalPath(
  rawValue: string | null,
  fallback: string,
  requiredPrefix?: string
): { path: string; rejected: boolean } {
  if (!rawValue) {
    return { path: fallback, rejected: false };
  }

  try {
    const url = new URL(rawValue, window.location.origin);
    if (url.origin !== window.location.origin) {
      return { path: fallback, rejected: true };
    }

    const path = `${url.pathname}${url.search}`;
    if (!path.startsWith('/') || path.startsWith('//')) {
      return { path: fallback, rejected: true };
    }

    if (requiredPrefix && !url.pathname.startsWith(requiredPrefix)) {
      return { path: fallback, rejected: true };
    }

    return { path, rejected: false };
  } catch {
    return { path: fallback, rejected: true };
  }
}

function buildChoiceUrl(
  frontendTarget: string,
  choice: 'frontend' | 'api',
  rememberChoice: boolean,
  state: string
): string {
  const url = new URL(frontendTarget, window.location.origin);
  url.searchParams.set(CHOICE_QUERY_PARAM, choice);
  url.searchParams.set(STATE_QUERY_PARAM, state);

  if (rememberChoice) {
    url.searchParams.set(REMEMBER_QUERY_PARAM, '1');
  } else {
    url.searchParams.delete(REMEMBER_QUERY_PARAM);
  }

  return `${url.pathname}${url.search}`;
}

const LegacyApiChoicePage: React.FC = () => {
  const location = useLocation();
  const [rememberChoice, setRememberChoice] = React.useState(false);

  const params = React.useMemo(() => new URLSearchParams(location.search), [location.search]);
  const frontendTarget = React.useMemo(
    () => normalizeLocalPath(params.get('from'), '/'),
    [params]
  );
  const apiTarget = React.useMemo(
    () => normalizeLocalPath(params.get('api'), '/api', '/api'),
    [params]
  );
  const pathRejected = frontendTarget.rejected || apiTarget.rejected;
  const frontendPath = frontendTarget.path;
  const apiPath = apiTarget.path;
  const state = params.get('state') || '';
  const canChoose = state.length > 0;

  const chooseDestination = React.useCallback(
    (choice: 'frontend' | 'api') => {
      if (!state) {
        return;
      }

      window.location.assign(buildChoiceUrl(frontendPath, choice, rememberChoice, state));
    },
    [frontendPath, rememberChoice, state]
  );

  return (
    <section className={cn(studioPageClassName, 'flex min-h-[58vh] justify-center')}>
      <div className={cn(studioPanelClassName, 'w-full max-w-3xl')}>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className={studioEyebrowPillClassName}>
              <CheckCircle className="h-4 w-4 text-slate-500" aria-hidden="true" />
              路径需要确认
            </div>
            <h1 className="mt-4 text-2xl font-semibold leading-tight text-slate-950 sm:text-3xl">
              这个地址有两个可前往的位置
            </h1>
            <p className="mt-3 text-sm leading-7 text-slate-600">
              请选择打开前端页面，或继续访问已规范化的 API endpoint。选择请求会回到后端校验后执行。
            </p>
          </div>
          <Link
            to="/"
            className={cn(studioSecondaryButtonClassName, "h-10")}
          >
            回到首页
          </Link>
        </div>

        {pathRejected ? (
          <StudioErrorNote className="mt-5">
            地址里有一段无法识别，已回退到默认目标。请从原来的入口重新打开这个链接。
          </StudioErrorNote>
        ) : null}

        <div className="mt-7 grid gap-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Monitor className="h-4 w-4 text-slate-500" aria-hidden="true" />
              前端页面
            </div>
            <code className="mt-3 block break-all rounded-2xl bg-white px-3 py-2 text-sm text-slate-700">
              {frontendPath}
            </code>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Server className="h-4 w-4 text-slate-500" aria-hidden="true" />
              API endpoint
            </div>
            <code className="mt-3 block break-all rounded-2xl bg-white px-3 py-2 text-sm text-slate-700">
              {apiPath}
            </code>
          </div>
        </div>

        <label className="mt-6 flex items-center gap-3 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={rememberChoice}
            onChange={(event) => setRememberChoice(event.target.checked)}
            className="h-4 w-4 rounded border-slate-300 accent-slate-900 focus:ring-slate-300"
          />
          记住本次选择，后续同类地址自动处理
        </label>

        {/* F5-24：两个主操作被禁用时必须说明原因并给出出口 */}
        {!canChoose && (
          <div className="mt-7 rounded-2xl border border-amber-200 bg-amber-50/80 p-4 text-sm text-amber-800">
            <div className="font-semibold">这个地址缺少必要参数，暂时无法继续。</div>
            <div className="mt-1 leading-6">
              请从原来的入口重新打开这个地址（例如邮件、通知或后台里的原始链接）。手动输入、或者转发过程中参数被截断，都会出现这种情况。
            </div>
            <button
              type="button"
              onClick={() => window.history.back()}
              className="mt-3 min-h-11 rounded-2xl border border-amber-300 bg-white/80 px-4 text-xs font-semibold text-amber-900 transition hover:bg-white"
            >
              返回上一页
            </button>
          </div>
        )}

        <div className="mt-7 grid gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => chooseDestination('frontend')}
            disabled={!canChoose}
            className={cn(studioSecondaryButtonClassName, "h-12 bg-white text-slate-800 hover:bg-slate-50")}
          >
            <Monitor className="h-4 w-4" aria-hidden="true" />
            打开前端页面
          </button>
          <button
            type="button"
            onClick={() => chooseDestination('api')}
            disabled={!canChoose}
            className={cn(studioPrimaryButtonClassName, "h-12 px-4")}
          >
            打开 API endpoint
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
};

export default LegacyApiChoicePage;
