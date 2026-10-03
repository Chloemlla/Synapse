#!/usr/bin/env bash
# 用授权码换 refresh_token（Google OAuth 2.0）——本地或服务器都能跑，只需 bash + curl
#
# 背景：refresh_token 只在「授权码换 token」这一步返回，且是**一次性**的：
#   * 授权码一次性、约 10 分钟过期，用过就废（1Panel 点过「获取」就等于用掉了）
#   * redirect_uri 必须与生成授权码时用的那个字符串**完全一致**（本项目用 https://localhost:8080）
#   * 同一个 客户端+用户+scope 只在「首次授权」返回 refresh_token，所以要带
#     access_type=offline&prompt=consent（--print-auth-url 已经带上了）
#
# 用法:
#   ./gdrive-token-helper.sh                     # 交互式（密钥/授权码不回显）
#   GDRIVE_CLIENT_ID=... GDRIVE_CLIENT_SECRET=... CODE='4/0A...' ./gdrive-token-helper.sh
#   GDRIVE_CLIENT_ID=... ./gdrive-token-helper.sh --print-auth-url     # 只打印授权 URL
#   ... ./gdrive-token-helper.sh --write=./gdrive.env   # 直接写成 600 的 gdrive.env
#   ... ./gdrive-token-helper.sh --stdout-env           # 只打印 gdrive.env 格式的 4 行
set -euo pipefail

REDIRECT_URI="${REDIRECT_URI:-https://localhost:8080}"
SCOPE="${SCOPE:-https://www.googleapis.com/auth/drive}"
MODE=exchange
OUTFILE=''
for a in "$@"; do
  case "$a" in
    --print-auth-url) MODE=url ;;
    --write=*) MODE=write; OUTFILE="${a#--write=}" ;;
    --stdout-env) MODE=env ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
  esac
done

need() { # 变量名 提示 是否敏感
  local var="$1" prompt="$2" secret="${3:-no}" cur v
  cur="$(eval "printf '%s' \"\${$var:-}\"")"
  [ -n "$cur" ] && return 0
  printf '%s: ' "$prompt" >&2
  if [ "$secret" = yes ]; then read -rs v; printf '\n' >&2; else read -r v; fi
  printf -v "$var" '%s' "$v"
}

need GDRIVE_CLIENT_ID '客户端 ID' no
if [ "$MODE" = url ]; then
  printf '%s\n' "https://accounts.google.com/o/oauth2/v2/auth?client_id=${GDRIVE_CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=${SCOPE}&access_type=offline&prompt=consent"
  exit 0
fi
need GDRIVE_CLIENT_SECRET '客户端密钥' yes
need CODE '授权码（浏览器地址栏 code= 后面那串）' yes

# 密钥/授权码只走 stdin（--data @-），不进 argv、不会出现在 ps 里
BODY=$(printf 'client_id=%s&client_secret=%s&code=%s&grant_type=authorization_code&redirect_uri=%s' \
  "$GDRIVE_CLIENT_ID" "$GDRIVE_CLIENT_SECRET" "$CODE" "$REDIRECT_URI")
RESP=$(printf '%s' "$BODY" | curl -sS -X POST \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data @- https://oauth2.googleapis.com/token)
unset BODY

grab() { printf '%s' "$RESP" | grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed 's/.*:[[:space:]]*"//; s/"$//'; }

ERR=$(grab error)
if [ -n "$ERR" ]; then
  echo "换 token 失败: $ERR" >&2
  echo "  error_description: $(grab error_description)" >&2
  case "$ERR" in
    invalid_grant) echo "  提示：授权码已用过 / 超过 10 分钟 / redirect_uri 与申请时不一致（当前 $REDIRECT_URI）。用 --print-auth-url 重新拿一个 code。" >&2 ;;
    redirect_uri_mismatch) echo "  提示：这个 redirect_uri 没在 OAuth 客户端里登记，或与申请时不一致。" >&2 ;;
    invalid_client) echo "  提示：client_id / client_secret 不匹配，或客户端类型不对（要 Web 或桌面应用）。" >&2 ;;
    *) echo "  提示：检查 client_secret / code 是否带了空格或换行。" >&2 ;;
  esac
  exit 1
fi

AT=$(grab access_token)
RT=$(grab refresh_token)
EI=$(grab expires_in)
SC=$(grab scope)
[ -n "$AT" ] || { echo "没拿到 access_token，原始响应：$RESP" >&2; exit 1; }

echo "access_token: ${AT:0:12}…（${EI:-?} 秒后过期）"
echo "scope: ${SC:-?}"
if [ -z "$RT" ]; then
  cat >&2 <<'EOF'
⚠️ 这次没返回 refresh_token：同一个 客户端+用户+scope 只在首次授权返回。
   解决：授权 URL 必须带 access_type=offline&prompt=consent（--print-auth-url 已带），
   并先去 https://myaccount.google.com/permissions 撤销该应用的授权，再重新授权一次。
EOF
  exit 2
fi
echo "refresh_token: $RT"

ENV_BLOCK=$(printf 'GDRIVE_CLIENT_ID=%s\nGDRIVE_CLIENT_SECRET=%s\nGDRIVE_REFRESH_TOKEN=%s\nGDRIVE_FOLDER=%s\n' \
  "$GDRIVE_CLIENT_ID" "$GDRIVE_CLIENT_SECRET" "$RT" "${GDRIVE_FOLDER:-backups}")

case "$MODE" in
  env)
    printf '%s' "$ENV_BLOCK"
    ;;
  write)
    ( umask 077; printf '%s' "$ENV_BLOCK" > "$OUTFILE" )
    chmod 600 "$OUTFILE"
    echo "已写入 $OUTFILE（600）"
    echo "下一步：把它放到服务器 /root/.config/server-backup/gdrive.env（或直接覆盖同名文件）"
    ;;
  *)
    echo
    echo "把这 4 行写进服务器的 /root/.config/server-backup/gdrive.env 即可："
    printf '%s' "$ENV_BLOCK"
    ;;
esac
