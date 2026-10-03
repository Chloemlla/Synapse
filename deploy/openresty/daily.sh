#!/usr/bin/env bash
# 每日运维备份：接入层配置 + 站点证书 + 1Panel 状态
# 每步独立，互不影响；最后汇总退出码（非 0 就去日志里看哪一步）
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
set -uo pipefail
BACKUP_DIR=/root/backups
rc=0
banner() { echo; echo "===== $(date '+%F %T') $* ====="; }

banner 'STEP 1/3 openresty 配置 + 站点内容 + WAF'
if "$BACKUP_DIR/backup-openresty.sh" 5; then echo '[ok] openresty-backup'; else echo '[FAIL] openresty-backup'; rc=1; fi

banner 'STEP 2/3 站点证书分发 + 过期检查'
"$BACKUP_DIR/sync-site-certs.sh"; c=$?
case $c in
  0) echo '[ok] certs 已同步' ;;
  2) echo '[WARN] 证书即将过期，去 1Panel 看续期' ;;
  *) echo '[FAIL] cert sync rc='"$c"; rc=1 ;;
esac

banner 'STEP 3/3 1Panel 状态（DB/secret/应用定义）'
if "$BACKUP_DIR/backup-panel-state.sh" 7; then echo '[ok] panel-state-backup'; else echo '[FAIL] panel-state-backup'; rc=1; fi

banner 'SUMMARY'
du -sh "$BACKUP_DIR"/* 2>/dev/null
useg=$(df --output=pcent / | tail -1 | tr -d ' %')
echo "根分区使用率: ${useg}%"
if [ "$useg" -gt 90 ]; then echo '[WARN] 根分区使用率 >90%，备份该攒不住了'; rc=1; fi
echo "结果: $([ $rc -eq 0 ] && echo OK || echo '有失败项')  退出码=$rc"
exit $rc
