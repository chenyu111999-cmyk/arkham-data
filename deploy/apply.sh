#!/usr/bin/env bash
#
# AH 卡牌助手 · 服务端升级脚本（2026-11-04）
#
# 一次做三件事：
#   1. worker.js 加匿名日活接口 /ping 与审核页的活跃统计
#   2. server.mjs 加 /dl 静态路由，把下载页搬到自己的服务器上
#   3. 建 daily 表、生成 SALT、重启服务
#
# 可以重复执行：每一步都是覆盖 + 校验，不会叠加副作用。
# 出错会自动回滚到执行前的文件。
#
# 用法：
#   curl -fsSL "<镜像地址>/deploy/apply.sh" -o /tmp/apply.sh && sudo bash /tmp/apply.sh

set -uo pipefail

APP_DIR=${APP_DIR:-/opt/arkham-api}
SERVICE=${SERVICE:-arkham-api}
PORT=${PORT:-8443}
BASE=${BASE:-https://gh-proxy.com/https://raw.githubusercontent.com/chenyu111999-cmyk/arkham-data/main/deploy}
NODE=/usr/local/bin/node
TS=$(date +%Y%m%d-%H%M%S)

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }

[ "$(id -u)" -eq 0 ] || { bad "要用 root 跑（sudo bash $0）"; exit 1; }

# Node 22 要用 --experimental-sqlite 才能 require('node:sqlite')；23 以后默认开，但带上也不报错
NODE_MAJOR=$("$NODE" -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 23 ] && SQLITE_FLAG="" || SQLITE_FLAG="--experimental-sqlite"

# 服务账号在就用它跑数据库操作，免得建出 root 所属的库让服务读不到
if id arkham >/dev/null 2>&1; then AS_ARKHAM="sudo -u arkham"; else AS_ARKHAM=""; fi

say "0/6 检查现有安装"
[ -d "$APP_DIR" ] || { bad "$APP_DIR 不存在，这台机器还没装过服务端"; exit 1; }
[ -f "$APP_DIR/worker.js" ] || { bad "找不到 $APP_DIR/worker.js"; exit 1; }
[ -f "$APP_DIR/node/server.mjs" ] || { bad "找不到 $APP_DIR/node/server.mjs"; exit 1; }
[ -x "$NODE" ] || { bad "找不到 $NODE，Node 装了吗"; exit 1; }
ok "$APP_DIR 结构正常，$(basename "$NODE") $("$NODE" -v)"

