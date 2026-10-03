# deploy/openresty

1Panel 托管的 OpenResty（`openresty` 容器，host 网络）接入层资源。这一层不在本仓库构建，
CI 不覆盖它，改动只能靠「改完在服务器上 `nginx -t` + 真实 5xx 验证」，所以把源文件放进仓库，
避免只存在于服务器上、没人知道上一版长什么样。

| 文件 | 作用 |
| --- | --- |
| `maintenance.html` | 维护兜底页本体（自包含单文件，无外部请求） |
| `maintenance.conf` | 站点 server 块 include 的片段：`error_page 502 503 504 =503` + `@chloemlla_maintenance` 命名 location |
| `sync-site-certs.sh` | 把 1Panel 续期后的最新证书铺到所有站点 `ssl/` 目录（含到期告警） |
| `upload-gdrive.sh` | 把最新一批产物传到 Google Drive（Drive v3 REST + refresh_token，不依赖 rclone） |
| `backup-openresty.sh` | 备份接入层：站点/全局配置、证书、维护页、WAF 自定义配置、容器定义 + 清单 |
| `backup-panel-state.sh` | 备份 1Panel 自身状态：DB（sqlite 在线快照）、secret、全部应用定义 |
| `backup-mongo.sh` | MongoDB 全库 `mongodump --archive --gzip`（可 `--drill` 做真实恢复演练） |
| `backup-redis.sh` | Redis 快照：`BGSAVE` 强制落盘 → 归档 dump.rdb + redis.conf → 临时实例真加载校验 |
| `backup-volumes.sh` | 容器 bind mount 与具名卷（跳开已单独覆盖的 mongo/redis/www，含 SQLite 一致性处理） |
| `daily.sh` | 每日任务编排：上面六件事依次跑，最后给汇总与退出码 |

> **产物落点：服务器上 `/root/backups/` 一个文件夹，平铺无子目录**（文件名前缀区分类型：
> `openresty-` / `1panel-state-` / `mongo-` / `redis-` / `volumes-` / `cert-<站点>-`）。
> 脚本与 `RESTORE.md` 也在这个目录里。

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

## 证书层

现状（可在 1Panel 的 `agent.db` → `website_ssls` 里核实）：**1Panel 只维护一张证书**——
`*.chloemlla.com` + `*.951100.xyz` + `chloemlla.com`，Let's Encrypt，DNS-01（CloudFlare 账号），`auto_renew=1`。

坑在于：1Panel 续期时只会重写**它自己管理的网站**的 `ssl/` 文件（本机是 `chloemlla.com`/`janus`/`chat`/`down` 四个），
手工建的站点目录会留着旧文件不动。2026-10-03 就是因为这个，8 个站点在跑一张 **7 天前就过期的 ZeroSSL 旧证书**：
`code-api.951100.xyz`、`cpa`、`eye`、`gemini`、`ggb`、`goof`、`proxy-api`、`s`（另加 `us-raksmart-1p` 用的是上一版 LE 证书）。

**这种情况不需要重新签发**：最新证书已在机器上，只是没铺开。`sync-site-certs.sh` 负责铺：

1. 选源：先看 1Panel 管理的站点目录（`sites/tts.chloemlla.com/ssl`、`sites/cap.chloemlla.com/ssl`），
   要求 SAN 命中 `*.chloemlla.com` 且**证书与私钥公钥匹配**；否则退化成「全量站点里到期最远且满足上述条件」的一个。
2. 铺开：只改与源不一致的站点；改之前把旧证书存成 `/root/backups/cert-<站点>-{fullchain,privkey}-<ts>.pem`（可单站点回滚）。
3. `docker exec openresty nginx -t` 过了才 `reload`；任一站点的证书/私钥解析不了一律不 reload。
4. 每个站点打一行到期天数；任一张 < 21 天则退出码 2（不算失败，但日志里会 `WARNING`）。

加新站点不用改脚本：只要 `/opt/1panel/www/sites/<site>/ssl/` 存在，下次跑就会被同步。

## 每日任务

```bash
25 4 * * * /root/backups/daily.sh >> /var/log/1panel-ops-backup.log 2>&1
```

`daily.sh` 各步互相独立（一步失败不影响后两步），末尾给 `SUMMARY` + 退出码：

