#!/usr/bin/env bash
# MongoDB 逻辑备份：全库 mongodump --archive --gzip（可加 --drill 做真实恢复演练）
#
# 凭据只从 mongodb 容器的 MONGO_INITDB_ROOT_* 环境变量读，用变量传给容器内客户端，
# 不写进命令文本、不进日志。信任级与容器自身 env 一致（有 docker 权限就能 docker inspect 拿到）。
#
# 用法: backup-mongo.sh [保留份数=7] [--drill]
# 退出码: 0 成功；1 备份本身失败（演练不一致只告警，不删归档）
#
# 实测坑（2026-10-03）：
#  1. 演练实例必须 --ulimit nofile=64000:64000。否则批量建索引时 WiredTiger
#     “Too many open files” -> WT_PANIC -> abort，restore 报
#     “connection closed unexpectedly by the other side”、mongod 退出码 139。
#     线上 mongodb 容器当前 nofile=1024，**真恢复灌回线上前必须把它调大**
#     （1Panel 容器编辑 / compose 加 ulimits.nofile，或 docker run --ulimit）。
#  2. 演练实例必须限制内存：本机 3.9G 且无 swap，默认 WiredTiger cache 会吃半台机。
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

KEEP=7; DRILL=0
for a in "$@"; do case "$a" in --drill) DRILL=1 ;; *[0-9]*) KEEP="$a" ;; esac; done
CONTAINER="${MONGO_CONTAINER:-mongodb}"
DEST="${BACKUP_DIR:-/root/backups}"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$DEST/mongo-$TS.archive.gz"
MAN="$DEST/mongo-$TS.manifest.txt"
DRILLDIR=/var/tmp/mongo-drill
DC=mongo-drill-verify
mkdir -p "$DEST"; chmod 700 "$DEST"
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
cleanup() {
  rm -f "$OUT.tmp" "$OUT.err"
  docker rm -f "$DC" >/dev/null 2>&1 || true
  rm -rf "$DRILLDIR"
}
trap cleanup EXIT

# ---- 1) 凭据（只活在变量里）----
ENV_ALL=$(docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}')
MU=$(printf '%s\n' "$ENV_ALL" | sed -n 's/^MONGO_INITDB_ROOT_USERNAME=//p')
MP=$(printf '%s\n' "$ENV_ALL" | sed -n 's/^MONGO_INITDB_ROOT_PASSWORD=//p')
unset ENV_ALL
if [ -z "$MU" ] || [ -z "$MP" ]; then log 'ERROR: 容器 env 里没有 MONGO_INITDB_ROOT_USERNAME/PASSWORD'; exit 1; fi
mongo_exec() { docker exec -i -e MU="$MU" -e MP="$MP" "$CONTAINER" sh -c "$1"; }
SCOPE='db.adminCommand({listDatabases:1}).databases.forEach(d=>{const s=db.getSiblingDB(d.name).stats(); print(d.name+" "+s.collections+" "+s.objects)})'
src_q() { mongo_exec "mongosh --quiet --host 127.0.0.1 --port 27017 -u \"\$MU\" -p \"\$MP\" --authenticationDatabase admin --eval '$1'" 2>/dev/null; }
DB_ARGS='--host 127.0.0.1 --port 27017'

# ---- 2) 副本集则加 --oplog ----
RS=$(src_q 'try { rs.status().ok } catch (e) { 0 }' | tail -1)
OPLOG=''; [ "$RS" = 1 ] && OPLOG='--oplog'
NOFILE=$(docker exec "$CONTAINER" sh -c 'ulimit -n' 2>/dev/null || echo unknown)
log "容器=$CONTAINER 副本集=${RS:-0} oplog=$([ -n "$OPLOG" ] && echo yes || echo no) 容器内 nofile=$NOFILE"
[ "$NOFILE" != unknown ] && [ "$NOFILE" -lt 64000 ] && log 'NOTICE: 容器 nofile<64000，恢复（灌回线上）时可能 WT_PANIC，建议在 compose/1Panel 里调到 64000'

# ---- 3) 导出到临时文件，成功后才改名 ----
log 'mongodump 开始'
if ! mongo_exec "mongodump $DB_ARGS -u \"\$MU\" -p \"\$MP\" --authenticationDatabase admin --gzip $OPLOG --archive" > "$OUT.tmp" 2> "$OUT.err"; then
  log "ERROR: mongodump 失败: $(tail -1 "$OUT.err")"; exit 1
fi
SZ=$(stat -c %s "$OUT.tmp")
if [ "$SZ" -lt 1024 ]; then log "ERROR: 归档只有 $SZ 字节，判定失败"; exit 1; fi
mv "$OUT.tmp" "$OUT"
gzip -t "$OUT" || { log 'ERROR: 归档不是合法 gzip'; exit 1; }
log "归档 $(numfmt --to=iec "$SZ")"

