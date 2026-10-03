# 接入层与业务数据备份（本机）

**所有产物都在一个文件夹：`/root/backups/`（平铺，无子目录）。**
每日 04:25 由 cron 跑 `/root/backups/daily.sh`，日志 `/var/log/1panel-ops-backup.log`。

| 文件名前缀 | 内容 | 保留 |
| --- | --- | --- |
| `openresty-<ts>.tar.gz` | 站点/全局配置、证书、维护页、WAF 自定义配置、容器定义（+ `.sha256`） | 5 |
| `1panel-state-<ts>.tar.gz` | 1Panel DB（sqlite 在线快照）、secret、全部应用定义（+ `.sha256`） | 7 |
| `mongo-<ts>.archive.gz` | MongoDB 全库逻辑导出（+ `.manifest.txt` / `.counts.txt`） | 7 |
| `redis-<ts>.tar.gz` | Redis 的 dump.rdb + redis.conf（BGSAVE 后的一致快照） | 7 |
| `volumes-<ts>.tar.gz` | 容器 bind mount 与具名卷（不含上面已覆盖的 mongo/redis/www） | 7 |
| `cert-<站点>-{fullchain,privkey}-<ts>.pem` | 每次换证前的旧证书（单站点回滚用） | 手动清 |

脚本：`daily.sh`（编排）+ `backup-openresty.sh` / `backup-panel-state.sh` / `backup-mongo.sh` /
`backup-redis.sh` / `backup-volumes.sh` / `sync-site-certs.sh`。

## ⚠️ 敏感

里面有各站点 `privkey.pem`、WAF 的 `.aes_key`/`.secret`/`token`、1Panel DB（含加密凭据）、
MongoDB 全量业务数据。已设 600 / 目录 700。**禁止入 git、禁止放进 `/opt/1panel/www` 任何目录、外传前先加密。**
同盘备份只挡误操作与配置损坏，不挡机器失效；要防灾难得另传异机/对象存储（先加密）。

## 手工跑

```bash
/root/backups/daily.sh                        # 六步全跑，末尾 SUMMARY
/root/backups/backup-mongo.sh 7 --drill       # 单独跑 Mongo + 恢复演练
/root/backups/sync-site-certs.sh --dry-run    # 只看证书会改哪些站点
```

退出码：`0` 成功；`1` 有步骤失败（日志里找带 `[FAIL]` 的那一步）；`2` 仅证书快到期告警。

## 恢复：单个文件（最常见）

```bash
A=/root/backups/openresty-<ts>.tar.gz
sha256sum -c "$A.sha256"                         # 先验完整性
tar xzf "$A" -C / opt/1panel/www/sites/tts.chloemlla.com/proxy/root.conf
docker exec openresty nginx -t && docker exec openresty nginx -s reload
```

## 恢复：整个接入层

```bash
sha256sum -c "$A.sha256"
tar xzf "$A" -C /                    # 包里没有 log/，不会盖日志
cd /opt/1panel/apps/openresty/openresty && docker compose up -d    # 容器不在时用包里的定义重建
docker exec openresty nginx -t && docker exec openresty nginx -s reload
```

## 恢复：MongoDB

```bash
A=$(ls -1t /root/backups/mongo-*.archive.gz | head -1)
MU=$(docker inspect mongodb --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^MONGO_INITDB_ROOT_USERNAME=//p')
MP=$(docker inspect mongodb --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^MONGO_INITDB_ROOT_PASSWORD=//p')
docker exec -i -e MU="$MU" -e MP="$MP" mongodb sh -c \
  'mongorestore --host 127.0.0.1 --port 27017 -u "$MU" -p "$MP" --authenticationDatabase admin --gzip --archive --drop' < "$A"
```

**灌回线上前先看 nofile：**

```bash
docker exec mongodb sh -c 'ulimit -n'      # 当前 1024，需调到 64000
```

nofile 不足时建索引阶段会 `WiredTiger: Too many open files` → `WT_PANIC` → mongod abort/segfault，
restore 端只看到 `connection closed unexpectedly`，很容易误判为归档损坏（实测踩到过）。
改 ulimit 需重建容器（数据在 bind mount 上不会丢，但 Mongo 会短暂中断）。不确定就先跑演练：
`/root/backups/backup-mongo.sh 7 --drill`（建临时 mongod，绝不碰线上）。

