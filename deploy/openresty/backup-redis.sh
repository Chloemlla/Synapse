#!/usr/bin/env bash
# Redis 快照备份：BGSAVE 强制落盘 → 归档 dump.rdb + redis.conf → 用临时 redis 真加载校验
#
# 为什么不直接拷 dump.rdb：save 策略是 3600 1/300 100/60 10000，盘上的可能已钝一小时，先 BGSAVE。
# 口令从容器 Cmd 的 --requirepass 取，只在变量里，不回显。
#
# 用法: backup-redis.sh [保留份数=7]
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

KEEP="${1:-7}"
CONTAINER="${REDIS_CONTAINER:-redis}"
DEST="${BACKUP_DIR:-/root/backups}"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$DEST/redis-$TS.tar.gz"
MAN="$DEST/redis-$TS.manifest.txt"
DATADIR=/opt/1panel/apps/redis/redis/data
CONFFILE=/opt/1panel/apps/redis/redis/conf/redis.conf
DRILL=/var/tmp/redis-drill
DC=redis-drill-verify
mkdir -p "$DEST"; chmod 700 "$DEST"
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
cleanup() { rm -f "$OUT.tmp" "$OUT.err"; docker rm -f "$DC" >/dev/null 2>&1 || true; rm -rf "$DRILL"; }
trap cleanup EXIT

