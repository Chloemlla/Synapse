#!/usr/bin/env bash
# 每日运维备份：接入层配置 + 站点证书 + 1Panel 状态 + MongoDB + Redis + 容器卷
# 每步独立、互不影响；最后汇总退出码（非 0 就去日志里看哪一步）
# 周日多跑一次 Mongo 恢复演练（--drill）；最后一步把最新一批推到 Google Drive
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
BACKUP_DIR=/root/backups
rc=0
banner() { echo; echo "===== $(date '+%F %T') $* ====="; }

banner 'STEP 1/7 openresty 配置 + 站点内容 + WAF'
if "$BACKUP_DIR/backup-openresty.sh" 5; then echo '[ok] openresty-backup'; else echo '[FAIL] openresty-backup'; rc=1; fi

banner 'STEP 2/7 站点证书分发 + 过期检查'
"$BACKUP_DIR/sync-site-certs.sh"; c=$?
case $c in
  0) echo '[ok] certs 已同步' ;;
  2) echo '[WARN] 证书即将过期，去 1Panel 看续期' ;;
  *) echo '[FAIL] cert sync rc='"$c"; rc=1 ;;
esac

banner 'STEP 3/7 1Panel 状态（DB/secret/应用定义）'
if "$BACKUP_DIR/backup-panel-state.sh" 7; then echo '[ok] panel-state-backup'; else echo '[FAIL] panel-state-backup'; rc=1; fi

DRILL=''
[ "$(date +%u)" = 7 ] && DRILL='--drill'
banner "STEP 4/7 MongoDB 逻辑备份$([ -n "$DRILL" ] && echo '（今日附带恢复演练）')"
if "$BACKUP_DIR/backup-mongo.sh" 7 $DRILL; then echo '[ok] mongo-dump'; else echo '[FAIL] mongo-dump'; rc=1; fi

banner 'STEP 5/7 Redis 快照（BGSAVE + 加载校验）'
if "$BACKUP_DIR/backup-redis.sh" 7; then echo '[ok] redis-snapshot'; else echo '[FAIL] redis-snapshot'; rc=1; fi

banner 'STEP 6/7 容器挂载数据（bind mount + 具名卷，含 SQLite 一致性处理）'
if "$BACKUP_DIR/backup-volumes.sh" 7; then echo '[ok] volumes'; else echo '[FAIL] volumes'; rc=1; fi

banner 'STEP 7/7 云端副本（Google Drive）'
if [ -r /root/.config/server-backup/gdrive.env ]; then
  if "$BACKUP_DIR/upload-gdrive.sh"; then echo '[ok] gdrive-upload'; else echo '[FAIL] gdrive-upload'; rc=1; fi
else
  echo '[skip] 未配置 /root/.config/server-backup/gdrive.env，跳过云端上传'
fi

banner 'SUMMARY'
du -sh "$BACKUP_DIR"/* 2>/dev/null
useg=$(df --output=pcent / | tail -1 | tr -d ' %')
echo "根分区使用率: ${useg}%"
if [ "$useg" -gt 90 ]; then echo '[WARN] 根分区使用率 >90%，备份该攒不住了'; rc=1; fi
echo "结果: $([ $rc -eq 0 ] && echo OK || echo '有失败项')  退出码=$rc"
exit $rc
