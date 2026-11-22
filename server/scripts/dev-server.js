#!/usr/bin/env node
/*
 * 로컬 시험용 서버 (Vercel 없이 api/*.js 핸들러를 띄운다). 127.0.0.1 에서만 받는다.
 *
 *   키 없이 화면까지 시험:
 *     AGENT_MOCK=1 DATA_DIR=web/data node server/scripts/dev-server.js      (기본 포트 3000)
 *     python -m http.server 8000 --directory web
 *     http://localhost:8000/admin.html?api=http://localhost:3000#/bill/2206436
 *   화면의 ?api= 는 localhost 에서 열었을 때만 먹는다.
 */
const http = require("http");

const ROUTES = { "/api/agent": require("../api/agent"), "/api/ask": require("../api/ask") };
const PORT = Number(process.env.PORT || 3000);

http.createServer((req, res) => {
  const fn = ROUTES[req.url.split("?")[0]];
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
  req.on("end", () => {
    if (!fn) { res.writeHead(404); res.end(); return; }
    try { req.body = raw ? JSON.parse(raw) : {}; } catch (e) { req.body = {}; }
    if (!req.headers["x-forwarded-for"]) req.headers["x-forwarded-for"] = "127.0.0.1";
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (j) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(j)); };
    Promise.resolve(fn(req, res)).catch((e) => { res.statusCode = 500; res.end(String(e.message)); });
  });
}).listen(PORT, "127.0.0.1", () => console.log("로컬 API http://127.0.0.1:" + PORT + " (가짜 모델: " + (process.env.AGENT_MOCK === "1" ? "켜짐" : "꺼짐") + ")"));
