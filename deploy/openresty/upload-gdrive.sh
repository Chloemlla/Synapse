#!/usr/bin/env bash
# 把 /root/backups 里「最新一批」产物传到 Google Drive
#
# 凭据：/root/.config/server-backup/gdrive.env（600，从 1Panel 的 backup_accounts.vars 取出）
#   GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REFRESH_TOKEN / GDRIVE_FOLDER
#
# 用法:
#   upload-gdrive.sh              传最新一批（云端已存在且大小一致就跳过）+ 按保留数清理云端旧件
#   upload-gdrive.sh --dry-run    只报告要传/要删什么
#   upload-gdrive.sh --list       只列云端现状
#   upload-gdrive.sh --verify=<云端文件名>   下载回本地比对 md5（验证云端副本完好）
#
# 说明：不依赖 rclone，直接用 Drive v3 REST + refresh_token；上传走 resumable 会话，
# 传完拿 Drive 返回的 size + md5Checksum 与本地比对，校验不过就报 FAIL。
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

CONFIG="${GDRIVE_CONFIG:-/root/.config/server-backup/gdrive.env}"
[ -r "$CONFIG" ] || { echo "ERROR: 读不到 $CONFIG（先用 1Panel 账号信息生成它）"; exit 1; }
MODE=daily; VF=''
for a in "$@"; do
  case "$a" in
    --dry-run) MODE=dry ;;
    --list) MODE=list ;;
    --verify=*) MODE=verify; VF="${a#--verify=}" ;;
  esac
done
python3 - "$CONFIG" "$MODE" "$VF" <<'PY'
import glob, hashlib, json, os, sys, urllib.error, urllib.parse, urllib.request

CONFIG, MODE, VERIFY = sys.argv[1], sys.argv[2], sys.argv[3]
BACKUP_DIR = os.environ.get('BACKUP_DIR', '/root/backups')
PREFIXES = ['openresty-', '1panel-state-', 'mongo-', 'redis-', 'volumes-']
# 云端每个前缀保留最新几份（和本地保留数对齐）
KEEP = {'openresty-': 3, '1panel-state-': 7, 'mongo-': 7, 'redis-': 7, 'volumes-': 7}
ART_EXT = ('.tar.gz', '.archive.gz')

cfg = {}
for line in open(CONFIG):
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, v = line.split('=', 1)
        cfg[k] = v


def log(msg):
    print(msg, flush=True)


