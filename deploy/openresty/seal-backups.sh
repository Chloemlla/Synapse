#!/usr/bin/env bash
#
# 备份产物的 age 加密（存量迁移 + 以后每批都做）
#
# 为什么必须做：备份里是站点私钥、WAF 密钥、1Panel 数据库、全量业务数据。明文躺在盘上时
# 唯一的保护就是 600 权限——磁盘快照被拷走、机器被拿走就全露；传到云盘同理（Drive 只有服务端
# 加密，不是端到端）。所以统一就地加密成 <file>.age：
#   * 加密：归档（*.tar.gz / *.archive.gz）、清单（*.manifest.txt / *.counts.txt）、证书历史（cert-*.pem）
#   * 不加密：*.sha256 —— 它只是哈希，留明文才能在“不解密”的前提下校验密文完整性
#   * 私钥（AGE_IDENTITY）只在“解密回环校验”和恢复时用；没有私钥就不动明文，
#     宁可不加密，也不留一份自己没法验证的密文
#
# 用法：
#   seal-backups.sh --all                 迁移：把目录里所有明文产物就地加密（幂等，可重复跑）
#   seal-backups.sh <文件>...             只处理指定文件（备份脚本落盘后调它）
#   seal-backups.sh --check               只报告明文/密文现状，不改动
#   seal-backups.sh --all --simulate      演习：只打印会做什么
#   seal-backups.sh --verify-all          用（临时拷上来的）离线私钥逐份验证：密文 sha256 + 完整解密
#
# 私钥是可选的：只要公钥就能加密。**本机没有私钥时照常加密**，只跳过“解密回环校验”并告警——
# 不能因为私钥离线就退回明文备份。要验证历史密文，拿离线私钥跑一次 --verify-all。
#
# 配置项（CLI 参数 > 环境变量 > 配置文件 > 默认值；缺关键项时交互终端会问，非交互终端报错并说明该传什么）：
#   --recipient   AGE_RECIPIENT   age 公钥（age1...），默认取配置文件里的
#   --identity    AGE_IDENTITY    age 私钥路径，默认取配置文件里的
#   --dir         BACKUP_DIR      备份目录，默认 /root/backups
#   --config      BACKUP_CFG      配置文件，默认 /root/.config/server-backup/gdrive.env
#   --ask                        把这些配置逐项问一遍（回车接受默认值）
#   --verbose     VERBOSE=1      打印执行的命令
#   --quiet                       只报错误
#
# 坑：
#   * age 是“非对称”的：只有公钥能加密，私钥才能解密。公钥可以到处放，私钥丢了 = 历史备份全废，
#     所以要离线存一份（例如 F:\sshkey\age-key.txt）。
#   * 私钥不在本机时（推荐状态）：加密照旧，但备份脚本的“回环校验”降成结构校验；
#     隔段时间用离线私钥临时挂上跑一次 `seal-backups.sh --verify-all` 找齐这个保证。
#   * 加密后恢复必须先解密：restore.sh 会自动做（需 AGE_IDENTITY），或手动 age -d -i <key>。
#   * 别把 .sha256 一起加密，否则校验密文就得先有私钥，等于白加。
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# ---------------------------------------------------------------------------
# 配置：CLI 参数 > 环境变量 > 配置文件 > 默认值；非交互终端下缺项直接报错
# ---------------------------------------------------------------------------
ROOT=/root/backups
POS=()
MODE=batch            # batch(默认给文件) / all / check
SIMULATE=0
ASK=0
VERBOSE=${VERBOSE:-0}
QUIET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --all) MODE=all ;;
    --check) MODE=check ;;
    --verify-all|--verify) MODE=verify ;;
    --simulate|--dry-run) SIMULATE=1 ;;
    --ask) ASK=1 ;;
    --verbose) VERBOSE=1 ;;
    --quiet) QUIET=0; QUIET=1 ;;
    --recipient) AGE_RECIPIENT="${2:-}"; shift ;;
    --identity) AGE_IDENTITY="${2:-}"; shift ;;
    --dir) ROOT="${2:-}"; shift ;;
    --config) BACKUP_CFG="${2:-}"; shift ;;
    --recipient=*) AGE_RECIPIENT="${1#*=}" ;;
    --identity=*) AGE_IDENTITY="${1#*=}" ;;
    --dir=*) ROOT="${1#*=}" ;;
    --config=*) BACKUP_CFG="${1#*=}" ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    -*) echo "错误: 不认识的参数 $1" >&2; exit 2 ;;
    *) POS+=("$1") ;;
  esac
  shift
