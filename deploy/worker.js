/**
 * AH 卡牌助手 · 社区牌组服务（v2）
 *
 * 四件事：投稿进待审、作者审核上架、全端拉取列表、投票。
 * 不存昵称以外的任何用户信息：device_id 是 App 本地随机 UUID，不取设备标识。
 *
 * 公开接口：
 *   GET  /health                     存活检查
 *   GET  /decks                      已上架牌组（含票数）
 *   GET  /votes?ids=a,b,c            批量查票数
 *   POST /vote   {deckId,deviceId,on}
 *   POST /submit {code,name,by,note,tags,deviceId}
 *
 * 管理接口（需 ?key=ADMIN_KEY）：
 *   GET  /admin                      审核页
 *   POST /admin/act  {id,act}        act = pass | reject | hide
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      const p = url.pathname;

      // HEAD 与 GET 同等对待：正文由运行时自动剥离，但状态码和响应头要一致，
      // 否则 uptime 监控（默认发 HEAD）会把正常的服务判成 404。
      const isGet = request.method === "GET" || request.method === "HEAD";

      if (p === "/" || p === "/health") {
        return json({ ok: true, service: "arkham-community", v: 2 }, cors);
      }
      if (p === "/decks" && isGet) return await listDecks(env, cors);
      if (p === "/votes" && isGet) return await listVotes(url, env, cors);
      if (p === "/vote" && request.method === "POST") return await castVote(request, env, cors);
      if (p === "/submit" && request.method === "POST") return await submitDeck(request, env, cors);

      // 匿名日活：App 每天第一次打开时报一次，只记「今天有几台设备来过」
      if (p === "/ping" && request.method === "POST") return await ping(request, env, cors);

      // ---- 管理，密钥从 URL 里带，没配 ADMIN_KEY 就直接 404，避免误开 ----
      if (p.startsWith("/admin")) {
        const key = url.searchParams.get("key") || "";
        if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
          return new Response("Not found", { status: 404 });
        }
        if (p === "/admin" && request.method === "GET") return await adminPage(url, env);
        if (p === "/admin/act" && request.method === "POST") return await adminAct(request, env);
      }

      return json({ ok: false, error: "not_found" }, cors, 404);
    } catch (e) {
      return json({ ok: false, error: "server_error", detail: String(e).slice(0, 200) }, cors, 500);
    }
  },
};

const DECK_RE = /^[A-Za-z0-9_-]{2,40}$/;

// ==================== 公开接口 ====================

async function listDecks(env, cors) {
  const rs = await env.DB.prepare(
    `SELECT d.id, d.name, d.inv, d.code, d.by, d.note, d.xp, d.tags, d.src,
            d.ref_likes, d.created_at,
            (SELECT COUNT(*) FROM votes v WHERE v.deck_id = d.id) AS votes
       FROM decks d
      WHERE d.status = 1
      ORDER BY votes DESC, d.created_at DESC
      LIMIT 500`
  ).all();

  const decks = (rs.results || []).map((r) => ({
    id: r.id,
    name: r.name,
    inv: r.inv,
    code: r.code,
    by: r.by || "",
    note: r.note || "",
    xp: r.xp || 0,
    tags: r.tags ? String(r.tags).split(",").filter(Boolean) : [],
    src: r.src || "ahc",
    refLikes: r.ref_likes || 0,
    votes: r.votes || 0,
    date: r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : "",
  }));

  return json({ ok: true, updated: Date.now(), count: decks.length, decks }, cors, 200, 60);
}

async function listVotes(url, env, cors) {
  const raw = url.searchParams.get("ids") || "";
  const ids = raw.split(",").map((s) => s.trim()).filter((s) => DECK_RE.test(s)).slice(0, 100);
  if (ids.length === 0) return json({ ok: true, counts: {} }, cors);

  const ph = ids.map(() => "?").join(",");
  const rs = await env.DB.prepare(
    `SELECT deck_id, COUNT(*) AS n FROM votes WHERE deck_id IN (${ph}) GROUP BY deck_id`
  )
    .bind(...ids)
    .all();

  const counts = {};
  for (const id of ids) counts[id] = 0;
  for (const row of rs.results || []) counts[row.deck_id] = row.n;
  return json({ ok: true, counts }, cors);
}

async function castVote(request, env, cors) {
  let body = null;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "bad_json" }, cors, 400);
  }

  const deckId = String((body && body.deckId) || "").trim();
  const device = String((body && body.deviceId) || "").trim();
  const on = !(body && body.on === false);

  if (!DECK_RE.test(deckId)) return json({ ok: false, error: "bad_deck" }, cors, 400);
  if (device.length < 8 || device.length > 64) return json({ ok: false, error: "bad_device" }, cors, 400);

  // 只有已上架的牌组能投，防止给不存在的 id 灌票
  const deck = await env.DB.prepare("SELECT status FROM decks WHERE id = ?").bind(deckId).first();
  if (!deck || deck.status !== 1) return json({ ok: false, error: "no_deck" }, cors, 404);

  if (on) {
    const cur = await env.DB.prepare("SELECT COUNT(*) AS n FROM votes WHERE deck_id = ?")
      .bind(deckId)
      .first();
    if (cur && cur.n >= 20000) return json({ ok: true, count: cur.n, capped: true }, cors);

    await env.DB.prepare(
      `INSERT INTO votes (deck_id, device_id, ts) VALUES (?, ?, ?)
       ON CONFLICT(deck_id, device_id) DO UPDATE SET ts = excluded.ts`
    )
      .bind(deckId, device, Date.now())
      .run();
  } else {
    await env.DB.prepare("DELETE FROM votes WHERE deck_id = ? AND device_id = ?")
      .bind(deckId, device)
      .run();
  }

  const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM votes WHERE deck_id = ?")
    .bind(deckId)
    .first();
  return json({ ok: true, count: after ? after.n : 0, on }, cors);
}

async function submitDeck(request, env, cors) {
  let body = null;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: "bad_json" }, cors, 400);
  }

  const code = String((body && body.code) || "").trim();
  const device = String((body && body.deviceId) || "").trim();
  let name = String((body && body.name) || "").trim();
  let by = String((body && body.by) || "").trim();
  let note = String((body && body.note) || "").trim();
  let tags = String((body && body.tags) || "").trim();

  if (device.length < 8) return json({ ok: false, error: "bad_device" }, cors, 400);
  if (code.length < 20 || code.length > 400) return json({ ok: false, error: "bad_code" }, cors, 400);

  // 服务端解一遍：CRC 不对、字段乱来的直接挡掉，别让它进待审列表浪费人工
  const d = decodeDeck(code);
  if (!d.ok) return json({ ok: false, error: "bad_code", detail: d.error }, cors, 400);

  const total = Object.values(d.cards).reduce((a, b) => a + b, 0);
  if (total < 20 || total > 120) {
    return json({ ok: false, error: "bad_size", detail: `${total} 张`, }, cors, 400);
  }

  name = clean(name, 40) || d.name || "未命名牌组";
  by = clean(by, 20);
  note = clean(note, 120);
  tags = tags.split(",").map((s) => clean(s, 12)).filter(Boolean).slice(0, 4).join(",");

  const hash = (await sha256(code)).slice(0, 16);

  // 同一套牌（同一段码）只收一次，重复投稿直接返回已有 id
  const dup = await env.DB.prepare("SELECT id, status FROM decks WHERE code_hash = ?").bind(hash).first();
  if (dup) {
    return json({ ok: true, id: dup.id, duplicate: true, status: dup.status }, cors);
  }

  // 每台设备每天最多 3 套，防止一个人刷满待审列表
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const cnt = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM decks WHERE device_id = ? AND created_at > ?"
  )
    .bind(device, dayAgo)
    .first();
  if (cnt && cnt.n >= 3) {
    return json({ ok: false, error: "too_many", detail: "今天已经投过 3 套了" }, cors, 429);
  }

  const id = "ahc-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO decks (id, name, inv, code, code_hash, device_id, by, note, xp, tags, src, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ahc', 0, ?, ?)`
  )
    .bind(id, name, d.inv, code, hash, device, by, note, d.xp, tags, now, now)
    .run();

  return json({ ok: true, id, pending: true, cards: Object.keys(d.cards).length, total }, cors);
}

// ==================== 匿名日活 ====================

/**
 * 只回答一个问题：今天有多少台设备打开过 App。
 *
 * <p><b>为什么这么设计</b>：这个 App 的卖点是「不注册、不收个人信息」，所以日活不能靠账号，
 * 也不能落原始 IP 或设备串。做法是把 deviceId 和「当天日期 + 服务端盐」一起做 SHA-256，
 * 只存前 16 位：
 *
 * <pre>
 * who = sha256(deviceId + "|" + day + "|" + SALT).slice(0, 16)
 * </pre>
 *
 * 盐里带日期，意味着<b>同一台设备昨天和今天的 who 完全不同</b>——能算日活，算不了跨天追踪，
 * 也没法从 who 反推是哪台手机。代价是「7 天活跃设备数」只能按天相加，不能去重，
 * 这一点在审核页上写明了，不装作是独立用户数。
 *
 * <p>没带 deviceId 时退回 IP 哈希（同样加日期盐），仅用于老版本或异常请求，不存 IP 原文。
 */
