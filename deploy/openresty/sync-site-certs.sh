#!/usr/bin/env bash
# 站点证书分发：以「覆盖指定 SAN 且到期最远」的证书为准，铺到所有站点 ssl 目录。
#
# 背景：1Panel 只管理一张证书（*.chloemlla.com + *.951100.xyz，Let's Encrypt，auto_renew=1），
# 续期时它只重写「它管理的那几个站点」的 ssl 文件；手工建的站点目录会留旧文件，
# 于是出现“部分站点在用早已过期的证书”。本脚本负责把最新证书铺开。
#
# 用法: sync-site-certs.sh [--dry-run]
# 退出码: 0 正常；1 校验失败（不 reload）；2 证书即将过期（< WARN_DAYS）
set -euo pipefail

DRY=0
[ "${1:-}" = '--dry-run' ] && DRY=1
NEED_SAN="${NEED_SAN:-*.chloemlla.com}"
WARN_DAYS="${WARN_DAYS:-21}"
SITES=/opt/1panel/www/sites
HIST=/root/backups/cert-history
CONTAINER=openresty

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
cert_san() { openssl x509 -in "$1" -noout -ext subjectAltName 2>/dev/null; }
cert_end() { openssl x509 -in "$1" -noout -enddate 2>/dev/null | cut -d= -f2; }
cert_end_ts() { date -d "$(cert_end "$1")" +%s 2>/dev/null; }
key_matches() {
  [ -f "$1" ] && [ -f "$2" ] || return 1
  a=$(openssl x509 -in "$1" -noout -pubkey 2>/dev/null | openssl md5)
  b=$(openssl pkey -in "$2" -pubout 2>/dev/null | openssl md5)
  [ -n "$a" ] && [ "$a" = "$b" ]
}

# ---- 1) 选源 ----
SRC=''
for pref in "$SITES/tts.chloemlla.com/ssl" "$SITES/cap.chloemlla.com/ssl"; do
  cand="$pref/fullchain.pem"
  [ -f "$cand" ] || continue
  if cert_san "$cand" | grep -qF "$NEED_SAN" && key_matches "$cand" "$pref/privkey.pem"; then SRC="$pref"; break; fi
done
if [ -z "$SRC" ]; then
  best=0
  for d in "$SITES"/*/ssl; do
    c="$d/fullchain.pem"
    [ -f "$c" ] || continue
    cert_san "$c" | grep -qF "$NEED_SAN" || continue
    key_matches "$c" "$d/privkey.pem" || continue
    t=$(cert_end_ts "$c" || echo 0)
    if [ "$t" -gt "$best" ]; then best="$t"; SRC="$d"; fi
  done
fi
[ -n "$SRC" ] || { log 'ERROR: 找不到覆盖 SAN 且证书/私钥匹配的源证书'; exit 1; }

END=$(cert_end "$SRC/fullchain.pem")
DAYS=$(( ( $(cert_end_ts "$SRC/fullchain.pem") - $(date +%s) ) / 86400 ))
SRC_MD5=$(md5sum "$SRC/fullchain.pem" | cut -d' ' -f1)
log "源: $SRC  notAfter=$END  剩余 ${DAYS} 天  md5=${SRC_MD5:0:8}"

# ---- 2) 铺开（只改与源不一致的站点，改前存历史） ----
changed=''
for d in "$SITES"/*/ssl; do
  [ -d "$d" ] || continue
  site=$(basename "$(dirname "$d")")
  [ "$d" = "$SRC" ] && continue
  if [ -f "$d/fullchain.pem" ] && cmp -s "$SRC/fullchain.pem" "$d/fullchain.pem" && cmp -s "$SRC/privkey.pem" "$d/privkey.pem"; then
    continue
  fi
  old_end=$(cert_end "$d/fullchain.pem" 2>/dev/null || echo 'n/a')
  if [ "$DRY" = 1 ]; then
    log "[dry-run] $site: $old_end -> $END"
  else
    mkdir -p "$HIST/$site"; ts=$(date +%Y%m%d-%H%M%S)
    [ -f "$d/fullchain.pem" ] && cp -p "$d/fullchain.pem" "$HIST/$site/fullchain-$ts.pem"
    [ -f "$d/privkey.pem" ] && cp -p "$d/privkey.pem" "$HIST/$site/privkey-$ts.pem"
    install -m 644 "$SRC/fullchain.pem" "$d/fullchain.pem"
    install -m 600 "$SRC/privkey.pem" "$d/privkey.pem"
    log "$site: $old_end -> $END"
  fi
  changed="$changed $site"
done
[ -n "$changed" ] || log '所有站点已与源一致，未改动'

# ---- 3) 校验 + reload（任一处不顺就不 reload） ----
for d in "$SITES"/*/ssl; do
  [ -d "$d" ] || continue
  site=$(basename "$(dirname "$d")")
  key_matches "$d/fullchain.pem" "$d/privkey.pem" || { log "ERROR: $site 证书/私钥不匹配"; exit 1; }
  cert_end "$d/fullchain.pem" >/dev/null || { log "ERROR: $site 证书不可解析"; exit 1; }
done

if [ "$DRY" = 0 ] && [ -n "$changed" ]; then
  docker exec $CONTAINER nginx -t >/dev/null 2>&1 || { log 'ERROR: nginx -t 失败，不 reload，现场保留'; exit 1; }
  docker exec $CONTAINER nginx -s reload
  log "已 reload nginx（变更:$changed）"
fi

# ---- 4) 过期报告 ----
rc=0
for d in "$SITES"/*/ssl; do
  [ -f "$d/fullchain.pem" ] || continue
  site=$(basename "$(dirname "$d")")
  dn=$(( ( $(cert_end_ts "$d/fullchain.pem") - $(date +%s) ) / 86400 ))
  printf '  %-30s %-28s %s 天\n' "$site" "$(cert_end "$d/fullchain.pem")" "$dn"
  if [ "$dn" -lt "$WARN_DAYS" ]; then log "WARNING: $site 证书仅剩 $dn 天"; rc=2; fi
done
exit $rc
