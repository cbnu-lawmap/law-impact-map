#!/usr/bin/env node
/*
 * 세 방식 비교: agent(도구 고르기) / rag1(1회 RAG) / agentic(Agentic RAG)
 *
 *   node server/scripts/compare-rag.js                       배포 서버(https://ppaegok-api.vercel.app)에 시범 27건 x 3방식
 *   node server/scripts/compare-rag.js --base http://127.0.0.1:3000   로컬 dev-server 에
 *   node server/scripts/compare-rag.js --local               서버를 띄우지 않고 api/agent.js 핸들러를 직접 부름
 *                                                            (OPENAI_API_KEY 가 있어야 함. AGENT_MOCK=1 이면 가짜 모델로 흐름만 확인)
 *   --bills 26        처음 시범 26건만 (2207658 주택법 세대수 법안을 뺌). 기본은 demo_rules.json 의 27건 모두
 *   --modes agent,rag1,agentic   --out data/rag_compare.csv   --sleep 13000 (ms)
 *
 * 서버는 IP당 1분 5회만 받으므로 원격 서버에는 호출 사이에 13초 쉰다 (27건 x 3방식 = 81번, 약 18분).
 * Vercel 에 AGENT_COMPARE_TOKEN 을 넣었다면 같은 값을 환경변수 AGENT_COMPARE_TOKEN 으로 주면 쉬지 않고 10분 저장도 건너뛴다.
 * 열쇠 값은 코드나 결과 파일에 남기지 않는다.
 *
 * 지표 (방식별)
 *   원문 대조 통과 기준 수   extraction.rule 의 기준 수 합 (용도·연면적·층수·사용승인·위임)
 *   시범 규칙 일치 수        extraction.rule 이 demo_rules.json 의 규칙과 똑같은 법안 수 (시범 규칙으로 대신 판정한 것은 세지 않음)
 *   평균 토큰, 평균 단계 수  응답의 tokens, step_count (단계 기록 수, 자동 계산·코드 평가 단계 포함)
 *   재검색으로 살린 법안     요약에서 부족했던 기준이 나중 출처에서 판정에 충분이 된 법안 (응답의 revived)
 * 결과: data/rag_compare.csv (법안 x 방식 한 줄), 표준 출력에 마크다운 표
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def; };
const LOCAL = args.includes("--local");
const BASE = String(opt("base", "https://ppaegok-api.vercel.app")).replace(/\/+$/, "");
const MODES = String(opt("modes", "agent,rag1,agentic")).split(",").map((s) => s.trim()).filter(Boolean);
const OUT = path.resolve(ROOT, opt("out", "data/rag_compare.csv"));
const TOKEN = process.env.AGENT_COMPARE_TOKEN || "";
const SLEEP = Number(opt("sleep", LOCAL || TOKEN || /127\.0\.0\.1|localhost/.test(BASE) ? 0 : 13000));
const ADDED_LATER = ["2207658"]; // 처음 26건 뒤에 넣은 시범 법안

const demos = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "data", "demo_rules.json"), "utf8")).demos;
const pilots = demos.filter((d) => opt("bills", "27") !== "26" || !ADDED_LATER.includes(d.bill_no));
const KEYS = ["용도", "연면적", "층수", "사용승인", "위임"];
function canon(rule) {
  const out = {};
  KEYS.forEach((k) => {
    const v = rule && rule[k];
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) out[k] = v.map(String).slice().sort();
    else if (typeof v === "object") {
      const o = {};
      Object.keys(v).sort().forEach((b) => { if (v[b] !== undefined && v[b] !== null) o[b] = k === "사용승인" ? String(v[b]) : Number(v[b]); });
      out[k] = o;
    } else out[k] = v;
  });
  return JSON.stringify(out);
}

let localHandler = null;
function callLocal(body) {
  if (!localHandler) {
    process.env.DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "web", "data");
    localHandler = require("../api/agent");
  }
  return new Promise((resolve) => {
    const req = { method: "POST", body, url: "/api/agent", headers: { origin: "http://localhost:8000", "x-forwarded-for": "10.77." + Math.floor(Math.random() * 250) + "." + Math.floor(Math.random() * 250) } };
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(j) { resolve({ code: this.code, body: j }); }, end() { resolve({ code: this.code, body: {} }); } };
    localHandler(req, res);
  });
}
async function callRemote(body) {
  const headers = { "Content-Type": "application/json", Origin: "https://cbnu-lawmap.github.io" };
  if (TOKEN) headers["x-compare-token"] = TOKEN;
  const r = await fetch(BASE + "/api/agent", { method: "POST", headers, body: JSON.stringify(body) });
  let j = {};
  try { j = await r.json(); } catch (e) { j = { error: "JSON 아님 (" + r.status + ")" }; }
  return { code: r.status, body: j };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

(async () => {
  console.error(`대상 ${pilots.length}건 x ${MODES.join("/")} · ${LOCAL ? "로컬 핸들러" : BASE} · 호출 사이 ${SLEEP / 1000}초`);
  const rows = [];
  let first = true;
  for (const d of pilots) {
    for (const mode of MODES) {
      if (!first && SLEEP) await sleep(SLEEP);
      first = false;
      let r;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { r = LOCAL ? await callLocal({ bill: d.bill_no, mode }) : await callRemote({ bill: d.bill_no, mode }); } catch (e) { r = { code: 0, body: { error: String(e.message) } }; }
        if (r.code !== 429) break;
        console.error("  호출 수 제한, 60초 쉼");
        await sleep(60000);
      }
      const j = r.body || {};
      const ex = (j.extraction && j.extraction.rule) || {};
      const row = {
        bill: d.bill_no, mode, ok: r.code === 200 && !j.error ? 1 : 0, error: j.error || (r.code !== 200 ? "HTTP " + r.code : ""),
        verified_n: Object.keys(ex).length,
        pilot_match: r.code === 200 && canon(ex) === canon(d.rule) ? 1 : 0,
        tokens: j.tokens || 0,
        steps: j.step_count != null ? j.step_count : (j.steps || []).length,
        researches: j.researches || 0,
        sources: (j.sources_used || []).map((s) => s.source + (s.found ? "" : "(없음)")).join(" "),
        revived: (j.revived || []).map((x) => x.attr + "<" + x.by).join(" "),
        rule_source: j.rule_source || "",
        hold: j.hold || "",
        extracted_rule: JSON.stringify(ex),
        pilot_rule: JSON.stringify(d.rule),
        model: j.model || "",
        cached: j.cached ? 1 : 0,
      };
      rows.push(row);
      console.error(`  ${d.bill_no} ${mode.padEnd(7)} ${row.ok ? "ok" : "실패 " + row.error} 기준 ${row.verified_n} 일치 ${row.pilot_match} 토큰 ${row.tokens} 단계 ${row.steps}${row.revived ? " 살림 " + row.revived : ""}`);
    }
  }
  const cols = Object.keys(rows[0] || {});
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, "﻿" + [cols.join(",")].concat(rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))).join("\n") + "\n");

  const NAME = { agent: "agent (도구 고르기)", rag1: "rag1 (1회 RAG)", agentic: "agentic (Agentic RAG)" };
  const lines = [];
  const model = Array.from(new Set(rows.map((r) => r.model).filter(Boolean))).join(", ");
  lines.push(`시범 법안 ${pilots.length}건${pilots.length === 26 ? " (처음 26건)" : " (demo_rules.json 전체)"}, 모델 ${model || "알 수 없음"}, ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push("| 방식 | 성공 | 원문 대조 통과 기준 수 | 시범 규칙 일치 수 | 평균 토큰 | 평균 단계 수 | 재검색으로 살린 법안 |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  MODES.forEach((m) => {
    const rs = rows.filter((r) => r.mode === m);
    const ok = rs.filter((r) => r.ok);
    const avg = (k) => (ok.length ? Math.round(ok.reduce((a, r) => a + r[k], 0) / ok.length * 10) / 10 : 0);
    lines.push(`| ${NAME[m] || m} | ${ok.length}/${rs.length} | ${ok.reduce((a, r) => a + r.verified_n, 0)} | ${ok.reduce((a, r) => a + r.pilot_match, 0)} | ${avg("tokens").toLocaleString("en-US")} | ${avg("steps")} | ${ok.filter((r) => r.revived).length} |`);
  });
  const revived = rows.filter((r) => r.revived);
  lines.push("");
  lines.push("재검색으로 살린 법안 (요약에서 부족 → 나중 출처에서 판정에 충분): " + (revived.length ? revived.map((r) => `${r.bill} ${r.revived}`).join(", ") : "없음"));
  lines.push("");
  lines.push("법안별 결과: " + path.relative(ROOT, OUT).replace(/\\/g, "/"));
  console.log(lines.join("\n"));
})();