done

BACKUP_CFG="${BACKUP_CFG:-/root/.config/server-backup/gdrive.env}"
AGE_IDENTITY="${AGE_IDENTITY:-${AGE_IDENTITY_ENV:-}}"

log()  { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }
step() { [ "$QUIET" = 1 ] || printf '[seal] %s\n' "$*"; }
warn() { printf '提示: %s\n' "$*" >&2; }
die()  { printf '错误: %s\n' "$*" >&2; exit 1; }
run()  { [ "$VERBOSE" = 1 ] && printf '      CMD> %s\n' "$*"; [ "$SIMULATE" = 1 ] && return 0; "$@"; }

# 配置文件就是 KEY=VALUE，读进来当默认值（不覆盖已给的 CLI/env）
if [ -r "$BACKUP_CFG" ]; then
  # shellcheck disable=SC1090
  set -a; . "$BACKUP_CFG"; set +a
fi
AGE_RECIPIENT="${AGE_RECIPIENT:-}"

can_ask() { [ "$ASK" = 1 ] || { [ -t 0 ] && [ -t 1 ]; }; }

ask_one() { # 变量名 说明 默认值 是否敏感
  local var="$1" label="$2" def="${3:-}" secret="${4:-no}" cur ans
  cur="$(eval "printf '%s' \"\${$var:-}\"")"
  [ -n "$cur" ] && return 0
  printf '  %s%s: ' "$label" "${def:+（回车用 $def）}" >&2
  if [ "$secret" = yes ]; then read -rs ans; printf '\n' >&2; else read -r ans || true; fi
  [ -z "$ans" ] && ans="$def"
  printf -v "$var" '%s' "$ans"
}

if [ "$ASK" = 1 ] && can_ask; then
  log '配置（回车接受中括号里的默认值）:'
  ask_one AGE_RECIPIENT 'age 公钥' "$AGE_RECIPIENT"
  ask_one AGE_IDENTITY  'age 私钥路径' "$AGE_IDENTITY"
  ask_one ROOT          '备份目录' "$ROOT"
fi

command -v age >/dev/null 2>&1 || die '本机没有 age（apt install age / scoop install age）'

[ -n "$AGE_RECIPIENT" ] || die "没给公钥：用 --recipient age1... 或环境变量 AGE_RECIPIENT，或在 $BACKUP_CFG 里写 AGE_RECIPIENT"
case "$AGE_RECIPIENT" in age1*) ;; *) die "公钥格式不对（应以 age1 开头）: $AGE_RECIPIENT" ;; esac

# 私钥是**可选**的：加密只需要公钥。有私钥就做“解密回环校验”（最强保证），没有则跳过
# （备份仍然加密、不会退回明文），但要告警 + 说明怎么补验。
HAVE_ID=0
if [ -n "$AGE_IDENTITY" ]; then
  [ -r "$AGE_IDENTITY" ] || die "私钥读不到: $AGE_IDENTITY"
  [ "$(age-keygen -y "$AGE_IDENTITY" 2>/dev/null)" = "$AGE_RECIPIENT" ] \
    || die "私钥与公钥不匹配（私钥推出的公钥是 $(age-keygen -y "$AGE_IDENTITY" 2>/dev/null)）"
  HAVE_ID=1
fi
if [ "$HAVE_ID" = 0 ]; then
  warn "本机没有私钥（AGE_IDENTITY）：加密照旧，但跳过了“解密回环校验”；要验证历史密文，拿离线私钥跑一次 seal-backups.sh --verify-all"
fi

# 需要加密的文件类型；.sha256 故意不在里面
is_sensitive() {
  case "$(basename "$1")" in
    *.tar.gz|*.archive.gz|*.manifest.txt|*.counts.txt) return 0 ;;
    cert-*.pem) return 0 ;;
    *) return 1 ;;
  esac
}

