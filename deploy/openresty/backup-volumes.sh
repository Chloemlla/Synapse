#!/usr/bin/env bash
# 容器挂载数据备份：所有容器（含已停）的 bind mount 与具名卷
#
# 排除已被其他备份覆盖的路径：redis 数据（backup-redis.sh 负责 BGSAVE 后的一致快照）、
# mongodb 数据（backup-mongo.sh 逻辑导出）、openresty/www（backup-openresty.sh）、系统文件。
# 挂载里检测到 SQLite WAL 时默认先 stop 对应容器再拷（否则拷到一半的库不可用），拷完立即 start；
# --no-quiesce 可关掉（线上活跃服务不希望被短停时用）。
#
# 用法: backup-volumes.sh [保留份数=7] [--no-quiesce]
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

KEEP=7; QUIESCE=1
for a in "$@"; do case "$a" in --no-quiesce) QUIESCE=0 ;; *[0-9]*) KEEP="$a" ;; esac; done
DEST="${BACKUP_DIR:-/root/backups}"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$DEST/volumes-$TS.tar.gz"
MAN="$DEST/volumes-$TS.manifest.txt"
LIST=/tmp/vol-mounts.tsv
KEEP_LIST=/tmp/vol-keep.txt
SKIP_NOTES=/tmp/vol-skip.txt
WORK=$(mktemp -d /tmp/vol-verify.XXXXXX)
STOPPED=''
STOPMARK="$DEST/.quiesce-inprogress"
mkdir -p "$DEST"; chmod 700 "$DEST"
log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
restart() { local c; for c in $STOPPED; do docker start "$c" >/dev/null 2>&1 && log "已重新启动 $c"; done; STOPPED=''; rm -f "$STOPMARK"; }
cleanup() { restart; rm -f "$OUT.tmp" "$OUT.err"; rm -rf "$WORK"; }
trap cleanup EXIT
# 上次若被强杀（容器停了但脚本没跑完），先把它们拉起来
if [ -f "$STOPMARK" ]; then
  log 'WARN: 上次中断留下暂停标记，先恢复容器'
  for c in $(cat "$STOPMARK"); do docker start "${c#/}" >/dev/null 2>&1 && log "  已启动 ${c#/}"; done
  rm -f "$STOPMARK"
fi

skipped() {
  case "$1" in
    /opt/1panel/www*|/opt/1panel/apps/openresty*|/opt/1panel/apps/mongodb/mongodb/data*|/opt/1panel/apps/redis/redis/data*|/etc/localtime|/etc/timezone|/etc/hosts|/etc/resolv.conf|/etc/hostname|/var/run*) return 0 ;;
    *) return 1 ;;
  esac
}

# ---- 1) 枚举所有容器挂载 + 孤儿卷 ----
python3 - > "$LIST" <<'PY'
import json, subprocess

def docker(*args):
    return subprocess.run(['docker', *args], capture_output=True, text=True).stdout

mounts = set()
ids = docker('ps', '-aq').split()
if ids:
    for c in json.loads(docker('inspect', *ids)):
        for m in (c.get('Mounts') or []):
            if m.get('Type') in ('bind', 'volume') and m.get('Source'):
                mounts.add((c['Name'], m['Type'], m['Source'], m['Destination']))
                print('\t'.join([c['Name'], m['Type'], m['Source'], m['Destination']]))
for v in docker('volume', 'ls', '-q').split():
    src = '/var/lib/docker/volumes/%s/_data' % v
    if not any(m[2] == src for m in mounts):
        print('\t'.join(['(未挂载)', 'volume', src, v]))
PY
log "发现 $(wc -l < "$LIST") 条挂载（含未挂载卷）"

# ---- 2) 分类：跳过 or 纳入 ----
: > "$KEEP_LIST"; : > "$SKIP_NOTES"
while IFS=$'\t' read -r c type src dst; do
  [ -n "$src" ] || continue
  if skipped "$src"; then
    printf '  %-24s %-58s -> 跳过（其他备份已覆盖/系统文件）\n' "$c" "$src" >> "$SKIP_NOTES"
    continue
  fi
  grep -qxF "$src" "$KEEP_LIST" || echo "$src" >> "$KEEP_LIST"
done < "$LIST"
log "纳入 $(wc -l < "$KEEP_LIST") 个目录，跳过 $(grep -c . "$SKIP_NOTES" || true) 条"

# ---- 3) 检测 SQLite WAL → 需要 short-stop 的容器 ----
TOSTOP=''
while IFS=$'\t' read -r c type src dst; do
  [ -n "$src" ] || continue
  skipped "$src" && continue
  [ -d "$src" ] || continue
  if find "$src" -maxdepth 3 \( -name '*-wal' -o -name '*.sqlite-wal' \) -print -quit 2>/dev/null | grep -q .; then
    TOSTOP="$TOSTOP $c"
  fi
done < "$LIST"
TOSTOP=$(printf '%s\n' $TOSTOP | grep -v '^(未挂载)$' | sort -u | tr '\n' ' ')
if [ "$QUIESCE" = 1 ] && [ -n "$TOSTOP" ]; then
  log "检测到 WAL，先停容器保证一致: $TOSTOP"
  printf '%s\n' $TOSTOP > "$STOPMARK"
  for c in $TOSTOP; do
    if docker stop "$c" >/dev/null 2>&1; then STOPPED="$STOPPED $c"; else log "WARN: 停 $c 失败，改为热拷"; fi
  done
