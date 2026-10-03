<#
自助：Google 授权码 → refresh_token（并写好 gdrive.env、自检一遍）

Windows 上用这个（PowerShell 原生，不依赖 Git Bash）：
    pwsh .\gdrive-selfservice-token.ps1
    .\gdrive-selfservice-token.ps1                     # Windows PowerShell 5.1 也可以
    $env:CODE='4/0A...'; .\gdrive-selfservice-token.ps1   # code 用环境变量给（非交互）

可选参数：
    -Out .\gdrive.env       输出文件（默认 .\gdrive.env）
    -RedirectUri ...        默认 https://localhost:8080（必须与 OAuth 客户端登记一致）
    -Folder backups         gdrive.env 里的 GDRIVE_FOLDER
    -NoOpen                 不要自动开浏览器
    -NoVerify               换完不做 Drive 自检

Linux / Git Bash 用同目录的 gdrive-selfservice-token.sh（功能一样）。

常见坑：
  invalid_grant          code 已用过（例如 1Panel 点过「获取」）/ 超过 10 分钟 / redirect_uri 不一致
  redirect_uri_mismatch  该 redirect_uri 没登记在 OAuth 客户端里
  invalid_client         client_id/secret 不对，或客户端类型不对
  成功但没 refresh_token  不是首次授权：先去 https://myaccount.google.com/permissions 撤销授权再重来
#>
[CmdletBinding()]
param(
    [string]$Out = ".\gdrive.env",
    [string]$RedirectUri = "https://localhost:8080",
    [string]$Scope = "https://www.googleapis.com/auth/drive",
    [string]$Folder = "backups",
    [switch]$NoOpen,
    [switch]$NoVerify
)

$ErrorActionPreference = 'Stop'
$TokenUri = 'https://oauth2.googleapis.com/token'

function Say([string]$m) { Write-Host $m }

function Import-EnvFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    Get-Content -LiteralPath $path | ForEach-Object {
        if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
        $k, $v = $_ -split '=', 2
        Set-Variable -Name $k.Trim() -Value $v.Trim() -Scope Global -Force
    }
}

function Get-ErrorJson($err) {
    # Invoke-RestMethod 抛错时，响应体在 ErrorDetails.Message 里（可能是 JSON）
    $raw = $null
    if ($err.ErrorDetails) { $raw = $err.ErrorDetails.Message }
    if (-not $raw -and $err.Exception.Response) {
        try {
            $sr = New-Object System.IO.StreamReader($err.Exception.Response.GetResponseStream())
            $raw = $sr.ReadToEnd()
        } catch { }
    }
    if ($raw) { try { return ($raw | ConvertFrom-Json) } catch { return $null } }
    return $null
}

function Invoke-TokenRequest([hashtable]$Body) {
    try {
        return @{ ok = $true; data = (Invoke-RestMethod -Method Post -Uri $TokenUri -Body $Body -ContentType 'application/x-www-form-urlencoded') }
    } catch {
        return @{ ok = $false; err = (Get-ErrorJson $_) }
    }
}

# ---------- 1) 凭据：环境变量 > $Out > 服务器那个文件 ----------
if (-not $env:GDRIVE_CLIENT_ID -and -not $global:GDRIVE_CLIENT_ID) { Import-EnvFile $Out }
if (-not $env:GDRIVE_CLIENT_ID -and -not $global:GDRIVE_CLIENT_ID -and (Test-Path '/root/.config/server-backup/gdrive.env')) {
    Import-EnvFile '/root/.config/server-backup/gdrive.env'   # 本地一般不存在，会直接跳过
}
$clientId = if ($env:GDRIVE_CLIENT_ID) { $env:GDRIVE_CLIENT_ID } else { $global:GDRIVE_CLIENT_ID }
$clientSecret = if ($env:GDRIVE_CLIENT_SECRET) { $env:GDRIVE_CLIENT_SECRET } else { $global:GDRIVE_CLIENT_SECRET }
$code = $env:CODE

Say '== Google Drive 授权（授权码 → refresh_token）=='

if (-not $clientId) { $clientId = Read-Host '客户端 ID' }
if (-not $clientSecret) {
    $sec = Read-Host '客户端密钥（不回显）' -AsSecureString
    $clientSecret = [System.Net.NetworkCredential]::new('', $sec).Password
}
if (-not $clientId -or -not $clientSecret) { Say '缺少 client_id / client_secret'; exit 1 }

# ---------- 2) 授权 URL ----------
$url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id={0}&redirect_uri={1}&response_type=code&scope={2}&access_type=offline&prompt=consent' -f `
    $clientId, [uri]::EscapeDataString($RedirectUri), [uri]::EscapeDataString($Scope)