seal_one() { # 加密一个文件（幂等：已是 .age 就跳过）
  local f="$1"
  [ -f "$f" ] || return 0
  case "$f" in *.age) return 0 ;; esac
  is_sensitive "$f" || return 0
  local out="$f.age" tmp
  if [ -f "$out" ]; then
    step "跳过（密文已存在）: $(basename "$f")"
    run rm -f "$f" "$f.sha256"
    return 0
  fi
  tmp="$(mktemp -p "$(dirname "$f")" .sealing.XXXXXX)"
  step "加密 $(basename "$f") → $(basename "$out")"
  run age -r "$AGE_RECIPIENT" -o "$tmp" "$f"
  if [ "$SIMULATE" = 0 ]; then
    if [ "$HAVE_ID" = 1 ]; then
      # 回环校验：解回来必须与原文逐字节相同，否则不删明文
      if ! age -d -i "$AGE_IDENTITY" "$tmp" 2>/dev/null | cmp -s - "$f"; then
        rm -f "$tmp"; die "解密回环校验失败，已保留明文: $f"
      fi
    else
      # 没私钥：只做结构校验（age v1 头 + 非空）；密文完整性另有 .sha256 兜底
      if [ ! -s "$tmp" ] || [ "$(head -c 21 "$tmp")" != 'age-encryption.org/v1' ]; then
        rm -f "$tmp"; die "age 产物头不对（或为空），已保留明文: $f"
      fi
    fi
    chmod 600 "$tmp"
    mv "$tmp" "$out"
    rm -f "$f" "$f.sha256"
    sha256sum "$out" | sed "s|$ROOT/||" > "$out.sha256"
    chmod 600 "$out" "$out.sha256"
  else
    rm -f "$tmp"
  fi
}

verify_all() { # 需要私钥：逐份“验密文 sha256 + 完整解密一遍”
  [ "$HAVE_ID" = 1 ] || die "--verify-all 需要私钥：把离线那份拷上来，用 --identity <age-key.txt> 或 AGE_IDENTITY=... 跑一次"
  local n=0 ok=0 bad=0 f
  for f in "$ROOT"/*.age; do
    [ -f "$f" ] || continue
    n=$((n + 1))
    if [ -f "$f.sha256" ] && ! ( cd "$ROOT" && sha256sum -c "$(basename "$f").sha256" >/dev/null 2>&1 ); then
      bad=$((bad + 1)); printf '  密文 sha256 不过: %s\n' "$(basename "$f")"; continue
    fi
    if age -d -i "$AGE_IDENTITY" "$f" 2>/dev/null | wc -c > /dev/null; then ok=$((ok + 1)); else bad=$((bad + 1)); printf '  解密失败: %s\n' "$(basename "$f")"; fi
  done
  log "验证完成：$n 份（成功 $ok / 失败 $bad）"
  [ "$bad" = 0 ] || exit 1
}

# ---------------------------------------------------------------------------
# 三种模式
# ---------------------------------------------------------------------------
case "$MODE" in
  batch)
    [ "${#POS[@]}" -gt 0 ] || die '用法: seal-backups.sh <文件>... | --all | --check'
    for f in "${POS[@]}"; do seal_one "$f"; done
    ;;
  verify)
    verify_all
    ;;
  all)
    mapfile -t files < <(find "$ROOT" -maxdepth 1 -type f \
      \( -name '*.tar.gz' -o -name '*.archive.gz' -o -name '*.manifest.txt' -o -name '*.counts.txt' -o -name 'cert-*.pem' \) | sort)
    step "明文待加密 ${#files[@]} 个${SIMULATE:+（演习）}"
    for f in "${files[@]}"; do seal_one "$f"; done
    ;;
  check)
    plain=$(find "$ROOT" -maxdepth 1 -type f \( -name '*.tar.gz' -o -name '*.archive.gz' -o -name '*.manifest.txt' -o -name '*.counts.txt' -o -name 'cert-*.pem' \) | wc -l)
    sealed=$(find "$ROOT" -maxdepth 1 -type f -name '*.age' | wc -l)
    log "明文 $plain 个 / 密文 $sealed 个（目录 $(du -sh "$ROOT" | cut -f1)）"
    [ "$plain" = 0 ] || { log '仍为明文的文件（前 10）:'; find "$ROOT" -maxdepth 1 -type f \( -name '*.tar.gz' -o -name '*.archive.gz' -o -name '*.manifest.txt' -o -name '*.counts.txt' -o -name 'cert-*.pem' \) | head -10 | sed 's|^|  |'; }
    ;;
esac

if [ "$MODE" != check ]; then
  sealed=$(find "$ROOT" -maxdepth 1 -type f -name '*.age' | wc -l)
  step "完成：目录内密文 $sealed 个，总计 $(du -sh "$ROOT" | cut -f1)"
fi
