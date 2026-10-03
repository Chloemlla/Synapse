#!/usr/bin/env bash
# 自助：Google 授权码 → refresh_token（并把 gdrive.env 写好、自检一遍）
#
# 本地 Windows(Git Bash) 和 Linux(服务器) 都能跑，依赖只有 bash + curl。
#
# 用法：
#   ./gdrive-selfservice-token.sh                # 全交互：浏览器授权 → 粘 code → 出 refresh_token
#   CODE='4/0A...' ./gdrive-selfservice-token.sh # code 也可以用环境变量给（非交互，失败即退）
#   OUT=/path/gdrive.env ./gdrive-selfservice-token.sh
#
# 会自动从这些地方找 client_id/client_secret（找到就不问）：
#   1) 环境变量 GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET
#   2) $OUT（默认 ./gdrive.env）
#   3) /root/.config/server-backup/gdrive.env
#
# 常见坑：
#   invalid_grant            → code 已用过（例如 1Panel 点过「获取」）/ 超过 10 分钟 / redirect_uri 不一致
#   redirect_uri_mismatch    → 该 redirect_uri 没登记在 OAuth 客户端里，或与申请时不一致
#   invalid_client           → client_id/secret 不匹配，或客户端类型不对
#   成功但没 refresh_token    → 不是首次授权：授权 URL 要带 prompt=consent&access_type=offline，
#                              并先去 https://myaccount.google.com/permissions 撤销授权后重来
set -euo pipefail

REDIRECT_URI="${REDIRECT_URI:-https://localhost:8080}"
SCOPE="${SCOPE:-https://www.googleapis.com/auth/drive}"
OUT="${OUT:-./gdrive.env}"
FOLDER="${GDRIVE_FOLDER:-backups}"
OPEN="${OPEN:-yes}"          # 是否尝试自动打开浏览器
VERIFY="${VERIFY:-yes}"      # 换完是否用 refresh_token 再换一次并查 Drive 自检

say() { printf '%s\n' "$*" >&2; }

load_env_file() {
  local f="$1"
  [ -r "$f" ] || return 1
  set -a
  # shellcheck disable=SC1090
  . "$f"
  set +a
}

ask() { # 变量名 提示 是否敏感
  local var="$1" prompt="$2" secret="${3:-no}" cur v
  cur="$(eval "printf '%s' \"\${$var:-}\"")"
  [ -n "$cur" ] && return 0
  printf '%s' "$prompt" >&2
  if [ "$secret" = yes ]; then
    read -rs v || { printf '\n' >&2; return 1; }
    printf '\n' >&2
  else
    read -r v || return 1
  fi
  printf -v "$var" '%s' "$v"
}

json_str() { # 从 $1(JSON) 取字段 $2
  printf '%s' "$1" | grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//'
}

token_post() { # 请求体走 stdin，密钥不进 argv/ps
  printf '%s' "$1" | curl -sS -X POST -H 'Content-Type: application/x-www-form-urlencoded' \
    --data @- https://oauth2.googleapis.com/token || true
}

open_url() {
  [ "$OPEN" = yes ] || return 0
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 && return 0; fi
  if command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1 && return 0; fi
  if command -v cmd.exe >/dev/null 2>&1; then cmd.exe /c start "" "$1" >/dev/null 2>&1 && return 0; fi
  return 0
}

# ---------- 1) 取凭据 ----------
[ -n "${GDRIVE_CLIENT_ID:-}" ] || load_env_file "$OUT" || true
[ -n "${GDRIVE_CLIENT_ID:-}" ] || load_env_file /root/.config/server-backup/gdrive.env || true
say '== Google Drive 授权（授权码 → refresh_token）=='
ask GDRIVE_CLIENT_ID '客户端 ID: '
ask GDRIVE_CLIENT_SECRET '客户端密钥（不回显）: ' yes

# ---------- 2) 打印/打开授权 URL ----------
URL="https://accounts.google.com/o/oauth2/v2/auth?client_id=${GDRIVE_CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=${SCOPE}&access_type=offline&prompt=consent"
echo
say "授权 URL（已尝试打开浏览器；如未打开请手动复制）："
say "$URL"
open_url "$URL"
echo
say "在浏览器里点「允许」后，会跳到 ${REDIRECT_URI}/?code=... —— 页面打不开是正常的，"
say "请从地址栏把 code= 后面那一整串复制出来（含 4/0A 开头部分，到 & 或行尾之前）。"
echo

