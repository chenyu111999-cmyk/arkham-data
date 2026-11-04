#!/usr/bin/env node
/**
 * 把 worker.js 架在普通 Node 服务器上（国内轻量云 / 自建 VPS）。
 *
 * 设计原则：worker.js 一行不改。这里只做三层转换——
 *   1. node:http 的 req/res  ↔  Web 标准的 Request/Response
 *   2. node:sqlite          ↔  Cloudflare D1 的 prepare/bind 接口
 *   3. 环境变量              ↔  Worker 的 env 对象
 *
 * 启动：
 *   PORT=8443 ADMIN_KEY=xxx node server.mjs
 *
 * 只打印方法和路径，不记 IP —— 服务端承诺不收集用户信息，日志也不能破例。
 */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { openDb, initDb, d1 } from "./d1.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// 下载页静态目录（v3.39.1）。把「发给人家的下载页」从第三方托管挪到自己的机器上：
// 8443 已在防火墙放行、也没走 80/443，不涉及备案。默认 <安装目录>/dl，
// 用 DL_DIR 可改。只托管页面与图片，APK 本身仍走 GitHub 镜像，不占服务器带宽。
const DL_DIR = process.env.DL_DIR || join(HERE, "..", "dl");
const EXISTS_DL = existsSync(DL_DIR);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".apk": "application/vnd.android.package-archive",
};

/** /dl/... → DL_DIR 下的文件。挡 ../ 与绝对路径，且要求最终路径仍在 DL_DIR 内 */
function serveDl(req, res) {
  let rel = decodeURIComponent((req.url || "").split("?")[0]).replace(/^\/dl\/?/, "");
  if (!rel) rel = "index.html";
  if (rel.includes("..") || rel.startsWith("/") || rel.includes("\\")) {
    res.statusCode = 400;
    return res.end("bad path");
  }
  const file = join(DL_DIR, rel);
  if (!file.startsWith(DL_DIR) || !existsSync(file)) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end("not found");
  }
  let buf;
  try {
    buf = readFileSync(file);
  } catch (e) {
    res.statusCode = 500;
    return res.end("read error");
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME[extname(file).toLowerCase()] || "application/octet-stream");
  res.setHeader("Content-Length", String(buf.length));
  // 页面不缓存（改了要立刻生效），APK 缓存一天（同一个文件名内容不会变）
  res.setHeader("Cache-Control", rel.endsWith(".apk") ? "public, max-age=86400" : "no-cache");
  if (req.method === "HEAD") return res.end();
  res.end(buf);
}

// systemd 会用 EnvironmentFile 把 /opt/arkham-api/env 灌进环境变量，
// 但手工 `bash start.sh` 调试时不会。这里补上，优先级低于真实环境变量，
// 保证两种启动方式看到同一份配置。
const ENV_FILE = process.env.ENV_FILE || join(HERE, "..", "env");
try {
  if (existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
} catch (e) {
  // 读不到就退回默认配置（systemd 场景下环境变量本来就已经注入了）。
  // 不能因为一个权限问题让服务起不来。
  console.warn(`[warn] 读不到 ${ENV_FILE}：${e.code || e.message}，改用环境变量`);
}

const worker = (await import(join(HERE, "..", "worker.js"))).default;

const PORT = Number(process.env.PORT || 8443);
const HOST = process.env.HOST || "0.0.0.0";
const DB_PATH = process.env.DB_PATH || join(HERE, "data", "arkham.db");
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const QUIET = process.env.LOG === "quiet";

// 投稿和投票的 JSON 都很小，给到 256KB 已经很宽松；超过直接断，防内存打爆
const BODY_LIMIT = 256 * 1024;

const db = openDb(DB_PATH);
initDb(db);
const env = { DB: d1(db), ADMIN_KEY };

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(line) {
  if (!QUIET) process.stdout.write(`${stamp()}  ${line}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;

    const fail = (e) => {
      if (done) return;
      done = true;
      chunks.length = 0;
      reject(e);
    };

    req.on("data", (c) => {
      // 超限后不能 destroy —— 那样 socket 直接断，客户端只会看到「连接被重置」，
      // 拿不到 413 也就无从判断是被限流还是网络问题。继续读、丢弃即可。
      if (done) return;
      size += c.length;
      if (size > BODY_LIMIT) {
        fail(Object.assign(new Error("body too large"), { code: "too_large" }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", fail);
  });
}

/** 逐跳头（hop-by-hop）不能透传，否则 undici 会报错或行为异常 */
const SKIP_REQ_HEADERS = new Set([
  "content-length", "transfer-encoding", "connection", "keep-alive",
  "proxy-authorization", "proxy-connection", "te", "trailer", "upgrade",
]);

function toRequest(req, body) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || SKIP_REQ_HEADERS.has(k)) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  // 真实 IP 只给 worker 做日活兜底（App 没带 deviceId 时用），算完就哈希，库里不落原文。
  // 前面挂了反代时保留反代传进来的值，别把真实来源盖掉。
  if (!headers.has("x-real-ip")) {
    const ip = (req.socket && req.socket.remoteAddress) || "";
    if (ip) headers.set("x-real-ip", ip.replace(/^::ffff:/, ""));
  }
  const method = (req.method || "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && body && body.length > 0;
  return new Request(`http://${host}${req.url}`, {
    method,
    headers,
    body: hasBody ? body : undefined,
  });
}