fi

# ---- 4) 打包（路径相对 /）----
PATHS=''
while read -r src; do
  [ -d "$src" ] && PATHS="$PATHS ${src#/}"
done < "$KEEP_LIST"
if [ -z "$PATHS" ]; then log '没东西可备，退出'; exit 0; fi
log '打包中…'
# shellcheck disable=SC2086
tar czf "$OUT.tmp" -C / $PATHS 2> "$OUT.err" || { log "ERROR: tar 失败: $(tail -1 "$OUT.err")"; exit 1; }
if [ -s "$OUT.err" ]; then log "WARN: tar 报告: $(tr '\n' ' ' < "$OUT.err" | cut -c1-300)"; fi
mv "$OUT.tmp" "$OUT"; rm -f "$OUT.err"
SZ=$(stat -c %s "$OUT"); SHA=$(sha256sum "$OUT" | cut -d' ' -f1)
restart
log "归档 $(numfmt --to=iec "$SZ")"

# ---- 5) 校验：解包后抽样逐字节 cmp + SQLite integrity_check ----
tar xzf "$OUT" -C "$WORK"
same=0; diff=0; checked=0
while read -r src; do
  [ -d "$src" ] || continue
  while IFS= read -r f; do
    rel=${f#/}
    if [ -f "$WORK/$rel" ]; then
      checked=$((checked + 1))
      if cmp -s "$f" "$WORK/$rel"; then same=$((same + 1)); else diff=$((diff + 1)); log "WARN: 不一致 $f"; fi
    fi
    [ "$checked" -ge 40 ] && break
  done < <(find "$src" -type f ! -name '*-wal' ! -name '*-shm' 2>/dev/null | head -40)
  [ "$checked" -ge 40 ] && break
done < "$KEEP_LIST"
log "抽样比对: 读 $checked 个文件，一致 $same，不一致 $diff"
SQLITE_OK=0; SQLITE_BAD=0
while IFS= read -r db; do
  if [ "$(head -c 15 "$db" 2>/dev/null)" = 'SQLite format 3' ]; then
    res=$(python3 -c 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("pragma integrity_check").fetchone()[0])' "$db" 2>&1 | tail -1)
    if [ "$res" = ok ]; then SQLITE_OK=$((SQLITE_OK + 1)); log "  sqlite ok: ${db#$WORK/}"; else SQLITE_BAD=$((SQLITE_BAD + 1)); log "  sqlite BAD: ${db#$WORK/} => $res"; fi
  fi
done < <(find "$WORK" -type f -name '*.db' 2>/dev/null)

# ---- 6) 清单 ----
{
  echo '# container volumes backup manifest'
  echo "generated_at=$(date -Iseconds)"
  echo "hostname=$(hostname)"
  echo "quiesce=$QUIESCE  stopped_containers=${TOSTOP:-none}"
  echo "archive=$(basename "$OUT")  bytes=$SZ  sha256=$SHA"
  echo "sample_compare: checked=$checked same=$same diff=$diff   sqlite: ok=$SQLITE_OK bad=$SQLITE_BAD"
  echo "df_root=$(df -h / | awk 'NR==2{print $5" used, "$4" free"}')"
  echo
  echo '## 纳入的路径（恢复就是 tar xzf <archive> -C /）'
  sed 's/^/  /' "$KEEP_LIST"
  echo
  echo '## 挂载 → 容器映射'
  sort "$LIST" | awk -F'\t' '{printf "  %-24s %-6s %-58s %s\n", $1, $2, $3, $4}'
  echo
  echo '## 跳过的'
  cat "$SKIP_NOTES"
  echo
  echo '## 恢复提示'
  echo '  bind mount：tar xzf <archive> -C / 即可（路径就是宿主路径）'
  echo '  具名卷：先 docker volume create <卷名>，再解到 /var/lib/docker/volumes/<卷名>/_data'
  echo '  redis 的 dump.rdb 不在这里面：由 backup-redis.sh 负责（BGSAVE 的一致性快照）'
} > "$MAN"
chmod 600 "$OUT" "$MAN"
sed -n '1,10p' "$MAN"

# 加密（age）：明文只在“校验通过”后存在；加密后删明文，校验文件指向密文
"$DEST/seal-backups.sh" "$OUT" "$MAN" || { log 'ERROR: 加密失败，明文已保留（先跑 seal-backups.sh --check）'; exit 1; }

# 保留最近 KEEP 份（按密文计数）
ls -1t "$DEST"/volumes-* 2>/dev/null | grep -E '\.tar\.gz(\.age)?$' | tail -n +$((KEEP + 1)) | while read -r old; do
  stem="${old%%.tar.gz*}"
  rm -f "$stem".tar.gz* "$stem".manifest.txt*
  log "pruned $(basename "$old")"
done
log "完成 保留 $(find "$DEST" -maxdepth 1 -name 'volumes-*.tar.gz*' ! -name '*.sha256' | wc -l)/$KEEP 份（密文 $OUT.age）"
