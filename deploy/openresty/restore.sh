#!/usr/bin/env bash
#
# 备份恢复（本地 /root/backups 里的 age 密文 → 线上，或先安全地解到别处看）
#
# 为什么这么设计：
#   * 备份现在是 age 加密的（seal-backups.sh），恢复必须解密 → 需要私钥（AGE_IDENTITY）；
#   * 恢复是破坏性操作：默认什么都不动，破坏性动作要 --yes；动线上前先自动留一份“恢复前快照”，
#     openresty 改坏了会自动回滚；
#   * 能先验就别直接上：check 看完整性、extract 解到别处看内容、mongo --into-temp 起临时库演练。
#
# 用法：
#   restore.sh list [--cloud]                 看有哪些备份（本地/云端）
#   restore.sh check <文件|openresty|mongo|...>   校验完整性（.sha256；.age 会解密回环比一次）
#   restore.sh extract <文件> <目录>           解到指定目录看内容（不碰线上，支持 .age）
#   restore.sh decrypt <文件.age> [输出路径]    只解密
#   restore.sh openresty [文件] --yes          恢复接入层配置（解包 → nginx -t → reload）
#   restore.sh panel [文件] --yes              恢复 1Panel 状态（停面板 → 还原 DB/secret → 启动）
#   restore.sh mongo [文件] [--into-temp|--into-live] --yes
#   restore.sh redis [文件] --yes              恢复 Redis 快照并重启
#   restore.sh volumes [文件] --yes            恢复容器挂载数据（bind mount / 具名卷）
#   restore.sh cert <站点> --yes               证书回滚（从 cert-<站点>-*.pem.age 历史里选）
#
# 全部命令都支持 --simulate：只打印准备做什么，一个字都不动。
#
# 配置项（CLI 参数 > 环境变量 > 默认值；缺关键项且是交互终端会问你，非交互则报错并说明该传什么）：
#   --identity   AGE_IDENTITY    age 私钥路径（解密用；默认读 /root/.config/server-backup/gdrive.env）
#   --dir        BACKUP_DIR      备份目录，默认 /root/backups
#   --config     BACKUP_CFG      配置文件，默认 /root/.config/server-backup/gdrive.env
#   --yes                         破坏性操作免确认（非交互环境必给）
#   --simulate                    演习：只打印计划
#   --ask                         把配置逐项问一遍（回车接受默认值）
#   --verbose                     打印执行的命令
#
# 坑：
#   * 私钥不在服务器时：先 scp 上来用一次，用完删掉（age-key.txt 只在解密时需要）。
#   * mongo 灌回线上前必须确认容器 nofile >= 64000（否则建索引阶段 WT_PANIC 崩），脚本会拦。
#   * cert 回滚是从本地证书历史里挑最新一份，不是从归档还原。
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ROOT="${BACKUP_DIR:-/root/backups}"
YES=0; SIMULATE=0; ASK=0; VERBOSE=${VERBOSE:-0}; CLOUD=0
POS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) YES=1 ;;
    --simulate|--dry-run) SIMULATE=1 ;;
    --ask) ASK=1 ;;
    --verbose) VERBOSE=1 ;;
    --cloud) CLOUD=1 ;;
    --into-temp) MODE=mongo_temp ;;
    --into-live) MODE=mongo_live ;;
    --identity) AGE_IDENTITY="${2:-}"; shift ;;
    --identity=*) AGE_IDENTITY="${1#*=}" ;;
    --dir) ROOT="${2:-}"; shift ;;
    --dir=*) ROOT="${1#*=}" ;;
    --config) BACKUP_CFG="${2:-}"; shift ;;
    --config=*) BACKUP_CFG="${1#*=}" ;;
    -h|--help) sed -n '2,42p' "$0"; exit 0 ;;
    -*) printf '错误: 不认识的参数 %s\n' "$1" >&2; exit 2 ;;
    *) POS+=("$1") ;;
  esac
  shift
done
MODE="${MODE:-auto}"
BACKUP_CFG="${BACKUP_CFG:-/root/.config/server-backup/gdrive.env}"
AGE_IDENTITY="${AGE_IDENTITY:-}"
[ -r "$BACKUP_CFG" ] && { set -a; . "$BACKUP_CFG"; set +a; } || true
AGE_IDENTITY="${AGE_IDENTITY:-}"
CONTAINER_OR="${CONTAINER_OR:-openresty}"

CMD="${POS[0]:-help}"
[ -d "$ROOT" ] || die "备份目录不存在: $ROOT"
TS=$(date +%Y%m%d-%H%M%S)
SAFEDIR="$ROOT/pre-restore-$TS"