# ---- 1) 口令（只在变量里）----
RP=$(docker inspect "$CONTAINER" --format '{{json .Config.Cmd}}' 2>/dev/null | python3 -c 'import json,sys
try:
    a = json.load(sys.stdin) or []
except Exception:
    a = []
print(a[a.index("--requirepass")+1] if "--requirepass" in a else "")')
AUTH=no; [ -n "$RP" ] && AUTH=yes

# 容器内执行 redis-cli（凭据经 env 传入，不进 argv）
RCLI='redis-cli --no-auth-warning'
if [ "$AUTH" = yes ]; then
  rc() { docker exec -e RP="$RP" "$CONTAINER" sh -c "$RCLI -a \"\$RP\" \"\$@\"" _ "$@" 2>/dev/null | tr -d '\r'; }
  INFO() { docker exec -e RP="$RP" "$CONTAINER" sh -c "$RCLI -a \"\$RP\" info" 2>/dev/null | tr -d '\r'; }
else
  rc() { docker exec "$CONTAINER" $RCLI "$@" 2>/dev/null | tr -d '\r'; }
  INFO() { docker exec "$CONTAINER" $RCLI info 2>/dev/null | tr -d '\r'; }
fi
VER=$(INFO | sed -n 's/^redis_version://p')
log "容器=$CONTAINER redis=${VER:-?} requirepass=$AUTH"
[ -n "$VER" ] || { log 'ERROR: 连不上 redis'; exit 1; }

# ---- 2) 强制落盘并等完成 ----
log 'BGSAVE'
rc BGSAVE >/dev/null || { log 'ERROR: BGSAVE 下发失败'; exit 1; }
fors=0
while :; do
  inprog=$(INFO | sed -n 's/^rdb_bgsave_in_progress://p')
  status=$(INFO | sed -n 's/^rdb_last_bgsave_status://p')
  [ "$inprog" = 0 ] && break
  fors=$((fors + 1))
  [ "$fors" -gt 60 ] && { log 'ERROR: BGSAVE 超时'; exit 1; }
  sleep 1
done
[ "$status" = ok ] || { log "ERROR: BGSAVE 状态=$status"; exit 1; }
RDB_TS=$(INFO | sed -n 's/^rdb_last_save_time://p')
log "BGSAVE ok  rdb_last_save_time=$RDB_TS ($(date -d @"$RDB_TS" '+%F %T' 2>/dev/null))"
[ -s "$DATADIR/dump.rdb" ] || { log "ERROR: $DATADIR/dump.rdb 不存在或为空"; exit 1; }

# ---- 3) 归档（路径相对 /，恢复就是 tar xzf -C /）----
DBSIZE=$(rc DBSIZE | tail -1)
tar czf "$OUT.tmp" -C / "${DATADIR#/}" "${CONFFILE#/}" 2> "$OUT.err" || { log "ERROR: tar 失败: $(tail -1 "$OUT.err")"; exit 1; }
if [ -s "$OUT.err" ]; then log "WARN: tar 报告: $(tr '\n' ' ' < "$OUT.err" | cut -c1-200)"; fi
mv "$OUT.tmp" "$OUT"; rm -f "$OUT.err"
SZ=$(stat -c %s "$OUT")
SHA=$(sha256sum "$OUT" | cut -d' ' -f1)
log "归档 $(numfmt --to=iec "$SZ")（dump.rdb $(stat -c %s "$DATADIR/dump.rdb") 字节）"

# ---- 4) 真加载校验：临时 redis 读这份 RDB ----
AOF=$(INFO | sed -n 's/^aof_enabled://p')
SAVE_POLICY=$(rc CONFIG GET save | tr '\n' ' ')
MAXMEM=$(INFO | sed -n 's/^maxmemory_human://p')
KEYS=$(INFO | sed -n 's/^keyspace_hits://p')
drillok=unknown
rm -rf "$DRILL"; mkdir -p "$DRILL"
cp -p "$DATADIR/dump.rdb" "$DRILL/"
docker rm -f "$DC" >/dev/null 2>&1 || true
IMG=$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')
docker run -d --name "$DC" --network none -v "$DRILL":/data "$IMG" redis-server --dir /data --dbfilename dump.rdb --save '' >/dev/null
up=0
for _ in $(seq 1 20); do
  docker exec "$DC" redis-cli ping >/dev/null 2>&1 && { up=1; break; }
  sleep 1
done
if [ "$up" = 1 ]; then
  DINFO=$(docker exec "$DC" redis-cli info 2>/dev/null | tr -d '\r')
  LOADED=$(printf '%s\n' "$DINFO" | sed -n 's/^rdb_last_load_keys_loaded://p')
  EXPIRED=$(printf '%s\n' "$DINFO" | sed -n 's/^rdb_last_load_keys_expired://p')
  if docker logs "$DC" 2>&1 | grep -q 'DB loaded from disk'; then
    drillok=ok
    log "校验通过：临时 redis 从该 RDB 加载成功，keys_loaded=${LOADED:-?} expired=${EXPIRED:-?}（源 DBSIZE=$DBSIZE）"
  else
    drillok=fail
    log 'WARN: 临时 redis 没打出 DB loaded from disk，人工看一眼：'
    docker logs --tail 5 "$DC" 2>&1 | sed 's/^/  /'
  fi
else
  log 'WARN: 临时 redis 没起来，跳过加载校验'
  docker logs --tail 5 "$DC" 2>&1 | sed 's/^/  /'
fi

# ---- 5) 清单 ----
{
  echo '# redis backup manifest'
  echo "generated_at=$(date -Iseconds)"
  echo "hostname=$(hostname)"
  echo "container=$CONTAINER  image=$IMG"
  echo "redis=${VER:-?}  requirepass=$AUTH  maxmemory_human=${MAXMEM:-?}"
  echo "rdb_last_save_time=$RDB_TS  dir=/data  dbfilename=dump.rdb"
  echo "aof_enabled=${AOF:-?}  save_policy=${SAVE_POLICY:-?}"
  echo "source_dbsize=$DBSIZE  keyspace_hits=$KEYS"
  echo "archive=$(basename "$OUT")  bytes=$SZ  sha256=$SHA"
  echo "drill_load=$drillok"
  echo
  echo '## 源 info keyspace'
  INFO | grep -E '^db[0-9]+:'
  echo
  echo '## 恢复'
  echo '  tar xzf <archive> -C /      # 回 dump.rdb 与 redis.conf'
  echo '  然后 docker restart redis  # redis 启动时从 /data/dump.rdb 加载'
  echo '  注意：Redis 里主要是带 TTL 的短期键（限流/会话），过期后恢复意义有限，此备份是完整性兼兜底。'
} > "$MAN"
chmod 600 "$OUT" "$MAN"
sed -n '1,16p' "$MAN"

ls -1t "$DEST"/redis-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old" "${old%.tar.gz}.manifest.txt"
  log "pruned $(basename "$old")"
done
log "完成 保留 $(ls -1 "$DEST"/redis-*.tar.gz 2>/dev/null | wc -l)/$KEEP 份"
case "$drillok" in
  ok) exit 0 ;;
  fail) log "ERROR: 归档已生成，但加载校验失败，请人工确认"; exit 1 ;;
  *) log "WARN: 加载校验未执行（drillok=$drillok）"; exit 0 ;;
esac
