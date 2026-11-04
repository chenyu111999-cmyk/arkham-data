/**
 * 每日数据库快照（2026-11-04）。
 *
 * 放 /opt/arkham-api/backup.cjs，由 root 的 cron 每天 04:00 调一次：
 *   0 4 * * * /usr/local/bin/node --experimental-sqlite /opt/arkham-api/backup.cjs >> /var/log/arkham-backup.log 2>&1
 *
 * 用 VACUUM INTO 而不是 cp：库跑在 WAL 模式下，直接复制 .db 可能拿到半个事务，
 * 恢复时看着能用、实际缺数据。VACUUM INTO 导出的是完整一致快照。
 *
 * 只留最近 7 份，避免把 40G 盘塞满（现在库才几十 KB，但投稿会慢慢涨）。
 */
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const DIR = "/opt/arkham-api/node/data";
const DB = process.env.DB_PATH || path.join(DIR, "arkham.db");

// 按北京时间算文件名，跟审核页的「今日」对齐，不会出现早上 8 点前的快照算到前一天
const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
const out = path.join(DIR, `backup-${day}.db`);

if (!fs.existsSync(DB)) {
  console.log(new Date().toISOString(), "skip: no db at", DB);
  process.exit(1);
}

// 同一天重复跑（手动补一次）时先删旧的，VACUUM INTO 要求目标不存在
if (fs.existsSync(out)) fs.unlinkSync(out);

try {
  const db = new DatabaseSync(DB);
  db.exec(`VACUUM INTO '${out}'`);
  db.close();
} catch (e) {
  console.log(new Date().toISOString(), "fail:", e.message);
  process.exit(1);
}

const size = fs.statSync(out).size;

const old = fs
  .readdirSync(DIR)
  // 也管 apply.sh 留下的 backup-YYYYMMDD-HHMMSS.db，否则每跑一次部署脚本就多一个
  .filter((f) => /^backup-\d{8}(-\d{6})?\.db$/.test(f))
  .sort();
while (old.length > 7) {
  const victim = old.shift();
  try {
    fs.unlinkSync(path.join(DIR, victim));
  } catch (e) {
    console.log("cannot remove", victim, e.message);
  }
}

console.log(new Date().toISOString(), "ok", path.basename(out), size + "B", "kept", old.length);