log()  { printf '[restore] %s\n' "$*"; }
warn() { printf '提示: %s\n' "$*" >&2; }
die()  { printf '错误: %s\n' "$*" >&2; exit 1; }
run()  { [ "$VERBOSE" = 1 ] && printf '      CMD> %s\n' "$*"; [ "$SIMULATE" = 1 ] && return 0; "$@"; }

can_ask() { [ "$ASK" = 1 ] || { [ -t 0 ] && [ -t 1 ]; }; }
ask_one() {
  local var="$1" label="$2" def="${3:-}" secret="${4:-no}" cur ans
  cur="$(eval "printf '%s' \"\${$var:-}\"")"; [ -n "$cur" ] && return 0
  printf '  %s%s: ' "$label" "${def:+（回车用 $def）}" >&2
  if [ "$secret" = yes ]; then read -rs ans; printf '\n' >&2; else read -r ans || true; fi
  [ -z "$ans" ] && ans="$def"
  printf -v "$var" '%s' "$ans"
}

# --ask：把配置逐项问一遍（回车接受默认值）；非交互环境下不问，缺关键项由各命令自己报错并说明该传什么
if [ "$ASK" = 1 ] && can_ask; then
  printf '配置（回车接受中括号里的默认值）:\n' >&2
  ask_one AGE_IDENTITY 'age 私钥路径（解密用，可留空）' "$AGE_IDENTITY"
  ask_one ROOT         '备份目录' "$ROOT"
fi

confirm() { # 说明
  [ "$SIMULATE" = 1 ] && { log "  [simulate] 跳过确认：$1"; return 0; }
  [ "$YES" = 1 ] && { log "  [--yes] 已确认：$1"; return 0; }
  [ -t 0 ] || die "非交互环境，破坏性操作需要在命令行显式加 --yes（$1）"
  printf '%s\n执行吗？输入 yes 继续：' "$1" >&2
  local a; read -r a || true
  [ "$a" = yes ] || die '已取消'
}

need_identity() {
  [ -n "$AGE_IDENTITY" ] || die '需要私钥才能解密：--identity <age-key.txt> 或 AGE_IDENTITY=...（离线那份拷上来用完就删）'
  [ -r "$AGE_IDENTITY" ] || die "私钥读不到: $AGE_IDENTITY"
}
plain() { # 文件 → 明文路径（.age 则解密到临时目录）
  local f="$1"
  case "$f" in
    *.age)
      need_identity
      local out; out="$(mktemp -d)/$(basename "${f%.age}")"
      age -d -i "$AGE_IDENTITY" -o "$out" "$f" || die "解密失败（私钥不匹配？）: $f"
      printf '%s' "$out" ;;
    *) printf '%s' "$f" ;;
  esac
}
resolve() { # 通配 → 最新一个文件（默认排除 .sha256）
  local pat="$1"
  local f
  f="$(ls -1t "$ROOT"/$pat 2>/dev/null | grep -vE '\.sha256$' | head -1)" || true
  [ -n "$f" ] || die "本地找不到匹配 $pat 的备份（先看 restore.sh list）"
  printf '%s' "$f"
}
resolve_or_given() { # [$1=用户给的文件] $2=通配
  local given="${POS[1]:-}"
  if [ -n "$given" ]; then
    [ -f "$given" ] && { printf '%s' "$given"; return; }
    [ -f "$ROOT/$given" ] && { printf '%s' "$ROOT/$given"; return; }
    die "找不到文件: $given"
  fi
  resolve "$2"
}
verify_stored() { # 校验“存储态”文件的完整性（.age 的 .sha256 是密文哈希）
  local f="$1" side="$f.sha256"
  if [ -f "$side" ]; then
    if ( cd "$(dirname "$side")" && sha256sum -c "$(basename "$side")" >/dev/null 2>&1 ); then
      log "  完整性 OK（$(basename "$side")）"
    else
      warn "校验失败: $side —— 先人工确认再往下走"
    fi
  else
    warn '没有 .sha256 旁文件，跳过完整性校验'
  fi
}
pretend_snapshot() { # 名称 路径...
  local name="$1"; shift
  if [ "$SIMULATE" = 1 ]; then log "  [simulate] 会先把现状备份到 $SAFEDIR/$name.tar.gz"; return 0; fi
  mkdir -p "$SAFEDIR"
  tar czf "$SAFEDIR/$name.tar.gz" -C / "$@" 2>/dev/null && log "  已留后路: $SAFEDIR/$name.tar.gz"
}