Write-Host ''
Say '授权 URL（已尝试打开浏览器；如未打开请手动复制）：'
Say $url
if (-not $NoOpen) {
    try { Start-Process $url | Out-Null } catch { }
}
Write-Host ''
Say "在浏览器里点「允许」后，会跳到 $RedirectUri/?code=... —— 页面打不开是正常的，"
Say '请从地址栏把 code= 后面那一整串复制出来（4/0A 开头那串）。'
Write-Host ''

# ---------- 3) 换 token（交互式可重试） ----------
$rt = $null
$attempt = 0
while ($true) {
    $attempt++
    if (-not $code) {
        $code = Read-Host '授权码（直接回车取消）'
    }
    if ([string]::IsNullOrWhiteSpace($code)) { Say '已取消'; exit 1 }
    $code = ($code -replace '\s', '')

    $res = Invoke-TokenRequest @{
        client_id     = $clientId
        client_secret = $clientSecret
        code          = $code
        grant_type    = 'authorization_code'
        redirect_uri  = $RedirectUri
    }

    if (-not $res.ok) {
        Write-Host ''
        $e = $res.err
        if ($e) {
            Say "失败: $($e.error) — $($e.error_description)"
            switch ($e.error) {
                'invalid_grant' { Say '  授权码是一次性的、约 10 分钟过期；你手里这个可能已被用掉 → 重新打开上面的授权 URL 拿新的 code。' }
                'redirect_uri_mismatch' { Say "  这个 redirect_uri 没登记在 OAuth 客户端里（当前 $RedirectUri）。" }
                'invalid_client' { Say '  client_id / client_secret 不对，或客户端类型不是 Web/桌面应用。' }
                default { Say '  检查 secret / code 有没有多余空格或换行。' }
            }
        } else {
            Say '请求失败，但没拿到可解析的错误体。'
        }
        Write-Host ''
        if ($env:CODE) { exit 1 }        # 非交互：失败即退
        Say "再试一次？（第 $attempt 次失败）"
        $code = $null
        continue
    }

    $rt = $res.data.refresh_token
    if (-not $rt) {
        Say ''
        Say '⚠️ 这次没有返回 refresh_token：同一个「客户端+用户+scope」只在首次授权时返回。'
        Say '   处理：先去 https://myaccount.google.com/permissions 撤销该应用的授权，再重新授权。'
        if ($env:CODE) { exit 2 }
        $code = $null
        continue
    }
    break
}

Write-Host ''
Say "refresh_token: $rt"

# ---------- 4) 自检 ----------
if (-not $NoVerify) {
    Say '— 自检：用 refresh_token 换 access_token 并查 Drive —'
    $r2 = Invoke-TokenRequest @{
        client_id     = $clientId
        client_secret = $clientSecret
        refresh_token = $rt
        grant_type    = 'refresh_token'
    }
    if (-not $r2.ok) {
        Say "  自检失败: $($r2.err.error) $($r2.err.error_description)"
        Say '  （refresh_token 已打印在上面，但请先确认它能用再替换线上的）'
    } else {
        try {
            $about = Invoke-RestMethod -Uri 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota(limit,usage)' `
                -Headers @{ Authorization = "Bearer $($r2.data.access_token)" }
            $tb = [math]::Round([double]$about.storageQuota.limit / 1TB, 1)
            $gb = [math]::Round([double]$about.storageQuota.usage / 1GB, 2)
            Say "  自检通过：账号 $($about.user.emailAddress)，盘 ${tb}TB，已用 ${gb}GB"
        } catch {
            Say "  自检：token 可用但查 Drive 信息失败（$($_.Exception.Message)）"
        }
    }
}

# ---------- 5) 落盘 ----------
$block = @(
    "GDRIVE_CLIENT_ID=$clientId",
    "GDRIVE_CLIENT_SECRET=$clientSecret",
    "GDRIVE_REFRESH_TOKEN=$rt",
    "GDRIVE_FOLDER=$Folder"
) -join "`n"
Write-Host ''
if ($Out) {
    Set-Content -LiteralPath $Out -Value $block -Encoding ascii
    try {   # 尽量收紧到“只有自己能读”（等同 Linux 的 600）
        $acl = Get-Acl -LiteralPath $Out
        $acl.SetAccessRuleProtection($true, $false)
        $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
        Set-Acl -LiteralPath $Out -AclObject $acl
    } catch { Say "  （权限收紧失败，$Out 请自行确认只有自己能读）" }
    Say "已写好 $Out"
}
Write-Host '--- 下面这 4 行就是 gdrive.env 内容 ---'
Write-Host $block
Write-Host '------------------------------------'
Say '服务器上放这里：/root/.config/server-backup/gdrive.env（chmod 600），'
Say '改完不用重启任何服务，下一次 upload-gdrive.sh 运行就会读到。'
