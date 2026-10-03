# deploy/openresty

1Panel 托管的 OpenResty（`openresty` 容器，host 网络）接入层资源。这一层不在本仓库构建，
CI 不覆盖它，改动只能靠「改完在服务器上 `nginx -t` + 真实 5xx 验证」，所以把源文件放进仓库，
避免只存在于服务器上、没人知道上一版长什么样。

## 维护兜底页

| 文件 | 作用 |
| --- | --- |
| `maintenance.html` | 维护页本体（自包含单文件，无外部请求） |
| `maintenance.conf` | 站点 server 块 include 的片段：`error_page 502 503 504` + `@chloemlla_maintenance` 命名 location |

服务器落点：

```
/opt/1panel/www/maintenance/maintenance.html            # 页面（容器内 = /www/maintenance/maintenance.html）
/opt/1panel/www/maintenance/maintenance.conf            # 下载暂存，仅供同步用
/opt/1panel/www/sites/<site>/proxy/maintenance.conf     # 各站点各一份「实文件」拷贝
```

> `/opt/1panel/www` 是 openresty 容器的 `/www` bind mount；`root /www/maintenance` 指的就是页面所在目录。
> 页面不在任何站点 root 下，加上 `internal`，所以只能由 5xx 兜底路径吐出来，不能被直接访问。
>
> 站点里的 `maintenance.conf` 必须是**实文件拷贝，不要用软链**：软链的 target 是宿主路径
> （`/opt/1panel/...`），而同一条软链在容器里解析时看到的文件系统只有 `/www`，`nginx -t` 会直接
> `open() ... failed (2: No such file or directory)`。改完记得逐个 cp 同步（见下）。

### 做了什么

- **兜 5xx**：站点 `proxy_pass` 的上游返回 502/503/504（发布重启期间就是这种）时，由接入层返回维护页；
  `error_page 502 503 504 =503 @chloemlla_maintenance` 放在 server 级，一个站点只需要一个新文件，不用改 1Panel 生成的 `root.conf`。
  用 `=503` 而不是原样透传 502：维护语义是「暂时不可用」，且前置 CDN 会透传带正文的 503，而不是换成它自己的 502 错误页。
- **自动恢复**：页面 JS 轮询同源 `/api/health`（任意站点通用：**非 5xx 即视为上游已应答**，即使该路径 404），
  通了才 `location.reload()`；间隔按 3s→5s→…→60s 退避，避免服务刚起来时被刷新风暴打穿。
- **不玩死循环**：`sessionStorage` 记录 3 分钟内自动跳转次数，超过 3 次就直接停掉自动刷新转手动
  （防「健康检查通过但目标路由仍然坏」的场景）。
- **支持出口**：维护期间工单页本身也打不开，所以页面正文直接给 `support@chloemlla.com`，
  「邮件联系支持」按钮会预填网址、时间与诊断信息。
- **可诊断**：折叠区给状态码/时间/UA 的「复制诊断信息」，`X-Maintenance-Page` 头用于确认线上版本。
- **可访问性**：`role="status" aria-live="polite" aria-busy`、2px focus ring、44px 触摸目标、
  `prefers-reduced-motion` 关动效、`<noscript>` 里保留 15s meta refresh 兜底。

### 与设计语言的关系

按 `docs/design/app-ui-design-language.md` 的「加载状态蓝图」做：浅灰蓝径向高光背景、
白色玻璃态卡片 `rounded-[36px]`、indigo-600 唯一主操作色、Slate 文本层级、44px 触摸目标、reduced motion。
有意的偏离（都在文件头注释里标了）：

- eyebrow 文案用 `slate-500` 而不是 `slate-400`：11px 小字用 `slate-400` 在浅背景上只有约 2.6:1，过不了 WCAG AA。
- 页面保留 `prefers-color-scheme: dark` 一套 token（主应用是纯浅色）：错误页会出现在用户的任意系统主题下，
  深色主题下给白底玻璃卡会闪眼。
- 用 JS 轮询替代 `meta refresh`（后者会盲刷、无倒计时、无法区分「上游已恢复」）。

## 部署 / 回滚

```bash
# 更新接入层片段（改完必须重新 reload）
curl -fsSL "https://raw.githubusercontent.com/Chloemlla/Synapse/$(git rev-parse origin/main)/deploy/openresty/maintenance.conf" \
  -o /opt/1panel/www/maintenance/maintenance.conf
for f in /opt/1panel/www/sites/*/proxy/maintenance.conf; do cp /opt/1panel/www/maintenance/maintenance.conf "$f"; done
docker exec openresty nginx -t && docker exec openresty nginx -s reload

# 更新页面（静态文件，不需要 reload）
curl -fsSL "https://raw.githubusercontent.com/Chloemlla/Synapse/$(git rev-parse origin/main)/deploy/openresty/maintenance.html" \
  -o /opt/1panel/www/maintenance/maintenance.html
md5sum /opt/1panel/www/maintenance/maintenance.html   # 与仓库内文件比对

# 新增站点：拷片段（server 级 include，无需改 root.conf）
cp /opt/1panel/www/maintenance/maintenance.conf /opt/1panel/www/sites/<新站点>/proxy/maintenance.conf
```

回滚：删掉站点的 `proxy/maintenance.conf` → `nginx -t` → reload（页面文件留着不影响，只是没人引用）。

## 验证（别只看配置，要看真实 5xx）

```bash
# 1) 找一个上游真的挂着的站点：必须返回维护页（大小/正文与仓库文件一致）+ 这些头
curl -sk -o /tmp/m.html -D - --resolve <host>:443:127.0.0.1 https://<host>/ | grep -i 'retry-after\|x-maintenance-page\|x-robots-tag'
# expect: HTTP/2 503 / retry-after: 15 / x-maintenance-page: v3 / x-robots-tag: noindex, nofollow / charset=utf-8
md5sum /tmp/m.html    # 等于仓库里的 deploy/openresty/maintenance.html

# 2) 没挂的站点不能回归：仍是上游自己的 200，且 http 仍 301 跳 https
curl -sk -o /dev/null -w '%{http_code}\n' --resolve <host>:443:127.0.0.1 https://<host>/
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H 'Host: <host>' http://127.0.0.1/
```

2026-10-03 实测：`code-api.951100.xyz`、`cpa`、`eye`、`goof`、`proxy-api` 当时上游未监听（裸 502，154 字节），
换页后这 5 个站点全部返回 503 + 维护页（18845 字节，md5 `5533e47b…`）+ `Retry-After: 15`；
其余 9 个站点保持各自原来的 200 正文，`http→https` 301 不变。