const server = http.createServer(async (req, res) => {
  const t0 = process.hrtime.bigint();
  let status = 500;

  try {
    // 下载页：不经过 worker，直接吐静态文件（放在最前面，永远不受 API 路由改动影响）
    if ((req.method === "GET" || req.method === "HEAD") && /^\/dl(\/|$|\?)/.test(req.url || "")) {
      const t1 = process.hrtime.bigint();
      serveDl(req, res);
      log(`${String(res.statusCode).padEnd(3)} ${(Number(process.hrtime.bigint() - t1) / 1e6).toFixed(0).padStart(4)}ms  GET ${req.url.split("?")[0]}`);
      return;
    }
    const body = req.method === "GET" || req.method === "HEAD" ? null : await readBody(req);
    const request = toRequest(req, body);
    const response = await worker.fetch(request, env);

    status = response.status;
    res.statusCode = status;
    response.headers.forEach((v, k) => {
      if (k.toLowerCase() === "content-length") return;
      res.setHeader(k, v);
    });

    const buf = Buffer.from(await response.arrayBuffer());
    // 204 / 304 不带消息体，也不能带 Content-Length
    if (status !== 204 && status !== 304) {
      res.setHeader("Content-Length", String(buf.length));
    }
    res.end(buf.length ? buf : undefined);
  } catch (e) {
    status = e && e.code === "too_large" ? 413 : 500;
    // 把请求体剩下的一口气读完，否则 Node 会在响应发出前重置连接
    req.resume();
    if (!res.headersSent) {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Connection", "close");
      res.end(JSON.stringify({ ok: false, error: status === 413 ? "too_large" : "server_error" }));
    } else {
      res.end();
    }
    log(`${status}  ${req.method} ${req.url}  !! ${String(e).slice(0, 120)}`);
    return;
  }

  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // 管理页里的 key 不能进日志
  const path = req.url.replace(/([?&]key=)[^&]*/, "$1***");
  log(`${String(status).padEnd(3)} ${ms.toFixed(0).padStart(4)}ms  ${req.method} ${path}`);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用，换一个：PORT=8444 node server.mjs`);
    process.exit(1);
  }
  console.error("服务器错误：", e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // 启动自检：数量对不上说明 seed 没进去，比等用户报错强
  let decks = "?", pending = "?";
  try {
    decks = db.prepare("SELECT COUNT(*) AS n FROM decks WHERE status = 1").get().n;
    pending = db.prepare("SELECT COUNT(*) AS n FROM decks WHERE status = 0").get().n;
  } catch (e) { /* 表还没建好，交给上面的 initDb 报错 */ }

  log("────────────────────────────────────────");
  log(`  AH 社区牌组服务  http://${HOST}:${PORT}`);
  log(`  数据库  ${DB_PATH}`);
  log(`  已上架 ${decks} 套 · 待审 ${pending} 条`);
  log(`  审核页  /admin?key=${ADMIN_KEY ? "(已设置)" : "(未设置，接口保持 404)"}`);
  log(`  下载页  /dl/  (${EXISTS_DL ? DL_DIR : DL_DIR + " 不存在，/dl 返回 404"})`);
  log("────────────────────────────────────────");
});

function shutdown(sig) {
  log(`${sig} 收到，正在关闭…`);
  server.close(() => {
    try { db.close(); } catch (e) { /* 已关闭 */ }
    process.exit(0);
  });
  // 10 秒还没关完就强制退出，避免 systemd 一直等
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
