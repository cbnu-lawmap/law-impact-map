#!/usr/bin/env node
/*
 * 세대수 법안 다시 돌리기: 에이전트 기준 뽑기가 세대수를 받게 된 뒤(criteria.js) 세대수 법안 6건을 agent·agentic 으로 돌려 본다.
 *
 *   node server/scripts/household-rerun.js                              배포 서버(https://ppaegok-api.vercel.app)
 *   node server/scripts/household-rerun.js --base http://127.0.0.1:3000 로컬 dev-server
 *   --bills 2207658,2217163   --modes agent,agentic   --sleep 13000 (ms)
 *
 * 법안 6건 (docs/bldg_register_analysis.md 세대수 표 중 제안이유에 "N세대 이상" 이 있고 사창동에 해당 건물이 있는 것)
 *   2207658 주택법 (품질점검단 300 → 30세대 이상, 판정 시범 규칙 있음)
 *   2217163 건축물의 분양에 관한 법률 (30세대 이상)
 *   2213393 건축물의 분양에 관한 법률 (30세대 이상)
 *   2213086 공동주택관리법 (150세대 이상 의무관리 공동주택)
 *   2200958 소방기본법 (100세대 이상 아파트, 판정 시범 법안이지만 시범 규칙에 세대수 없음)
 *   2212443 공공주택 특별법 (100세대 이상 공동주택)
 *
 * 서버는 IP당 1분 5회만 받으므로 호출 사이에 13초 쉰다 (6건 x 2방식 = 12번, 약 3분).
 * Vercel 에 AGENT_COMPARE_TOKEN 이 있으면 같은 값을 환경변수로 주면 10분 저장을 건너뛴다 (값은 출력하지 않음).
 *
 * 표: 법안, 방식, 뽑은 규칙(원문 대조 통과), 세대수 통과 여부, 시범 규칙과 같은지
 *   시범 규칙에 세대수가 있는 법안(2207658)만 "시범 규칙 일치" 를 본다. 나머지는 세대수를 뽑았는지만 적는다.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def; };
const BASE = String(opt("base", "https://ppaegok-api.vercel.app")).replace(/\/+$/, "");
const BILLS = String(opt("bills", "2207658,2217163,2213393,2213086,2200958,2212443")).split(",").map((s) => s.trim()).filter(Boolean);
const MODES = String(opt("modes", "agent,agentic")).split(",").map((s) => s.trim()).filter(Boolean);
const TOKEN = process.env.AGENT_COMPARE_TOKEN || "";
const SLEEP = Number(opt("sleep", /127\.0\.0\.1|localhost/.test(BASE) ? 0 : 13000));

const demos = {};
JSON.parse(fs.readFileSync(path.join(ROOT, "web", "data", "demo_rules.json"), "utf8")).demos.forEach((d) => { demos[d.bill_no] = d; });
const KEYS = ["용도", "연면적", "층수", "세대수", "사용승인", "위임"];
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
function ruleText(rule) {
  const parts = [];
  Object.keys(rule || {}).forEach((k) => {
    const v = rule[k];
    if (Array.isArray(v)) parts.push(k + " " + v.join("·"));
    else if (v && typeof v === "object") parts.push(k + " " + Object.keys(v).map((b) => b + " " + v[b]).join(", "));
  });
  return parts.join(" / ") || "(없음)";
}
// 세대수가 버려졌으면 그 이유 (agent: extraction.dropped, agentic: extraction.by_source[].dropped)
function householdDropped(ex) {
  const list = (ex.dropped || []).concat(...(ex.by_source || []).map((s) => s.dropped || []));
  return Array.from(new Set(list.filter((d) => d.attr === "세대수").map((d) => d.why)));
}

async function call(body) {
  const headers = { "Content-Type": "application/json", Origin: "https://cbnu-lawmap.github.io" };
  if (TOKEN) headers["x-compare-token"] = TOKEN;
  const r = await fetch(BASE + "/api/agent", { method: "POST", headers, body: JSON.stringify(body) });
  let j = {};
  try { j = await r.json(); } catch (e) { j = { error: "JSON 아님 (" + r.status + ")" }; }
  return { code: r.status, body: j };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.error(`세대수 법안 ${BILLS.length}건 x ${MODES.join("/")} · ${BASE} · 호출 사이 ${SLEEP / 1000}초`);
  const rows = [];
  let first = true;
  for (const no of BILLS) {
    for (const mode of MODES) {
      if (!first && SLEEP) await sleep(SLEEP);
      first = false;
      let r;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { r = await call({ bill: no, mode }); } catch (e) { r = { code: 0, body: { error: String(e.message) } }; }
        if (r.code !== 429) break;
        console.error("  호출 수 제한, 60초 쉼");
        await sleep(60000);
      }
      const j = r.body || {};
      const ex = j.extraction || {};
      const rule = ex.rule || {};
      const pilot = demos[no] && demos[no].rule && demos[no].rule.세대수 ? demos[no].rule : null;
      const ok = r.code === 200 && !j.error;
      const row = {
        bill: no, mode,
        result: ok ? "ok" : "실패 " + (j.error || "HTTP " + r.code),
        rule: ok ? ruleText(rule) : "",
        household: ok ? (rule.세대수 ? "통과" : "없음" + (householdDropped(ex).length ? " (" + householdDropped(ex).join("; ") + ")" : "")) : "",
        pilot: !ok ? "" : pilot ? (canon(rule) === canon(pilot) ? "같음" : "다름 (시범 " + ruleText(pilot) + ")") : (rule.세대수 ? "시범 규칙 없음, 세대수 뽑음" : "시범 규칙 없음, 세대수 못 뽑음"),
        cached: j.cached ? "저장된 결과" : "",
      };
      rows.push(row);
      console.error(`  ${no} ${mode.padEnd(7)} ${row.result} ${row.rule} | 세대수 ${row.household}`);
    }
  }
  const esc = (s) => String(s).replace(/\|/g, "/");
  console.log("");
  console.log(`세대수 법안 다시 돌리기 (${BASE}, ${new Date().toISOString().slice(0, 10)})`);
  console.log("");
  console.log("| 법안 | 방식 | 뽑은 규칙 (원문 대조 통과) | 세대수 | 시범 규칙 비교 |");
  console.log("|---|---|---|---|---|");
  rows.forEach((x) => console.log(`| ${x.bill} | ${x.mode} | ${esc(x.result === "ok" ? x.rule : x.result)}${x.cached ? " (" + x.cached + ")" : ""} | ${esc(x.household)} | ${esc(x.pilot)} |`));
  const okRows = rows.filter((x) => x.result === "ok");
  console.log("");
  console.log(`세대수 통과: ${okRows.filter((x) => x.household === "통과").length}/${okRows.length} (성공한 호출 기준)`);
})();