| 步骤 | 脚本 | 产物（均在 `/root/backups/`，平铺） | 保留 |
| --- | --- | --- | --- |
| 接入层配置 | `backup-openresty.sh 5` | `openresty-<ts>.tar.gz` + `.sha256`（~12M） | 5 份 |
| 站点证书 | `sync-site-certs.sh` | 直接改线上证书 + `cert-<站点>-*.pem` | 手动清 |
| 1Panel 状态 | `backup-panel-state.sh 7` | `1panel-state-<ts>.tar.gz` + `.sha256`（~2.2M） | 7 份 |
| MongoDB | `backup-mongo.sh 7` | `mongo-<ts>.archive.gz` + `.manifest.txt` + `.counts.txt`（~15M） | 7 份 |
| Redis | `backup-redis.sh 7` | `redis-<ts>.tar.gz` + `.manifest.txt`（~39K） | 7 份 |
| 容器卷 | `backup-volumes.sh 7` | `volumes-<ts>.tar.gz` + `.manifest.txt`（~70K） | 7 份 |
| 云端副本 | `upload-gdrive.sh` | Google Drive 根下 `backups/`（每天约 30M，云端每前缀保留 3～7 份） | — |

几个刻意的取舍：

- **DB 一定要走 sqlite 在线备份 API**（`backup-panel-state.sh` 里的 python 片段），不能 `cp`：
  `agent.db` 带 8M WAL，`cp` 可能拷到写一半的页。备份完顺手 `pragma integrity_check`。
- 备份里**不存日志与构建产物**（`log/`、`build/`），存了只会把体积撑大、把真正要恢复的东西埋掉。
- 每份包自带 `MANIFEST.txt`（镜像 digest、`nginx -V`、备份时刻的 `nginx -t` 结果、端口、证书到期日、配置 md5）
  与 `RESTORE.md`，恢复时不用猜当时是什么状态。
- 主打「恢复得了」而不是「存下来了」：打完包立刻解出来与线上逐字节比对（`backup-openresty.sh`）或跑完整性检查。

> ⚠️ 这些包是敏感文件：含各站点 `privkey.pem`、1Panel WAF 的 `.aes_key`/`.secret`/`token`、
> 以及 1Panel 数据库（里面有加密的账号凭据）。已设 600 / 目录 700。
> **禁止入 git、禁止放进 `/opt/1panel/www` 任何目录、离线外传前必须加密**。
>
> 另外这是**同盘**备份，只挡误操作与配置损坏，不挡磁盘/机器失效；要防灾难得另传异机或对象存储（先加密）。
> Mongo 归档里是**全部业务数据**（用户、审计、令牌类集合），比配置包更敏感。
> 没持久化的容器（状态在可写层）不在此列，见下文「Redis 与容器卷」。

## MongoDB 业务数据

`backup-mongo.sh` 在 `mongodb` 容器内跑 `mongodump`（该镜像自带 tools 100.15.0），全库导出到
`/root/backups/mongo-<ts>.archive.gz`，旁边配 `manifest.txt`（镜像/mongod 版本、`container_nofile`、sha256、库清单）
与 `counts.txt`（机器可读的每库 collections/objects，供演练对比）。当前 12～13 个库、315k 文档、归档 ~15M。

几个要点：

- **凭据不进命令也不进日志**：从容器 env 里 `sed` 出 `MONGO_INITDB_ROOT_USERNAME/PASSWORD` 到变量，
  再用 `docker exec -e` 传进容器内客户端。信任级与容器自身 env 一致（有 docker 权限本来就能 `docker inspect` 拿到）。
- **先写 `.tmp` 再改名**：不会出现“半个归档”被当成备份；`gzip -t` 不过就失败退出。
- **副本集自动 `--oplog`**：拿一致性快照（本机是单机，所以没开）。
- **演练（`--drill`）**：起一个临时 `mongo:8.2.5`（`--network none`，绝不碰线上），把归档灌进去，
  再逐库对比集合数与文档数。只容忍“写入漂移”（转储后线上又写了几条，比如 `tts.audit_logs`）；
  集合数不一致或文档数差很多就是 FAIL。`local`/`config`/`admin` 不参与对比。
  日常任务**周日自动带 `--drill`**，手工随时可跑：`/root/backups/backup-mongo.sh 7 --drill`。

### ⚠️ 真恢复前必须先看 nofile