# ---- 4) 清单（含机器可读的 counts，供演练对比）----
SHA=$(sha256sum "$OUT" | cut -d' ' -f1)
CHK="${OUT%.archive.gz}.counts.txt"
src_q "$SCOPE" > "$CHK" 2>/dev/null || true
{
  echo '# mongo backup manifest'
  echo "generated_at=$(date -Iseconds)"
  echo "hostname=$(hostname)"
  echo "container=$CONTAINER  image=$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')"
  echo "mongod=$(mongo_exec 'mongod --version' | sed -n 's/^db version v//p')"
  echo "tools=$(mongo_exec 'mongodump --version' | head -1)"
  echo "replica_set=$([ -n "$OPLOG" ] && echo yes || echo no)  oplog_dump=${OPLOG:-none}"
  echo "container_nofile=$NOFILE"
  echo "archive=$(basename "$OUT")  bytes=$SZ  sha256=$SHA"
  echo "data_dir_size=$(du -sh /opt/1panel/apps/mongodb/mongodb/data 2>/dev/null | cut -f1)"
  echo "df_root=$(df -h / | awk 'NR==2{print $5" used, "$4" free"}')"
  echo
  echo '## databases (name collections objects)'
  sed 's/^/  /' "$CHK"
} > "$MAN" 2>/dev/null || true
chmod 600 "$OUT" "$MAN" "$CHK"
sed -n '1,12p' "$MAN"

# ---- 5) 恢复演练（可选）----
if [ "$DRILL" = 1 ]; then
  log '---- 恢复演练：临时 mongod 灌归档 + 逐库对比 ----'
  docker rm -f "$DC" >/dev/null 2>&1 || true
  rm -rf "$DRILLDIR"; mkdir -p "$DRILLDIR"
  docker run -d --name "$DC" --network none --ulimit nofile=64000:64000 \
    --memory 1500m --memory-swap 1500m -v "$DRILLDIR":/data/db \
    mongo:8.2.5 --port 27099 --wiredTigerCacheSizeGB 0.25 >/dev/null
  up=0
  for _ in $(seq 1 40); do
    docker exec "$DC" mongosh --quiet --port 27099 --eval 'db.adminCommand({ping:1})' >/dev/null 2>&1 && { up=1; break; }
    sleep 1
  done
  if [ "$up" != 1 ]; then
    log 'WARN: 演练实例没起来，跳过演练（备份本身不受影响）'; docker logs --tail 5 "$DC" 2>&1 | sed 's/^/  /'
  else
    if docker exec -i "$DC" mongorestore --port 27099 --gzip --archive --drop < "$OUT" > "$OUT.err" 2>&1; then
      docker exec "$DC" mongosh --quiet --port 27099 --eval "$SCOPE" 2>/dev/null | sort > /var/tmp/drill-dst.txt
      python3 - "$CHK" /var/tmp/drill-dst.txt <<'PYEOF'
import sys, os
SKIP = {'local', 'config', 'admin'}   # 节点内部/本地库不参与比对

def load(p):
    out = {}
    for line in open(p):
        f = line.split()
        if len(f) == 3:
            out[f[0]] = (int(f[1]), int(f[2]))
    return out

src, dst = load(sys.argv[1]), load(sys.argv[2])
apps = [d for d in src if d not in SKIP]
hard, drift, ok = [], [], []
for d in sorted(apps):
    if d not in dst:
        hard.append('%s: 演练里没有这个库' % d); continue
    sc, so = src[d]; dc, do = dst[d]
    if sc != dc:
        hard.append('%s: 集合数 %d -> %d' % (d, sc, dc)); continue
    if so == do:
        ok.append(d)
    elif 0 <= so - do <= max(5, so * 0.02):
        drift.append('%s: 文档 %d -> %d（转储后线上又写了 %d 条）' % (d, so, do, so - do))
    else:
        hard.append('%s: 文档数差得太多 %d -> %d' % (d, so, do))
print('  完全一致 %d/%d 库: %s' % (len(ok), len(apps), ','.join(ok) if ok else '-'))
for x in drift: print('  写入漂移(正常): ' + x)
for x in hard:  print('  !! 不一致: ' + x)
print('  演练结论: ' + ('PASS 归档可完整恢复' if not hard else 'FAIL'))
sys.exit(1 if hard else 0)
PYEOF
      [ $? = 0 ] && log '演练通过' || log 'WARN: 演练有不一致项，人工看一眼上面'
    else
      log "WARN: 演练恢复失败（rc=$?）"
      tail -3 "$OUT.err" | sed 's/^/  /'
      docker inspect "$DC" --format '  演练实例 exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' 2>/dev/null || true
      docker logs --tail 6 "$DC" 2>&1 | grep -iE 'panic|too many open files|fassert|signal' | sed 's/^/  /' || true
    fi
  fi
  rm -f /var/tmp/drill-dst.txt
fi

# ---- 6) 加密（age）：归档 + 清单 + 计数就地加密，明文删掉 ----
"$DEST/seal-backups.sh" "$OUT" "$MAN" "$CHK" || { log 'ERROR: 加密失败，明文已保留（先跑 seal-backups.sh --check）'; exit 1; }

# ---- 7) 保留最近 KEEP 份（按密文计数）----
ls -1t "$DEST"/mongo-* 2>/dev/null | grep -E '\.archive\.gz(\.age)?$' | tail -n +$((KEEP + 1)) | while read -r old; do
  stem="${old%%.archive.gz*}"
  rm -f "$stem".archive.gz* "$stem".manifest.txt* "$stem".counts.txt*
  log "pruned $(basename "$old")"
done
log "完成 sha256=${SHA:0:16}…  保留 $(find "$DEST" -maxdepth 1 -name 'mongo-*.archive.gz*' ! -name '*.sha256' | wc -l)/$KEEP 份  $(du -sh "$DEST" | cut -f1)"