# ---------- 3) 换 token（交互式可重试；CODE 由环境变量给时失败即退） ----------
INTERACTIVE=yes
[ -n "${CODE:-}" ] && INTERACTIVE=no
RT=''
ATTEMPTS=0
while :; do
  ATTEMPTS=$((ATTEMPTS + 1))
  # 授权码是一次性短串，可见地输入（方便确认没粘漏）；client_secret 才静默
  if ! ask CODE '授权码（回车取消）: ' no; then say '没读到输入，已取消'; exit 1; fi
  if [ -z "${CODE:-}" ]; then say '已取消'; exit 1; fi
  # code 里可能带换行/空格，清一下
  CODE="$(printf '%s' "$CODE" | tr -d '[:space:]')"

  RESP="$(token_post "client_id=${GDRIVE_CLIENT_ID}&client_secret=${GDRIVE_CLIENT_SECRET}&code=${CODE}&grant_type=authorization_code&redirect_uri=${REDIRECT_URI}")"
  ERR="$(json_str "$RESP" error)"
  if [ -n "$ERR" ]; then
    echo
    say "失败: $ERR — $(json_str "$RESP" error_description)"
    case "$ERR" in
      invalid_grant) say '  授权码是一次性的、约 10 分钟过期；你手里这个可能已被用掉 → 重新打开上面的授权 URL 拿新的 code。' ;;
      redirect_uri_mismatch) say "  这个 redirect_uri 没登记在 OAuth 客户端里（当前 $REDIRECT_URI）。" ;;
      invalid_client) say '  client_id / client_secret 不对，或客户端类型不是 Web/桌面应用。' ;;
      *) say '  检查 secret / code 有没有多余空格或换行。' ;;
    esac
    echo
    if [ "$INTERACTIVE" = yes ]; then
      say "再试一次？（第 $ATTEMPTS 次失败）"
      unset CODE
      continue
    fi
    exit 1
  fi

  RT="$(json_str "$RESP" refresh_token)"
  AT="$(json_str "$RESP" access_token)"
  if [ -z "$AT" ]; then say "响应异常: $RESP"; exit 1; fi
  if [ -n "$RT" ]; then break; fi
  cat >&2 <<'EOF'

⚠️ 这次没有返回 refresh_token：同一个「客户端+用户+scope」只在首次授权时返回。
   处理：先去 https://myaccount.google.com/permissions 撤销该应用的授权，
   再打开授权 URL 重新授权（本脚本的 URL 已带 access_type=offline&prompt=consent）。
EOF
  [ "$INTERACTIVE" = yes ] || exit 2
  say '撤销后重新授权，把新的 code 贴进来：'
  unset CODE
done

echo
echo "refresh_token: $RT"

# ---------- 4) 自检：用 refresh_token 再换一次，并读 Drive 账号/配额 ----------
if [ "$VERIFY" = yes ]; then
  say '— 自检：用 refresh_token 换 access_token 并查 Drive —'
  R2="$(token_post "client_id=${GDRIVE_CLIENT_ID}&client_secret=${GDRIVE_CLIENT_SECRET}&refresh_token=${RT}&grant_type=refresh_token")"
  AT2="$(json_str "$R2" access_token)"
  if [ -z "$AT2" ]; then
    say "  自检失败: $(json_str "$R2" error) $(json_str "$R2" error_description)"
    say '  （refresh_token 已打印在上面，但请先确认它能用再替换线上的）'
  else
    ABOUT="$(curl -sS -H "Authorization: Bearer $AT2" \
      'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota(limit,usage)' || true)"
    EMAIL="$(json_str "$ABOUT" emailAddress)"
    LIMIT="$(printf '%s' "$ABOUT" | grep -o '"limit"[[:space:]]*:[[:space:]]*"[0-9]*"' | head -1 | grep -o '[0-9]*')"
    USAGE="$(printf '%s' "$ABOUT" | grep -o '"usage"[[:space:]]*:[[:space:]]*"[0-9]*"' | head -1 | grep -o '[0-9]*')"
    say "  自检通过：账号 ${EMAIL:-?}，盘 $(awk -v l="${LIMIT:-0}" 'BEGIN{printf "%.1f", l/1099511627776}')TB，已用 $(awk -v u="${USAGE:-0}" 'BEGIN{printf "%.2f", u/1073741824}')GB"
  fi
fi

# ---------- 5) 落盘（600） ----------
BLOCK="$(printf 'GDRIVE_CLIENT_ID=%s\nGDRIVE_CLIENT_SECRET=%s\nGDRIVE_REFRESH_TOKEN=%s\nGDRIVE_FOLDER=%s\n' \
  "$GDRIVE_CLIENT_ID" "$GDRIVE_CLIENT_SECRET" "$RT" "$FOLDER")"
echo
if [ -n "$OUT" ]; then
  ( umask 077; printf '%s' "$BLOCK" > "$OUT" )
  chmod 600 "$OUT" 2>/dev/null || true
  say "已写好 $OUT（600）"
fi
echo '--- 下面这 4 行就是 gdrive.env 内容 ---'
printf '%s' "$BLOCK"
echo '------------------------------------'
say '服务器上放这里：/root/.config/server-backup/gdrive.env（chmod 600），'
say '改完不用重启任何服务，下一次 upload-gdrive.sh 运行就会读到。'