实测（2026-10-03，踩了三轮）：nofile 不够时，`mongorestore` 先报 315352 文档全部恢复成功，
然后在**建索引**阶段报 `WiredTiger: Too many open files` → `WT_PANIC` → mongod abort/segfault（退出码 139），
restore 端看到的是 `connection closed unexpectedly by the other side`，很容易误以为是归档坏了。

```bash
docker exec mongodb sh -c 'ulimit -n'     # 本机只有 1024（硬限 524288），建议 64000
# 修法（任选）：1Panel 容器编辑加 ulimits，或 compose 里
#   ulimits:
#     nofile:
#       soft: 64000
#       hard: 64000
# 注意改 ulimit 必须重建容器（数据在 bind mount 上不会丢，但会短暂中断 Mongo）
```

演练实例用的就是 `--ulimit nofile=64000:64000`，所以演练 PASS 不代表线上容器也够——这一条得单独确认。
另外演练实例限了内存（`--memory 1500m` + `--wiredTigerCacheSizeGB 0.25`）：本机 3.9G 无 swap，
默认 WiredTiger cache 会吃掉半台机，曾经直接把演练实例搞死（当时误判为内存问题，其实是 fd）。

恢复命令（会 `--drop` 同名集合）：见服务器上 `/root/backups/RESTORE.md` 的「恢复：MongoDB」一节。

## Redis 与容器卷

- **Redis**（`backup-redis.sh`）：不能直接拷盘上的 `dump.rdb`——save 策略是 `3600 1 / 300 100 / 60 10000`，
  盘上那份可能已钝一小时。所以先 `BGSAVE` 等 `rdb_last_bgsave_status:ok`，再归档 `dump.rdb` + `redis.conf`。
  口令从容器 `Cmd` 的 `--requirepass` 取，只传变量不进 `argv`。校验方式是搭一个临时 redis（`--network none`）
  读这份 RDB，看它是否打出 `DB loaded from disk` 并报告 `keys_loaded/expired`。
  Redis 里主要是带 TTL 的短期键（限流/会话，实测 20 个 key 上下），过期后恢复意义有限，留着是完整性兼兜底。
- **容器卷**（`backup-volumes.sh`）：枚举**所有容器（含已停）**的 bind mount 与具名卷（含未挂载的孤儿卷），
  跳开已被别的备份覆盖的路径（`mongodb/data`、`redis/data`、`/opt/1panel/www`、openresty 目录、`/etc/localtime` 等）。
  检测到挂载里有 SQLite `*-wal` 时**默认先 `docker stop` 对应容器再拷**（否则拷到一半的库不可用），拷完立即 start，
  `--no-quiesce` 可关掉。校验：解包后抽样逐字节 `cmp` + 对 SQLite 文件跑 `PRAGMA integrity_check`。
  实测该目录只有 ~1.5M（`/etc/alist` 的 sqlite、deepseek-harness 数据、redis.conf、几个空卷），归档 ~70K。

> 注意：`tts-node`、`librechat`、`cap`、`geogebra`、`gggggg` 等容器**没有挂载任何卷**，状态在容器可写层里，
> 重建容器就会丢（它们的持久数据在 Mongo）。这不是备份漏了，而是这些部署本来就没持久化。

### 在服务器上安装 / 重建这套东西

```bash
mkdir -p /root/backups
install -m 700 \
  /path/to/deploy/openresty/daily.sh \
  /path/to/deploy/openresty/backup-openresty.sh \
  /path/to/deploy/openresty/backup-panel-state.sh \
  /path/to/deploy/openresty/backup-mongo.sh \
  /path/to/deploy/openresty/backup-redis.sh \
  /path/to/deploy/openresty/backup-volumes.sh \
  /path/to/deploy/openresty/sync-site-certs.sh \
  /path/to/deploy/openresty/upload-gdrive.sh \
  /root/backups/
crontab -l 2>/dev/null | grep -v daily.sh > /tmp/ct.txt
printf '25 4 * * * /root/backups/daily.sh >> /var/log/1panel-ops-backup.log 2>&1\n' >> /tmp/ct.txt
crontab /tmp/ct.txt && rm -f /tmp/ct.txt
cp /path/to/deploy/openresty/RESTORE.md /root/backups/RESTORE.md   # 会被打进每份包
/root/backups/daily.sh          # 手工跑一次，确认六步都 [ok]
```

## 云端副本（Google Drive）