def api(method, url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            body = r.read()
            return r.status, r.headers, (json.loads(body) if body else {})
    except urllib.error.HTTPError as e:
        return e.code, e.headers, {'error': e.read()[:400].decode('utf-8', 'replace')}


def md5_of(path, chunk=1 << 20):
    h = hashlib.md5()
    with open(path, 'rb') as fh:
        for b in iter(lambda: fh.read(chunk), b''):
            h.update(b)
    return h.hexdigest()


def base_of(name):
    for ext in ART_EXT:
        if name.endswith(ext):
            return name[: -len(ext)]
    return name


# ---- 1) token：refresh_token 换 access_token（授权码是一次性的，不需要了）----
body = urllib.parse.urlencode({
    'client_id': cfg['GDRIVE_CLIENT_ID'],
    'client_secret': cfg['GDRIVE_CLIENT_SECRET'],
    'refresh_token': cfg['GDRIVE_REFRESH_TOKEN'],
    'grant_type': 'refresh_token',
}).encode()
st, _, js = api('POST', 'https://oauth2.googleapis.com/token', body,
                {'Content-Type': 'application/x-www-form-urlencoded'})
if st != 200 or 'access_token' not in js:
    log('ERROR: 换 token 失败: %s' % js)
    sys.exit(1)
AUTH = {'Authorization': 'Bearer ' + js['access_token']}

# ---- 2) 目标目录（Drive 根下 GDRIVE_FOLDER，默认 backups）----
FOLDER = cfg.get('GDRIVE_FOLDER', 'backups')
q = "name='%s' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false" % FOLDER
st, _, js = api('GET', 'https://www.googleapis.com/drive/v3/files?fields=files(id,name)&q=' + urllib.parse.quote(q), headers=AUTH)
if js.get('files'):
    FID = js['files'][0]['id']
else:
    meta = json.dumps({'name': FOLDER, 'mimeType': 'application/vnd.google-apps.folder', 'parents': ['root']}).encode()
    st, _, js = api('POST', 'https://www.googleapis.com/drive/v3/files', meta, {**AUTH, 'Content-Type': 'application/json'})
    if st not in (200, 201):
        log('ERROR: 建目录失败: %s' % js)
        sys.exit(1)
    FID = js['id']
    log('已在 Drive 根下创建目录: %s' % FOLDER)


def remote_files():
    q = "'%s' in parents and trashed=false" % FID
    st, _, js = api('GET', 'https://www.googleapis.com/drive/v3/files?pageSize=1000&fields=files(id,name,size,md5Checksum,createdTime)&q=' + urllib.parse.quote(q), headers=AUTH)
    if st != 200:
        log('ERROR: 列目录失败: %s' % js)
        sys.exit(1)
    return js.get('files', [])


REMOTE = {f['name']: f for f in remote_files()}


def remote_summary():
    total = sum(int(f.get('size') or 0) for f in REMOTE.values())
    log('云端 %s/ 共 %d 个对象，%.1f MB' % (FOLDER, len(REMOTE), total / 1048576.0))
    for p in PREFIXES:
        arts = sorted([f['name'] for f in REMOTE.values() if f['name'].startswith(p) and f['name'].endswith(ART_EXT)])
        if arts:
            log('  %-14s %d 份，最新 %s' % (p, len(arts), arts[-1]))


if MODE == 'list':
    remote_summary()
    sys.exit(0)

# ---- 3) 下载校验（--verify=名字）----
if MODE == 'verify':
    name = os.path.basename(VERIFY)
    f = REMOTE.get(name)
    if not f:
        log('云端没有 %s' % name)
        sys.exit(1)
    st, _, body = api('GET', 'https://www.googleapis.com/drive/v3/files/%s?alt=media' % f['id'], headers=AUTH)
    if st != 200:
        log('ERROR: 下载失败: %s' % body)
        sys.exit(1)
    tmp = os.path.join('/var/tmp', 'gdrive-verify-' + name)
    with open(tmp, 'wb') as fh:
        fh.write(body)
    log('云端 %s: %d 字节 md5=%s' % (name, os.path.getsize(tmp), md5_of(tmp)))
    local = os.path.join(BACKUP_DIR, name)
    if os.path.exists(local):
        log('本地 %s: %d 字节 md5=%s' % (name, os.path.getsize(local), md5_of(local)))
        log('结论: ' + ('一致' if md5_of(tmp) == md5_of(local) else '不一致 !!'))
    os.remove(tmp)
    sys.exit(0)

# ---- 4) 选「最新一批」：每个前缀最新的一件 + 它的旁文件（.sha256/.manifest/.counts）----
wanted = []
for p in PREFIXES:
    cands = [f for f in glob.glob(os.path.join(BACKUP_DIR, p + '*')) if f.endswith(ART_EXT)]
    if not cands:
        log('WARN: 本地没有 %s* 产物' % p)
        continue
    art = sorted(cands)[-1]
    base = base_of(os.path.basename(art))
    group = glob.glob(os.path.join(BACKUP_DIR, os.path.basename(art) + '*')) + \
        glob.glob(os.path.join(BACKUP_DIR, base + '.*'))
    for f in sorted(set(group)):
        if f not in wanted:
            wanted.append(f)

log('待上传清单（%d 个文件）:' % len(wanted))
to_upload = []
for f in wanted:
    name = os.path.basename(f)
    size = os.path.getsize(f)
    r = REMOTE.get(name)
    # 幂等靠 size + md5（Drive 会返回 md5Checksum）；只比大小会在“上次传到一半”时误判
    if r and int(r.get('size') or -1) == size and r.get('md5Checksum') == md5_of(f):
        log('  skip  %-46s 云端已存在（size+md5 一致）' % name)
    else:
        if r and int(r.get('size') or -1) == size:
            log('  redo  %-46s 云端同名但 md5 不同，重传' % name)
        else:
            log('  send  %-46s %.1f MB' % (name, size / 1048576.0))
        to_upload.append(f)

if MODE == 'dry' or not to_upload:
    if to_upload and MODE == 'dry':
        log('(dry-run，不实际上传)')
    remote_summary()
    sys.exit(0)

# ---- 5) 上传：resumable 会话 + 整文件一个 PUT，传完用 size/md5 复核 ----
ok = 0
fail = 0
for f in to_upload:
    name = os.path.basename(f)
    meta = json.dumps({'name': name, 'parents': [FID]}).encode()
    st, hd, js = api('POST', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
                     meta, {**AUTH, 'Content-Type': 'application/json'})
    loc = hd.get('Location') if hasattr(hd, 'get') else None
    if st not in (200, 201) or not loc:
        log('  FAIL %s: 会话创建失败 %s %s' % (name, st, js))
        fail += 1
        continue
    with open(f, 'rb') as fh:
        payload = fh.read()
    req = urllib.request.Request(loc, data=payload, method='PUT')
    req.add_header('Content-Length', str(len(payload)))
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            res = json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        log('  FAIL %s: 上传失败 %s %s' % (name, e.code, e.read()[:200]))
        fail += 1
        continue
    lmd5 = md5_of(f)
    rsize = int(res.get('size') or -1)
    if rsize == os.path.getsize(f) and res.get('md5Checksum') == lmd5:
        log('  ok   %-46s %d 字节 md5 一致' % (name, rsize))
        ok += 1
        REMOTE[name] = {'id': res.get('id'), 'name': name, 'size': str(rsize), 'md5Checksum': lmd5}
    else:
        log('  FAIL %s: 校验不过 云端 %s 字节 md5=%s / 本地 %s 字节 md5=%s'
            % (name, rsize, res.get('md5Checksum'), os.path.getsize(f), lmd5))
        fail += 1

# ---- 6) 云端保留：每个前缀只留最新 KEEP 份（连带旁文件一起删）----
REMOTE = {f['name']: f for f in remote_files()}
deleted = 0
for p, k in KEEP.items():
    arts = sorted([f for f in REMOTE.values() if f['name'].startswith(p) and f['name'].endswith(ART_EXT)],
                  key=lambda f: f['name'], reverse=True)
    for old in arts[k:]:
        base = base_of(old['name'])
        victims = [f for f in REMOTE.values() if f['name'] == old['name'] or f['name'].startswith(base + '.')]
        for v in victims:
            st, _, js = api('DELETE', 'https://www.googleapis.com/drive/v3/files/%s' % v['id'], headers=AUTH)
            if st in (200, 204):
                deleted += 1
                log('  del   %s（%s 只保留 %d 份）' % (v['name'], p, k))
            else:
                log('  WARN 删除 %s 失败: %s' % (v['name'], js))

log('上传完成: ok=%d fail=%d 云端删除=%d' % (ok, fail, deleted))
REMOTE = {f['name']: f for f in remote_files()}
remote_summary()
sys.exit(1 if fail else 0)
PY