## 恢复：Redis

```bash
A=$(ls -1t /root/backups/redis-*.tar.gz | head -1)
tar xzf "$A" -C /            # 回 /opt/1panel/apps/redis/redis/{data/dump.rdb,conf/redis.conf}
docker restart redis         # 启动时从 /data/dump.rdb 加载
```

注意：Redis 里多为带 TTL 的短期键（限流/会话），过期后恢复意义有限，此备份主要是完整性兼兜底。

## 恢复：容器卷

```bash
A=$(ls -1t /root/backups/volumes-*.tar.gz | head -1)
tar xzf "$A" -C /            # bind mount 直接回原位（路径就是宿主路径）
# 具名卷：先 docker volume create <卷名>，再解到 /var/lib/docker/volumes/<卷名>/_data
cat "${A%.tar.gz}.manifest.txt"   # 里面有“挂载 → 容器”映射与纳入/跳过清单
```

## 证书回滚（单站点）

```bash
ls -1t /root/backups/cert-eye.chloemlla.com-*.pem     # 找一份旧证书
cp /root/backups/cert-eye.chloemlla.com-fullchain-<ts>.pem /opt/1panel/www/sites/eye.chloemlla.com/ssl/fullchain.pem
cp /root/backups/cert-eye.chloemlla.com-privkey-<ts>.pem  /opt/1panel/www/sites/eye.chloemlla.com/ssl/privkey.pem
docker exec openresty nginx -t && docker exec openresty nginx -s reload
```

## 恢复 1Panel 自身

```bash
P=$(ls -1t /root/backups/1panel-state-*.tar.gz | head -1)
sha256sum -c "$P.sha256" && mkdir -p /tmp/pnl && tar xzf "$P" -C /tmp/pnl && cd /tmp/pnl
1pctl stop core && 1pctl stop agent        # 先停面板，别在跑的时候怦 DB
cp opt/1panel/db/*.db /opt/1panel/db/
cp -a opt/1panel/secret/. /opt/1panel/secret/
1pctl start all
```

直接摆 DB 是最后手段；能用 1Panel 面板自带的「备份/快照」就用它的。

## 恢复后必验

```bash
docker exec openresty nginx -t
curl -s -o /dev/null -w '%{http_code}\n' --resolve chloemlla.com:443:127.0.0.1 https://chloemlla.com/
curl -skI --resolve eye.chloemlla.com:443:127.0.0.1 https://eye.chloemlla.com/ | grep -iE 'HTTP/|retry-after|x-maintenance-page'
/root/backups/sync-site-certs.sh --dry-run
```

## 云端副本（Google Drive）

- 上传：`/root/backups/upload-gdrive.sh`（每日任务第 7 步）；凭据 `/root/.config/server-backup/gdrive.env`（600）
- 云端位置：Drive 根下 `backups/`（账号 happyclovo@gmail.com）；每个前缀保留最新 N 份（openresty 3、其余 7）
- 取回：Drive 网页直接下载；本地校验 `sha256sum -c openresty-<ts>.tar.gz.sha256`
- 自检：`upload-gdrive.sh --list`（列云端）| `--verify=<文件名>`（下载回来比 md5）| `--dry-run`（看要传/要删什么）
- 轮换凭据：`gdrive-selfservice-token.sh`（自助拿 refresh_token，会自动写好 gdrive.env）
- 演练：`GDRIVE_FOLDER=backups-selftest upload-gdrive.sh` 传到临时目录，不碰真目录

## 加密（age）与自助恢复

- **产物全是密文**（`*.age`）：公钥在 `gdrive.env` 的 `AGE_RECIPIENT`，私钥离线（本机 `F:\sshkey\age-key.txt`）。
- 解密：`restore.sh decrypt <文件.age> [输出]`，或 `age -d -i <私钥> -o out file.age`；restore.sh 各子命令自动解密。
  服务器没私钥时：把离线那份拷上来用一次，用完删掉。
- 校验：`.age.sha256` 是**密文**哈希，**不解密**就能验（`sha256sum -c`）。
- 自助恢复：`restore.sh {list,check,extract,decrypt,openresty,panel,mongo,redis,volumes,cert}`，全部支持 `--simulate`，破坏性操作要 `--yes`。
- 存量迁移：`seal-backups.sh --check` / `--all`（幂等）。