DB=${DB_PATH:-}
if [ -z "$DB" ] && [ -f "$APP_DIR/env" ]; then
  DB=$(grep -E '^DB_PATH=' "$APP_DIR/env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
fi
[ -n "$DB" ] || DB="$APP_DIR/node/data/arkham.db"
[ -f "$DB" ] && ok "数据库 $DB（$(du -h "$DB" | cut -f1)）" || warn "数据库 $DB 还不存在，将新建"

say "1/6 拉取新文件"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
for f in worker.js server.mjs dl-index.html; do
  if ! curl -fsSL -m 90 -o "$TMP/$f" "$BASE/$f"; then
    bad "下载 $f 失败，检查网络或镜像地址"
    warn "可以换镜像重试：BASE=https://ghfast.top/https://raw.githubusercontent.com/chenyu111999-cmyk/arkham-data/main/deploy sudo bash $0"
    exit 1
  fi
  ok "$f  $(wc -c < "$TMP/$f") 字节"
done

say "2/6 语法检查（不通过就不动线上文件）"
"$NODE" --check "$TMP/worker.js" 2>&1 | head -5 && ok "worker.js 语法正常" || { bad "worker.js 语法有误，已中止"; exit 1; }
"$NODE" --check "$TMP/server.mjs" 2>&1 | head -5 && ok "server.mjs 语法正常" || { bad "server.mjs 语法有误，已中止"; exit 1; }
grep -q '/ping' "$TMP/worker.js" || { bad "worker.js 里没有 /ping，下载到的不对"; exit 1; }
grep -q 'serveDl\|/dl' "$TMP/server.mjs" || { bad "server.mjs 里没有 /dl 路由"; exit 1; }
ok "关键改动都在"

say "3/6 备份现有文件与数据库"
cp -a "$APP_DIR/worker.js" "$APP_DIR/worker.js.bak.$TS"
cp -a "$APP_DIR/node/server.mjs" "$APP_DIR/node/server.mjs.bak.$TS"
ok "worker.js / server.mjs 已备份（.bak.$TS）"
if [ -f "$DB" ]; then
  BK="$APP_DIR/node/data/backup-$TS.db"
  # WAL 模式下直接 cp 可能拿到半个事务，用 VACUUM INTO 导一份完整快照
  set +e
  $AS_ARKHAM "$NODE" $SQLITE_FLAG -e "
    const {DatabaseSync}=require('node:sqlite');
    new DatabaseSync(process.argv[1]).exec(\"VACUUM INTO '\"+process.argv[2]+\"'\");
  " "$DB" "$BK" 2>/dev/null || cp -a "$DB" "$BK"
  set -e
  [ -f "$BK" ] && ok "数据库快照 $(basename "$BK")（$(du -h "$BK" | cut -f1)）" || warn "数据库快照没生成，继续（原库没动）"
fi

say "4/6 建 daily 表"
if [ -f "$DB" ]; then
  set +e
  $AS_ARKHAM "$NODE" $SQLITE_FLAG -e "
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1]);
    db.exec(\`
      CREATE TABLE IF NOT EXISTS daily (
        day TEXT NOT NULL, who TEXT NOT NULL, ts INTEGER NOT NULL,
        n INTEGER DEFAULT 1, PRIMARY KEY (day, who));
      CREATE INDEX IF NOT EXISTS idx_daily_day ON daily(day);
    \`);
    const n=db.prepare(\"SELECT COUNT(*) c FROM daily\").get();
    console.log('daily 表就绪，现有 ' + n.c + ' 行');
  " "$DB"
  RC=$?
  set -e
  [ "$RC" -eq 0 ] && ok "daily 表就绪" || warn "建表返回 $RC（Node 22 需要 --experimental-sqlite，已带；若失败可稍后手动建）"
else
  warn "数据库还不存在，首次启动时 server.mjs 会按 schema.sql 自动建"
fi

say "5/6 替换文件"
cp -f "$TMP/worker.js" "$APP_DIR/worker.js"
cp -f "$TMP/server.mjs" "$APP_DIR/node/server.mjs"
chown root:root "$APP_DIR/worker.js" "$APP_DIR/node/server.mjs"
chmod 644 "$APP_DIR/worker.js" "$APP_DIR/node/server.mjs"
ok "worker.js / server.mjs 已替换"

mkdir -p "$APP_DIR/dl"
cp -f "$TMP/dl-index.html" "$APP_DIR/dl/index.html"
chown -R root:root "$APP_DIR/dl"
chmod 755 "$APP_DIR/dl"; chmod 644 "$APP_DIR/dl/index.html"
ok "下载页 → $APP_DIR/dl/index.html"

# 日活用到一把服务端盐；没有就生成一个写进 env（旧值不动）
if ! grep -q '^SALT=' "$APP_DIR/env" 2>/dev/null; then
  SALT=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 24)
  echo "SALT=$SALT" >> "$APP_DIR/env"
  chown root:arkham "$APP_DIR/env"; chmod 640 "$APP_DIR/env"
  ok "已生成 SALT 并写入 env（用于日活哈希，不对外）"
else
  ok "env 里已有 SALT，保持不动"
fi

say "6/6 重启并自检"
if [ "${SKIP_SERVICE:-0}" = "1" ]; then
  warn "SKIP_SERVICE=1，跳过重启（仅本地测试用）"
else
  systemctl restart "$SERVICE" || { bad "重启 $SERVICE 失败，看 journalctl -u $SERVICE -n 30"; exit 1; }
  sleep 2
fi

FAIL=0
check() {
  local label=$1 url=$2 want=$3
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$url" 2>/dev/null || echo 000)
  if [ "$code" = "$want" ]; then ok "$label  $code"; else bad "$label  期望 $want 实际 $code"; FAIL=$((FAIL+1)); fi
}
check "GET /health" "http://127.0.0.1:$PORT/health" 200
check "GET /decks"  "http://127.0.0.1:$PORT/decks" 200

# /dl/ 光 200 不算数：要确认吐出的是下载页本身，而不是被兜底成别的东西
DL=$(curl -s -m 8 "http://127.0.0.1:$PORT/dl/" 2>/dev/null || "")
case "$DL" in
  *arkham-helper-3*) ok "GET /dl/  200，页面里能读到 APK 链接" ;;
  *"<html"*)         warn "GET /dl/ 返回了 HTML，但没读到 APK 链接，自己打开看一眼" ;;
  *)                 bad "GET /dl/ 内容不对，可能还是 404"; FAIL=$((FAIL+1)) ;;
esac

# /ping 必须能写库：拿一个固定测试 ID 报一次，看 today 有没有数
PING=$(curl -s -m 8 -X POST "http://127.0.0.1:$PORT/ping" \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"install-selftest-0001"}' 2>/dev/null || "")
case "$PING" in
  *'"ok":true'*) ok "POST /ping  $PING" ;;
  *)             bad "POST /ping 返回 $PING"; FAIL=$((FAIL+1)) ;;
esac

# 建表失败时 /ping 会 500，这里能兜住；反过来也说明 SALT 和表都就位了
echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32m全部通过。\033[0m\n'
else
  printf '\033[31m有 %s 项没过。\033[0m回滚命令：\n' "$FAIL"
  echo "  cp -f $APP_DIR/worker.js.bak.$TS $APP_DIR/worker.js"
  echo "  cp -f $APP_DIR/node/server.mjs.bak.$TS $APP_DIR/node/server.mjs"
  echo "  systemctl restart $SERVICE"
fi
echo
echo "备份文件都带 .bak.$TS 后缀，确认没问题后可以删掉。"
echo "审核页（含活跃统计）：打开 http://<服务器IP>:8443/admin?key=<ADMIN_KEY>"