async function ping(request, env, cors) {
  let body = null;
  try {
    body = await request.json();
  } catch (e) {
    body = null;
  }

  const device = String((body && body.deviceId) || "").trim();
  const day = dayKey(Date.now());
  const salt = env.SALT || env.ADMIN_KEY || "arkham";

  let who;
  if (device.length >= 8 && device.length <= 64) {
    who = "d" + (await sha256(device + "|" + day + "|" + salt)).slice(0, 16);
  } else {
    const ip =
      request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-real-ip") ||
      (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      "0.0.0.0";
    who = "i" + (await sha256(ip + "|" + day + "|" + salt)).slice(0, 16);
  }

  // 同一台设备当天只算一个，但把打开次数累加在 n 里 —— 人均打开次数比日活更能说明「用得上不上」
  await env.DB.prepare(
    `INSERT INTO daily (day, who, ts, n) VALUES (?, ?, ?, 1)
     ON CONFLICT(day, who) DO UPDATE SET ts = excluded.ts, n = daily.n + 1`
  )
    .bind(day, who, Date.now())
    .run();

  const t = await env.DB.prepare("SELECT COUNT(*) AS n FROM daily WHERE day = ?").bind(day).first();
  return json({ ok: true, today: t ? t.n : 0 }, cors);
}

/** 北京时间的日期串。用 UTC 会让早上 8 点前的访问记到前一天，报表看着像掉了一半 */
function dayKey(ts) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 近 N 天的日活、打开次数，按天倒序 */
async function dailyStats(env, days = 30) {
  const rs = await env.DB.prepare(
    `SELECT day, COUNT(*) AS dau, SUM(n) AS opens
       FROM daily GROUP BY day ORDER BY day DESC LIMIT ?`
  )
    .bind(days)
    .all();

  const rows = (rs.results || []).map((r) => ({
    day: r.day,
    dau: r.dau || 0,
    opens: r.opens || 0,
  }));

  const today = dayKey(Date.now());
  const yest = dayKey(Date.now() - 86400000);
  const pick = (d) => {
    const x = rows.find((r) => r.day === d);
    return x ? x.dau : 0;
  };
  const last7 = rows.filter((r) => r.day < today).slice(0, 7);
  const avg7 = last7.length
    ? Math.round((last7.reduce((a, b) => a + b.dau, 0) / last7.length) * 10) / 10
    : 0;

  return {
    today,
    todayDau: pick(today),
    yestDau: pick(yest),
    avg7,
    opensToday: (rows.find((r) => r.day === today) || {}).opens || 0,
    rows,
  };
}

// ==================== 管理页 ====================

async function adminPage(url, env) {
  const key = url.searchParams.get("key") || "";
  const pend = await env.DB.prepare(
    `SELECT id, name, inv, code, device_id, by, note, xp, tags, created_at
       FROM decks WHERE status = 0 ORDER BY created_at ASC LIMIT 100`
  ).all();
  const live = await env.DB.prepare(
    `SELECT d.id, d.name, d.inv, d.by, d.created_at,
            (SELECT COUNT(*) FROM votes v WHERE v.deck_id = d.id) AS votes
       FROM decks d WHERE d.status = 1 ORDER BY d.created_at DESC LIMIT 30`
  ).all();

  let st = { todayDau: 0, yestDau: 0, avg7: 0, opensToday: 0, rows: [] };
  try {
    st = await dailyStats(env, 30);
  } catch (e) {
    // 老库还没有 daily 表时不要让整个审核页挂掉，统计区显示 0 即可
    st.err = String(e).slice(0, 80);
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const row = (r, pending) => {
    const time = new Date(r.created_at).toISOString().replace("T", " ").slice(0, 16);
    const cells = pending
      ? `<div class="name">${esc(r.name)}</div>
         <div class="meta">${esc(r.inv)} · ${esc(r.xp ? r.xp + " XP" : "0 XP")} · ${esc(r.by || "匿名")} · ${time}</div>
         ${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}
         ${r.tags ? `<div class="tags">${esc(r.tags)}</div>` : ""}
         <details><summary>牌组码</summary><code>${esc(r.code)}</code></details>
         <div class="acts">
           <form method="POST" action="/admin/act?key=${encodeURIComponent(key)}">
             <input type="hidden" name="id" value="${esc(r.id)}">
             <input type="hidden" name="act" value="pass">
             <button class="ok">通过并上架</button>
           </form>
           <form method="POST" action="/admin/act?key=${encodeURIComponent(key)}">
             <input type="hidden" name="id" value="${esc(r.id)}">
             <input type="hidden" name="act" value="reject">
             <button class="no">拒绝</button>
           </form>
         </div>`
      : `<div class="name">${esc(r.name)}</div>
         <div class="meta">${esc(r.inv)} · ${esc(r.by || "匿名")} · ${time} · ${r.votes} 票</div>
         <div class="acts">
           <form method="POST" action="/admin/act?key=${encodeURIComponent(key)}">
             <input type="hidden" name="id" value="${esc(r.id)}">
             <input type="hidden" name="act" value="hide">
             <button class="no">下架</button>
           </form>
         </div>`;
    return `<div class="card">${cells}</div>`;
  };

  const list = (pend.results || []).map((r) => row(r, true)).join("") ||
    `<div class="empty">没有待审投稿。</div>`;
  const lives = (live.results || []).map((r) => row(r, false)).join("") ||
    `<div class="empty">还没有已上架的牌组。</div>`;

  const perCap = st.todayDau > 0 ? (st.opensToday / st.todayDau).toFixed(1) : "—";
  const spark = (st.rows || []).slice(0, 14).reverse();
  const maxDau = Math.max(1, ...spark.map((r) => r.dau));
  const bars = spark.length
    ? spark.map((r) => {
        const h = Math.max(3, Math.round((r.dau / maxDau) * 44));
        return `<div class="bar" title="${r.day} · ${r.dau} 台 · ${r.opens} 次">
          <i style="height:${h}px"></i><em>${r.day.slice(5)}</em></div>`;
      }).join("")
    : `<div class="empty" style="flex:1">还没有数据。装上新版本后，每天第一次打开 App 会记一次。</div>`;

  return new Response(
    `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>社区牌组 · 审核</title>
<style>
:root{--bg:#0d1512;--card:#131d19;--line:#2a3831;--txt:#e8e0cd;--dim:#8a9a91;--gold:#c8a86a}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--txt);font:15px/1.5 -apple-system,"Noto Sans SC",sans-serif}
h1{font-size:20px;margin:8px 0 4px}
h2{font-size:15px;color:var(--gold);margin:28px 0 10px;font-weight:600}
.sub{color:var(--dim);font-size:13px;margin-bottom:8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:10px}
.name{font-size:16px;font-weight:600}
.meta{color:var(--dim);font-size:12px;margin-top:4px}
.note{color:var(--txt);font-size:13px;margin-top:8px;opacity:.9}
.tags{color:var(--gold);font-size:12px;margin-top:6px}
details{margin-top:8px}
summary{color:var(--dim);font-size:12px;cursor:pointer}
code{display:block;word-break:break-all;font-size:11px;color:var(--dim);margin-top:6px;background:#0a110e;padding:8px;border-radius:8px}
.acts{display:flex;gap:8px;margin-top:12px}
.acts form{flex:1;margin:0}
button{width:100%;padding:11px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--txt);font-size:14px;font-family:inherit}
.ok{background:var(--gold);color:#101714;border-color:var(--gold);font-weight:600}
.no{color:var(--dim)}
.empty{color:var(--dim);font-size:13px;padding:14px;text-align:center;border:1px dashed var(--line);border-radius:12px}
.dau{display:flex;gap:8px;margin:10px 0 8px}
.dau div{flex:1;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 6px;text-align:center}
.dau b{display:block;font-size:21px;color:var(--gold);font-weight:600;line-height:1.25}
.dau span{font-size:11px;color:var(--dim)}
.chart{display:flex;align-items:flex-end;gap:4px;min-height:74px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 10px 6px}
.bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}
.bar i{width:100%;max-width:16px;background:var(--gold);opacity:.8;border-radius:3px 3px 0 0;display:block}
.bar em{font-size:9px;color:var(--dim);font-style:normal;margin-top:4px;white-space:nowrap}
.note2{color:var(--dim);font-size:11px;margin:6px 0 0;line-height:1.5}
</style></head><body>
<h1>社区牌组 · 审核</h1>

<h2 style="margin-top:6px">活跃</h2>
<div class="dau">
  <div><b>${st.todayDau}</b><span>今日设备</span></div>
  <div><b>${st.yestDau}</b><span>昨日</span></div>
  <div><b>${st.avg7}</b><span>前 7 日均</span></div>
  <div><b>${perCap}</b><span>今日人均打开</span></div>
</div>
<div class="chart">${bars}</div>
<div class="note2">按设备去重，每天一把新盐：同一台手机昨天和今天的记录对不上，所以这里只有日活，没有跨天去重人数。前 7 日均值是把 7 天各自的数量平均。</div>

<div class="sub" style="margin-top:18px">待审 ${(pend.results || []).length} 条 · 已上架 ${(live.results || []).length} 条（最近 30）</div>
<h2>待审</h2>${list}
<h2>已上架</h2>${lives}
</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

async function adminAct(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  const form = await request.formData();
  const id = String(form.get("id") || "");
  const act = String(form.get("act") || "");

  if (!DECK_RE.test(id)) return new Response("bad id", { status: 400 });
  const status = act === "pass" ? 1 : act === "reject" ? 2 : act === "hide" ? 3 : -1;
  if (status < 0) return new Response("bad act", { status: 400 });

  await env.DB.prepare("UPDATE decks SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, Date.now(), id)
    .run();

  return new Response(null, { status: 303, headers: { Location: `/admin?key=${encodeURIComponent(key)}` } });
}

// ==================== 牌组码解码（与 App 的 DeckCode.java 同格式） ====================

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function decodeDeck(raw) {
  const bad = (e) => ({ ok: false, error: e, inv: "", xp: 0, name: "", cards: {} });
  if (!raw) return bad("空的牌组码");

  let s = String(raw).replace(/[\s\u00a0]/g, "");
  const at = s.toUpperCase().indexOf("AHC1");
  if (at < 0) return bad("缺少 AHC1 前缀");
  s = s.slice(at + 4).replace(/[。，,.;；:：、)]+$/, "");

  const data = unb64(s);
  if (!data || data.length < 4) return bad("内容不完整");

  const crcAt = data.length - 1;
  if (data[crcAt] !== crc8(data, crcAt)) return bad("校验失败，可能复制时漏了字符");

  try {
    let p = 0;
    const rd = () => {
      let v = 0, shift = 0;
      while (true) {
        if (p >= crcAt) throw new Error("eof");
        const b = data[p++];
        v |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) return v;
        shift += 7;
        if (shift > 28) throw new Error("varint");
      }
    };

    const invNum = rd();
    if (p >= crcAt) throw new Error("eof");
    const invSuf = data[p++];
    if (p >= crcAt) throw new Error("eof");
    const flags = data[p++];
    const xp = rd();
    const n = rd();
    if (n <= 0 || n > 200) throw new Error("count");

    const inv = join5(invNum, invSuf);
    const cards = {};
    let prev = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const d = rd();
      if (p >= crcAt) throw new Error("eof");
      const b = data[p++];
      const suf = b >> 4, cnt = b & 0x0f;
      if (cnt <= 0 || suf > 26) throw new Error("entry");
      prev += d;
      const code = join5(prev, suf);
      if (!/^\d{5}[a-z]?$/.test(code)) throw new Error("code");
      cards[code] = cnt;
      total += cnt;
    }

    let name = "";
    if ((flags & 1) !== 0 && p < crcAt) {
      const len = data[p++];
      if (len > 0 && p + len <= crcAt) {
        name = new TextDecoder().decode(data.slice(p, p + len));
      }
    }
    if (total === 0) throw new Error("empty");

    return { ok: true, error: "", inv, xp: Math.max(0, Math.min(999, xp)), name, cards, total };
  } catch (e) {
    return bad("解析失败，可能不是本 App 生成的码");
  }
}

function join5(num, suf) {
  let s = String(num);
  while (s.length < 5) s = "0" + s;
  if (suf >= 1 && suf <= 26) s += String.fromCharCode(97 + suf - 1);
  return s;
}

function crc8(d, len) {
  let crc = 0;
  for (let i = 0; i < len; i++) {
    crc ^= d[i];
    for (let k = 0; k < 8; k++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc & 0xff;
}

function unb64(s) {
  const n = s.length;
  const pad = n % 4;
  if (pad === 1) return null;
  const out = [];
  let i = 0;
  while (i + 4 <= n) {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const d = B64.indexOf(s[i + k]);
      if (d < 0) return null;
      v = (v << 6) | d;
    }
    out.push((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
    i += 4;
  }
  const left = n - i;
  if (left === 2) {
    const d0 = B64.indexOf(s[i]), d1 = B64.indexOf(s[i + 1]);
    if (d0 < 0 || d1 < 0) return null;
    out.push(((d0 << 6) | d1) >> 4);
  } else if (left === 3) {
    const d0 = B64.indexOf(s[i]), d1 = B64.indexOf(s[i + 1]), d2 = B64.indexOf(s[i + 2]);
    if (d0 < 0 || d1 < 0 || d2 < 0) return null;
    const v = (d0 << 12) | (d1 << 6) | d2;
    out.push((v >> 10) & 0xff, (v >> 2) & 0xff);
  }
  return new Uint8Array(out);
}

// ==================== 小工具 ====================

function clean(s, max) {
  return String(s == null ? "" : s)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(obj, cors, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
      ...cors,
    },
  });
}
