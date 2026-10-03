#!/usr/bin/env bash
# 1Panel 自身状态备份：DB（sqlite 在线备份，一致快照）+ secret + 所有应用定义（compose/data.yml）
# 不含应用数据（Mongo/Redis 等业务数据单独做，别混在这里）
# 用法: panel-state-backup.sh [保留份数=7]
set -euo pipefail

KEEP="${1:-7}"
TS=$(date +%Y%m%d-%H%M%S)
DEST=/root/backups/panel
WORK=$(mktemp -d /tmp/panel-backup.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$DEST" "$WORK/opt/1panel/db" "$WORK/opt/1panel/secret" "$WORK/opt/1panel/apps"
chmod 700 "$DEST"

# 1) DB 一致快照：不能直接 cp，一定要走 sqlite 在线备份 API，否则可能拷到写一半的页
python3 - "$WORK" <<'PY'
import sqlite3, sys, os, glob
work = sys.argv[1]
for src in sorted(glob.glob('/opt/1panel/db/*.db')):
    name = os.path.basename(src)
    dst = os.path.join(work, 'opt/1panel/db', name)
    s = sqlite3.connect('file:%s?mode=ro' % src, uri=True, timeout=30)
    d = sqlite3.connect(dst)
    s.backup(d)
    d.close(); s.close()
    print('  db snapshot: %s  %s bytes' % (name, os.path.getsize(dst)))
PY

# 2) secret（含 1Panel 加密材料）+ 应用定义
cp -a /opt/1panel/secret/. "$WORK/opt/1panel/secret/" 2>/dev/null || true
for d in /opt/1panel/apps/*/*/; do
  app="$(basename "$(dirname "${d%/}")")/$(basename "${d%/}")"
  for f in docker-compose.yml data.yml; do
    if [ -f "$d$f" ]; then
      mkdir -p "$WORK/opt/1panel/apps/$app"
      cp -p "$d$f" "$WORK/opt/1panel/apps/$app/$f"
    fi
  done
done

# 3) 清单
{
  echo '# 1Panel state backup manifest'
  echo "generated_at=$(date -Iseconds)"
  echo "hostname=$(hostname)"
  echo "panel_version=$(grep -m1 -oE '[0-9]+\.[0-9]+\.[0-9]+' /usr/local/bin/1pctl 2>/dev/null || echo unknown)"
  echo "df_root=$(df -h / | awk 'NR==2{print $5" used, "$4" free"}')"
  echo
  echo '## containers'
  docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | sort
  echo
  echo '## image digests'
  docker images --digests --format '{{.Repository}}:{{.Tag}}  {{.Digest}}' | grep -v '^.*<none>' | sort | head -40
  echo
  echo '## volumes'
  docker volume ls --format '{{.Name}}  {{.Driver}}' | sort
  echo
  echo '## app definitions included'
  (cd "$WORK" && find opt/1panel/apps -type f | sort)
} > "$WORK/MANIFEST.txt" 2>/dev/null || true
[ -f /root/backups/RESTORE.md ] && cp /root/backups/RESTORE.md "$WORK/RESTORE.md" || echo 'see /root/backups/RESTORE.md' > "$WORK/RESTORE.md"

# 4) 打包 + 校验
OUT="$DEST/1panel-state-$TS.tar.gz"
tar czf "$OUT" -C "$WORK" .
sha256sum "$OUT" > "$OUT.sha256"
chmod 600 "$OUT" "$OUT.sha256"
gzip -t "$OUT"
V="$WORK/verify"; mkdir -p "$V"; tar xzf "$OUT" -C "$V"
for f in opt/1panel/db/agent.db MANIFEST.txt; do
  [ -f "$V/$f" ] || { echo "MISSING in archive: $f" >&2; exit 1; }
done
python3 -c 'import sqlite3,sys; print("  db integrity_check:", sqlite3.connect(sys.argv[1]).execute("pragma integrity_check").fetchone()[0])' "$V/opt/1panel/db/agent.db"
echo "  verified: $(tar tzf "$OUT" | wc -l) entries, $(du -h "$OUT" | cut -f1), sha256 $(cut -d' ' -f1 "$OUT.sha256" | cut -c1-16)…"

ls -1t "$DEST"/1panel-state-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old" "$old.sha256"; echo "  pruned $(basename "$old")"; done
echo "  kept $(ls -1 "$DEST"/1panel-state-*.tar.gz | wc -l)/$KEEP 份"