# ---------------------------------------------------------------------------
case "$CMD" in

list)
  log "本地 $ROOT:"
  for p in 'openresty-*' '1panel-state-*' 'mongo-*' 'redis-*' 'volumes-*' 'cert-*'; do
    ls -1t "$ROOT"/$p 2>/dev/null | grep -vE '\.sha256$|\.manifest\.txt' | head -3 | sed "s|^$ROOT/|  |" || true
  done
  log "$(find "$ROOT" -maxdepth 1 -type f -name '*.age' | wc -l) 个密文 / $(du -sh "$ROOT" | cut -f1)"
  if [ "$CLOUD" = 1 ]; then
    log '云端（Google Drive）:'
    run "$ROOT/upload-gdrive.sh" --list
  fi
  ;;

check)
  f="$(resolve_or_given "${POS[1]:-}" "${POS[2]:-*}")"
  log "文件: $f  ($(du -h "$f" | cut -f1))"
  verify_stored "$f"
  case "$f" in
    *.age)
      if [ -n "$AGE_IDENTITY" ] && [ -r "$AGE_IDENTITY" ]; then
        p="$(plain "$f")"
        case "$p" in
          *.tar.gz) tar tzf "$p" >/dev/null && log '  解密+解包 OK（归档结构可读）' ;;
          *.archive.gz) gzip -t "$p" && log '  解密 OK（mongodump 归档，内容请用 mongo --into-temp 演练）' ;;
          *) log '  解密 OK' ;;
        esac
        rm -rf "$(dirname "$p")"
      else
        warn '本机没有私钥，只能校验密文完整性（解不开）'
      fi ;;
  esac
  ;;

extract)
  f="${POS[1]:-}"; d="${POS[2]:-}"
  [ -n "$f" ] && [ -n "$d" ] || die '用法: restore.sh extract <文件> <目录>'
  [ -f "$f" ] || f="$ROOT/$f"
  [ -f "$f" ] || die "找不到 $f"
  p="$(plain "$f")"
  case "$p" in
    *.tar.gz) mkdir -p "$d"; tar xzf "$p" -C "$d"; log "已解到 $d（$(find "$d" -type f | wc -l) 个文件；没碰线上）" ;;
    *.archive.gz) die 'mongodump 归档不能直接解包；用 restore.sh mongo --into-temp 演练' ;;
    *) die "不认识的归档类型: $p" ;;
  esac
  ;;

decrypt)
  f="${POS[1]:-}"; out="${POS[2]:-}"
  [ -n "$f" ] || die '用法: restore.sh decrypt <文件.age> [输出路径]'
  [ -f "$f" ] || f="$ROOT/$f"
  need_identity
  [ -n "$out" ] || out="./$(basename "${f%.age}")"
  run age -d -i "$AGE_IDENTITY" -o "$out" "$f"
  log "已解密到 $out"
  ;;

openresty)
  f="$(resolve_or_given "${POS[1]:-}" 'openresty-*.tar.gz*')"
  log "恢复接入层配置：$f"
  verify_stored "$f"
  p="$(plain "$f")"
  if [ "$SIMULATE" = 0 ]; then tar tzf "$p" >/dev/null || die '归档损坏'; fi
  confirm '用该归档覆盖 /opt/1panel/www 与 openresty 配置，然后 nginx reload'
  pretend_snapshot pre-openresty opt/1panel/www opt/1panel/apps/openresty/openresty/conf
  run tar xzf "$p" -C /
  if [ "$SIMULATE" = 1 ]; then log '  [simulate] 会执行 nginx -t 与 reload'; exit 0; fi
  if docker exec "$CONTAINER_OR" nginx -t; then
    docker exec "$CONTAINER_OR" nginx -s reload
    for h in chloemlla.com tts.chloemlla.com; do
      printf '  %-22s %s\n' "$h" "$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$h":443:127.0.0.1 "https://$h/" || echo fail)"
    done
  else
    warn 'nginx -t 失败 → 自动回滚'
    tar xzf "$SAFEDIR/pre-openresty.tar.gz" -C /
    docker exec "$CONTAINER_OR" nginx -t && docker exec "$CONTAINER_OR" nginx -s reload || true
    die '新配置有问题，已回滚到恢复前状态'
  fi
  ;;

