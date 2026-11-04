-- AH 卡牌助手 · 社区牌组服务 v2
-- 在 Cloudflare D1 控制台的 Console 里整段执行一次即可

CREATE TABLE IF NOT EXISTS decks (
  id         TEXT PRIMARY KEY,          -- ahc-xxxx
  name       TEXT NOT NULL,
  inv        TEXT NOT NULL,             -- 调查员 code，如 01001
  code       TEXT NOT NULL,             -- AHC1 牌组码
  code_hash  TEXT NOT NULL,             -- sha256(code) 前 16 位，用于去重
  device_id  TEXT,                      -- 投稿设备（限流用，不含个人信息）
  by         TEXT,                      -- 投稿人昵称，可为空
  note       TEXT,                      -- 一句话思路
  xp         INTEGER DEFAULT 0,
  tags       TEXT DEFAULT '',           -- 逗号分隔
  src        TEXT DEFAULT 'ahc',        -- ahc = 玩家投稿，arkhamdb = 参考牌组
  ref_likes  INTEGER DEFAULT 0,         -- ArkhamDB 原赞数，仅参考牌组有
  status     INTEGER DEFAULT 0,         -- 0 待审 1 上架 2 拒绝 3 下架
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  deck_id   TEXT    NOT NULL,
  device_id TEXT    NOT NULL,
  ts        INTEGER NOT NULL,
  PRIMARY KEY (deck_id, device_id)      -- 一台设备一套牌只能一票
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_decks_hash    ON decks(code_hash);
CREATE INDEX        IF NOT EXISTS idx_decks_status  ON decks(status);
CREATE INDEX        IF NOT EXISTS idx_decks_created ON decks(created_at);
CREATE INDEX        IF NOT EXISTS idx_decks_device  ON decks(device_id, created_at);
CREATE INDEX        IF NOT EXISTS idx_votes_deck    ON votes(deck_id);
CREATE INDEX        IF NOT EXISTS idx_votes_ts      ON votes(ts);

-- 匿名日活（v3.40.0 新增）
-- 只存 sha256(deviceId | day | SALT) 前 16 位，不存 deviceId、不存 IP。
-- 盐里带日期，所以同一个 who 只在那一天有效，跨天无法关联到同一台设备。
CREATE TABLE IF NOT EXISTS daily (
  day TEXT    NOT NULL,                 -- YYYY-MM-DD（UTC+8）
  who TEXT    NOT NULL,                 -- 当天有效的设备哈希
  ts  INTEGER NOT NULL,                 -- 最后一次上报时间
  n   INTEGER DEFAULT 1,                -- 当天打开次数
  PRIMARY KEY (day, who)
);

CREATE INDEX IF NOT EXISTS idx_daily_day ON daily(day);