`upload-gdrive.sh` 把本地最新一批产物推到 Google Drive，不依赖 rclone，直接用 Drive v3 REST：
`refresh_token` 换 `access_token` → 确保 Drive 根下存在 `backups/` 目录 → 逐个文件走 resumable 会话上传。

```bash
/root/backups/upload-gdrive.sh            # 传最新一批 + 按保留数清理云端旧件
/root/backups/upload-gdrive.sh --dry-run  # 只看要传/要删什么
/root/backups/upload-gdrive.sh --list     # 列云端现状
/root/backups/upload-gdrive.sh --verify=mongo-<ts>.archive.gz   # 下载回本地比对 md5
```

设计取舍：

- **只传「最新一批」而不是整个目录**：本地 `/root/backups` 有 180M+ 且带 5～7 份保留，
  全传等于把保留策略也搬上云。每个前缀只取最新一件（连它的 `.sha256`/`.manifest.txt`/`.counts.txt`）→ 每天约 30M。
- **幂等**：断网重跑不会重复上传——云端同名且大小一致就 skip。
- **传完就验**：拿 Drive 返回的 `size` + `md5Checksum` 与本地 md5 比对，不一致报 FAIL；
  需要更强证据就用 `--verify=<文件名>` 真下载回来比。
- **云端保留**：每个前缀只留最新 N 份（openresty 3、其余 7），连带旁文件一起删；
  删除只在“上一前缀已有新件”时发生，不会把唯一一份删了。

凭据放在 `/root/.config/server-backup/gdrive.env`（600，**不在备份目录里**，不会被传上去）：

```
GDRIVE_CLIENT_ID=...apps.googleusercontent.com
GDRIVE_CLIENT_SECRET=...
GDRIVE_REFRESH_TOKEN=1//...
GDRIVE_FOLDER=backups
```

换/轮换凭据用同一目录下的 `gdrive-selfservice-token.sh`（本地 Windows 或服务器都能跑，只要 bash+curl）：
它打印（并尝试打开）带 `access_type=offline&prompt=consent` 的授权 URL → 你粘回地址栏里的 `code`
→ 换出 `refresh_token` → 立刻用 `refresh_token` 再换一次 token 并查 Drive 账号/配额自检
→ 写出 600 的 `gdrive.env`。失败会按 `invalid_grant` / `redirect_uri_mismatch` / `invalid_client` 给对应提示并可重试。

> 这些值是从 1Panel 的 `backup_accounts.vars` 里取出来的（**1Panel 是明文存的**），
> refresh_token 长期有效——有面板/数据库读权限就等于有这个盘的写入权。
> 不要入 git；如果它曾经出现在聊天记录/日志里，去 Google 账号里删掉该 OAuth 客户端重新授权。
> 另外 Drive 是服务端加密，不是端到端加密，而备份里有私钥与全量业务数据；真在意就上传前再加一层
> （`gpg --symmetric` / `age`）——目前没加，因为主要目的是“机器挂了还能拿回来”。

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
# expect: HTTP/2 503 / retry-after: 15 / x-maintenance-page: v4 / x-robots-tag: noindex, nofollow / charset=utf-8
md5sum /tmp/m.html    # 等于仓库里的 deploy/openresty/maintenance.html

# 2) 没挂的站点不能回归：仍是上游自己的 200，且 http 仍 301 跳 https
curl -sk -o /dev/null -w '%{http_code}\n' --resolve <host>:443:127.0.0.1 https://<host>/
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H 'Host: <host>' http://127.0.0.1/
```

2026-10-03 实测：`code-api.951100.xyz`、`cpa`、`eye`、`goof`、`proxy-api` 当时上游未监听（裸 502，154 字节），
换页后这 5 个站点全部返回 503 + 维护页（18845 字节，md5 `5533e47b…`）+ `Retry-After: 15`；
其余 9 个站点保持各自原来的 200 正文，`http→https` 301 不变。

证书同理，别只看文件，要拿严格 TLS 握手验（不加 `-k`，让 curl 自己校链与主机名）：

```bash
for h in <hosts>; do
  curl -s -o /dev/null -w "$h %{http_code}\n" --resolve "$h:443:127.0.0.1" "https://$h/"
done
# 全部应能拿到 200/503（没有 TLS 报错）；NXDOMAIN 的子域用 --resolve 一样能验
```

2026-10-03 实测：14 个站点全部通过（不再有 `-k` 才能访问的站点），到期日统一为 `Dec 24 2026`。