panel)
  f="$(resolve_or_given "${POS[1]:-}" '1panel-state-*.tar.gz*')"
  log "恢复 1Panel 状态：$f"
  verify_stored "$f"
  p="$(plain "$f")"
  confirm '停止 1Panel（core+agent）→ 覆盖 /opt/1panel/db 与 secret → 启动'
  pretend_snapshot pre-panel opt/1panel/db opt/1panel/secret
  if [ "$SIMULATE" = 1 ]; then log '  [simulate] 会停面板、还原 db/secret、再启动'; exit 0; fi
  tmp="$(mktemp -d)"; tar xzf "$p" -C "$tmp"
  [ -d "$tmp/opt/1panel/db" ] || die '归档里没有 opt/1panel/db'
  1pctl stop core >/dev/null 2>&1 || true
  1pctl stop agent >/dev/null 2>&1 || true
  cp -a "$tmp/opt/1panel/db/." /opt/1panel/db/
  [ -d "$tmp/opt/1panel/secret" ] && cp -a "$tmp/opt/1panel/secret/." /opt/1panel/secret/
  1pctl start all >/dev/null 2>&1 || true
  sleep 5
  log "  面板: $(1pctl status core 2>/dev/null | head -1)"
  log "  端口: $(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:25150/ || echo 连不上)"
  rm -rf "$tmp"
  ;;

