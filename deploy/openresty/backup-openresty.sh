#!/usr/bin/env bash
# OpenResty（1Panel 托管）接入层备份：只存「重建这一层需要的东西」
#   - 站点/全局配置、证书、维护页、WAF 自定义配置、容器定义
#   - 不存日志（log/）与构建产物（build/）
# 用法: /root/backups/openresty-backup.sh [保留份数=5]
set -euo pipefail

KEEP="${1:-5}"
TS=$(date +%Y%m%d-%H%M%S)
DEST=/root/backups/openresty
WORK=$(mktemp -d /tmp/openresty-backup.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$DEST"
chmod 700 "$DEST"

# ---------- 1) 清单：以后能知道这份备份是哪台机、哪个镜像、哪版配置 ----------
IMG=$(docker inspect openresty --format '{{.Image}}')
{
  echo "# openresty backup manifest"
  echo "generated_at=$(date -Iseconds)"
  echo "hostname=$(hostname)"
  echo "kernel=$(uname -r)"
  echo "image_ref=$(docker inspect openresty --format '{{.Config.Image}}')"
  echo "image_id=$IMG"
  echo "repo_digest=$(docker image inspect "$IMG" --format '{{join .RepoDigests " "}}' 2>/dev/null || echo unknown)"
  echo "network_mode=$(docker inspect openresty --format '{{.HostConfig.NetworkMode}}')"
  echo "restart_policy=$(docker inspect openresty --format '{{.HostConfig.RestartPolicy.Name}}')"
  echo
  echo '## nginx -V'
  docker exec openresty nginx -V 2>&1 || true
  echo
  echo '## nginx -t（备份时刻的配置自检）'
  docker exec openresty nginx -t 2>&1 || true
  echo
  echo '## 监听端口'
  ss -ltnH | awk '{print $4}' | sort -u
  echo
  echo '## 站点证书'
  for f in /opt/1panel/www/sites/*/ssl/fullchain.pem; do
    [ -f "$f" ] || continue
    printf '%s  ' "$(basename "$(dirname "$(dirname "$f")")")"
    openssl x509 -in "$f" -noout -enddate -subject 2>/dev/null | tr '\n' ' '
    echo
  done
  echo
  echo '## 配置/页面文件 md5'
  find /opt/1panel/www/conf.d /opt/1panel/www/maintenance /opt/1panel/apps/openresty/openresty/conf \
       -type f 2>/dev/null | sort | xargs -r md5sum
  find /opt/1panel/www/sites -type f \( -name '*.conf' -o -name '*.html' \) 2>/dev/null | sort | xargs -r md5sum
} > "$WORK/MANIFEST.txt" 2>/dev/null || true
if [ -f /root/backups/RESTORE.md ]; then cp /root/backups/RESTORE.md "$WORK/RESTORE.md"; else echo "see /root/backups/RESTORE.md" > "$WORK/RESTORE.md"; fi

# ---------- 2) 打包（relpath 子 /，所以恢复就是 tar xzf ... -C /） ----------
OUT="$DEST/openresty-$TS.tar.gz"
tar czf "$OUT" \
  --exclude='*/log' --exclude='*/log/*' --exclude='*.log' \
  -C "$WORK" MANIFEST.txt RESTORE.md \
  -C / \
  opt/1panel/apps/openresty/openresty/docker-compose.yml \
  opt/1panel/apps/openresty/openresty/data.yml \
  opt/1panel/apps/openresty/openresty/conf \
  opt/1panel/apps/openresty/openresty/root \
  opt/1panel/apps/openresty/openresty/scripts \
  opt/1panel/apps/openresty/openresty/1pwaf/data \
  opt/1panel/www/conf.d \
  opt/1panel/www/stream.d \
  opt/1panel/www/maintenance \
  opt/1panel/www/sites

sha256sum "$OUT" > "$OUT.sha256"
chmod 600 "$OUT" "$OUT.sha256"   # 里面有 ssl 私钥，不能对其他人可读

# ---------- 3) 当场校验，不是“存了就算” ----------
gzip -t "$OUT"
mkdir -p "$WORK/x"
tar xzf "$OUT" -C "$WORK/x"
bad=0
for f in opt/1panel/www/maintenance/maintenance.html \
         opt/1panel/www/sites/tts.chloemlla.com/proxy/root.conf \
         opt/1panel/apps/openresty/openresty/conf/nginx.conf \
         opt/1panel/www/conf.d/tts.chloemlla.com.conf; do
  if cmp -s "/$f" "$WORK/x/$f"; then echo "  ok   $f"; else echo "  DIFF $f"; bad=1; fi
done
[ "$bad" = 0 ] || { echo '备份内容与线上不一致，已保留文件待查' >&2; exit 1; }

# ---------- 4) 保留最近 KEEP 份 ----------
ls -1t "$DEST"/openresty-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  rm -f "$old" "$old.sha256"
  echo "  pruned $(basename "$old")"
done

echo
echo "archive : $OUT"
echo "size    : $(du -h "$OUT" | cut -f1)  files: $(tar tzf "$OUT" | wc -l)"
echo "sha256  : $(cut -d' ' -f1 "$OUT.sha256")"
echo "kept    : $(ls -1 "$DEST"/openresty-*.tar.gz | wc -l)/$KEEP 份"