mongo)
  f="$(resolve_or_given "${POS[1]:-}" 'mongo-*.archive.gz*')"
  [ "$MODE" = auto ] && MODE=mongo_temp
  log "恢复 MongoDB（$MODE）：$f"
  [ -f "$f" ] || die "找不到 $f"
  p="$(plain "$f")"
  if [ "$SIMULATE" = 0 ]; then gzip -t "$p" || die '不是合法 gzip'; fi
  MU=$(docker inspect mongodb --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^MONGO_INITDB_ROOT_USERNAME=//p')
  MP=$(docker inspect mongodb --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^MONGO_INITDB_ROOT_PASSWORD=//p')
  [ -n "$MU" ] && [ -n "$MP" ] || die '拿不到 Mongo root 凭据（容器 env 里没有 MONGO_INITDB_ROOT_*）'

  if [ "$MODE" = mongo_temp ]; then
    log '  演练模式：临时 mongod 灌一份，不碰线上'
    DC=mongo-restore-drill; DIR=/var/tmp/mongo-restore-drill
    IMG=$(docker inspect mongodb --format '{{.Config.Image}}')
    if [ "$SIMULATE" = 1 ]; then log "  [simulate] 会用 $IMG 起 27099，mongorestore 后逐库打印计数，再删掉"; exit 0; fi
    docker rm -f "$DC" >/dev/null 2>&1 || true; rm -rf "$DIR"; mkdir -p "$DIR"
    docker run -d --name "$DC" --network none --ulimit nofile=64000:64000 \
      --memory 1500m --memory-swap 1500m -v "$DIR":/data/db "$IMG" \
      --port 27099 --wiredTigerCacheSizeGB 0.25 >/dev/null
    up=0; for _ in $(seq 1 40); do docker exec "$DC" mongosh --quiet --port 27099 --eval 'db.adminCommand({ping:1})' >/dev/null 2>&1 && { up=1; break; }; sleep 1; done
    [ "$up" = 1 ] || { docker logs --tail 5 "$DC" 2>&1 | sed 's/^/    /'; docker rm -f "$DC" >/dev/null; die '临时 mongod 没起来'; }
    docker exec -i "$DC" mongorestore --port 27099 --gzip --archive --drop < "$p" | tail -2 | sed 's/^/    /'
    docker exec "$DC" mongosh --quiet --port 27099 --eval 'db.adminCommand({listDatabases:1}).databases.forEach(d=>{const s=db.getSiblingDB(d.name).stats(); print("    "+d.name+"  coll="+s.collections+"  docs="+s.objects)})'
    docker rm -f "$DC" >/dev/null 2>&1 || true; rm -rf "$DIR"
    log '  演练完成，线上未改动'
    exit 0
  fi

  nofile=$(docker exec mongodb sh -c 'ulimit -n')
  log "  线上 mongod nofile=$nofile（需 >=64000，否则建索引会 WT_PANIC 崩）"
  if [ "$SIMULATE" = 0 ]; then [ "$nofile" -ge 64000 ] 2>/dev/null || die '请先把 mongodb 容器 nofile 提到 64000（compose 加 ulimits.nofile 并重建容器）'; fi
  confirm '--drop 同名集合地灌回线上 Mongo（脚本会先自动做一份当前快照）'
  log '  先做当前快照（后路）…'
  if [ "$SIMULATE" = 0 ]; then "$ROOT/backup-mongo.sh" 7 | tail -2 | sed 's/^/    /'; fi
  if [ "$SIMULATE" = 0 ]; then
    docker exec -i -e MU="$MU" -e MP="$MP" mongodb sh -c 'mongorestore --host 127.0.0.1 --port 27017 -u "$MU" -p "$MP" --authenticationDatabase admin --gzip --archive --drop' < "$p" | tail -3 | sed 's/^/    /'
    docker exec -e MU="$MU" -e MP="$MP" mongodb sh -c 'mongosh --quiet --host 127.0.0.1 -u "$MU" -p "$MP" --authenticationDatabase admin --eval "print(\"  ping=\"+db.adminCommand({ping:1}).ok)"' | sed 's/^/  /'
  fi
  ;;

redis)
  f="$(resolve_or_given "${POS[1]:-}" 'redis-*.tar.gz*')"
  log "恢复 Redis：$f"
  verify_stored "$f"
  p="$(plain "$f")"
  confirm '覆盖 Redis 的 dump.rdb/redis.conf 并重启 redis'
  pretend_snapshot pre-redis opt/1panel/apps/redis/redis/data opt/1panel/apps/redis/redis/conf
  run tar xzf "$p" -C /
  if [ "$SIMULATE" = 1 ]; then log '  [simulate] 会 docker restart redis 并打印 dbsize'; exit 0; fi
  docker restart redis >/dev/null && log '  已重启 redis'
  sleep 2
  RP=$(docker inspect redis --format '{{json .Config.Cmd}}' | python3 -c 'import json,sys
a=json.load(sys.stdin) or []
print(a[a.index("--requirepass")+1] if "--requirepass" in a else "")')
  docker exec -e RP="${RP:-x}" redis sh -c 'if [ -n "$RP" ]; then redis-cli -a "$RP" --no-auth-warning dbsize; else redis-cli dbsize; fi' 2>/dev/null | sed 's/^/  dbsize=/'
  ;;

volumes)
  f="$(resolve_or_given "${POS[1]:-}" 'volumes-*.tar.gz*')"
  log "恢复容器挂载数据：$f"
  p="$(plain "$f")"
  if [ "$SIMULATE" = 0 ]; then tar tzf "$p" >/dev/null || die '归档损坏'; fi
  log '  归档里的顶层路径（前 8 条）:'
  if [ "$SIMULATE" = 0 ]; then tar tzf "$p" | awk -F/ 'NF>2{print $1"/"$2"/"$3}' | sort -u | head -8 | sed 's/^/    /'; fi
  confirm '把上面的路径覆盖回原位（bind mount 直接生效；具名卷需先 docker volume create）'
  run tar xzf "$p" -C /
  if [ "$SIMULATE" = 1 ]; then log '  [simulate] 会重启 alist（含 SQLite 的容器）'; exit 0; fi
  if docker inspect alist >/dev/null 2>&1; then docker restart alist >/dev/null && log '  已重启 alist'; fi
  ;;

cert)
  site="${POS[1]:-}"; [ -n "$site" ] || die '用法: restore.sh cert <站点> --yes'
  dir="/opt/1panel/www/sites/$site/ssl"
  [ -d "$dir" ] || die "站点目录不存在: $dir"
  fc="$(ls -1t "$ROOT"/cert-"$site"-fullchain-* 2>/dev/null | head -1)" || true
  pk="$(ls -1t "$ROOT"/cert-"$site"-privkey-* 2>/dev/null | head -1)" || true
  [ -n "$fc" ] || die "没有 $site 的证书历史（cert-$site-fullchain-*）"
  log "现在线上: $(openssl x509 -in "$dir/fullchain.pem" -noout -enddate 2>/dev/null || echo 读不到)"
  log "将回滚到: $(basename "$fc")"
  confirm "覆盖 $dir/{fullchain,privkey}.pem 并 nginx reload"
  if [ "$SIMULATE" = 0 ]; then
    pfc="$(plain "$fc")"; ppk=""; [ -n "$pk" ] && ppk="$(plain "$pk")"
    mkdir -p "$SAFEDIR"; cp -a "$dir" "$SAFEDIR/ssl-$site"
    cp -a "$pfc" "$dir/fullchain.pem"; [ -n "$ppk" ] && cp -a "$ppk" "$dir/privkey.pem"
  fi
  run docker exec "$CONTAINER_OR" nginx -t
  run docker exec "$CONTAINER_OR" nginx -s reload
  if [ "$SIMULATE" = 0 ]; then
    printf '  握手校验: '
    echo | openssl s_client -servername "$site" -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null || warn '校验失败'
  fi
  ;;

help|*) sed -n '2,42p' "$0" ;;
esac
