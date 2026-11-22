#!/usr/bin/env node
/*
 * 법안 요약 vs 의안 원문: 기준 뽑기(server/lib/criteria.js) 결과 비교 (판정 시범 26건)
 *
 *   node server/scripts/compare-bill-docs.js            표(마크다운)를 출력
 *   node server/scripts/compare-bill-docs.js --json     법안별 결과를 JSON 으로 출력
 *   node server/scripts/compare-bill-docs.js --rules data/bill_docs   원문마다 뽑은 규칙 JSON (교차 확인용)
 *
 * 원문은 data/bill_docs/<의안번호>_원문.txt (PDF 에서 뽑은 글, 줄바꿈이 낱말 중간에 들어감).
 * 뽑기 전에 쪽 번호("- 3 -")와 대비표의 "-----" 줄을 지우고, 줄은 공백 없이 잇는다
 * (PDF 줄바꿈은 낱말 중간에서 끊기므로 "물류창\n고" → "물류창고").
 * 사이트의 판정 규칙(demo_rules.json)은 바꾸지 않는다. 비교만 한다.
 */
const fs = require("fs");
const path = require("path");
const { extract, findDelegation } = require("../lib/criteria");

const ROOT = path.join(__dirname, "..", "..");
const DOCS = path.join(ROOT, "data", "bill_docs");
const ATTRS = ["용도", "연면적", "층수", "사용승인", "위임"];

function readCsv(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/** PDF 에서 뽑은 원문을 뽑기용 한 덩어리 글로 만든다 */
function prepDoc(raw) {
  return raw.split(/\r?\n/)
    .filter((l) => !/^\s*-\s*\d+\s*-\s*$/.test(l))          // 쪽 번호
    .map((l) => l.replace(/-{3,}/g, " ").replace(/\s+$/, "")) // 대비표의 "현행과 같음" 줄
    .join("")
    .replace(/\s+/g, " ").trim();
}

/** 대비표 앞까지만 (제안이유 + 개정 조문). 대비표의 "현 행" 칸은 지금 법 글이라 섞이면 안 되는 기준이 나올 수 있다 */
function bodyOnly(raw) {
  const i = raw.search(/신\s*[ㆍ·]\s*구\s*조\s*문\s*대\s*비\s*표/);
  return i > 0 ? raw.slice(0, i) : raw;
}

function load() {
  const demos = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "data", "demo_rules.json"), "utf8")).demos;
  const summary = {};
  readCsv(path.join(ROOT, "data", "bills_summary.csv")).forEach((r) => { summary[r.BILL_NO] = r.SUMMARY; });
  return { demos, summary };
}

function attrsOf(rule) { return ATTRS.filter((a) => rule[a] !== undefined); }

/** 뽑은 규칙이 시범 규칙과 기준 종류별로 같은지: 같음 / 다름 / 없음(시범에 있는데 못 뽑음) / 더 있음(시범에 없는데 뽑음) */
function agree(pilot, got) {
  const out = {};
  ATTRS.forEach((a) => {
    const p = pilot[a], g = got[a];
    if (p === undefined && g === undefined) return;
    if (p === undefined) { out[a] = "더 있음"; return; }
    if (g === undefined) { out[a] = "없음"; return; }
    if (a === "용도" || a === "위임") {
      const ps = new Set(p), gs = new Set(g);
      const same = ps.size === gs.size && [...ps].every((x) => gs.has(x));
      if (a === "위임") out[a] = "같음(위임 있음)";  // 위임 값 이름은 사람이 붙인 것이라 있음/없음만 본다
      else out[a] = same ? "같음" : [...ps].some((x) => gs.has(x)) ? "일부 겹침" : "다름";
      return;
    }
    if (a === "사용승인") { out[a] = p.before === g.before ? "같음" : "다름"; return; }
    out[a] = JSON.stringify(p) === JSON.stringify(g) ? "같음" : "다름";
  });
  return out;
}

/** --rules <폴더>: 폴더 안 모든 <의안번호>_원문.txt 에서 뽑은 규칙을 {의안번호: rule} JSON 으로 (crosscheck_criteria.py --docs 가 씀) */
function dumpRules(dir) {
  const out = {};
  fs.readdirSync(dir).filter((f) => /^\d+_원문\.txt$/.test(f)).sort().forEach((f) => {
    out[f.split("_")[0]] = extract(prepDoc(fs.readFileSync(path.join(dir, f), "utf8"))).rule;
  });
  process.stdout.write(JSON.stringify(out));
}

function main() {
  const ri = process.argv.indexOf("--rules");
  if (ri > 0) { dumpRules(path.resolve(process.argv[ri + 1] || DOCS)); return; }
  const { demos, summary } = load();
  const rows = demos.map((d) => {
    const no = d.bill_no;
    const f = path.join(DOCS, `${no}_원문.txt`);
    const raw = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    const s = extract(summary[no] || "");
    const full = raw ? extract(prepDoc(raw)) : null;
    const body = raw ? extract(prepDoc(bodyOnly(raw))) : null;
    const rf = path.join(DOCS, `${no}_검토보고서.txt`);
    const review = fs.existsSync(rf) ? extract(prepDoc(fs.readFileSync(rf, "utf8"))) : null;
    const delegS = findDelegation(summary[no] || "").length;
    const delegD = raw ? findDelegation(prepDoc(raw)).length : 0;
    return {
      no, title: d.title, pilot: d.rule, has_doc: !!raw,
      summary: { rule: s.rule, passed: s.evidence.length, dropped: s.dropped.length, attrs: attrsOf(s.rule), delegation_phrases: delegS },
      doc: full && { rule: full.rule, passed: full.evidence.length, dropped: full.dropped.length, attrs: attrsOf(full.rule), delegation_phrases: delegD,
        evidence: full.evidence.map((e) => ({ attr: e.attr, value: e.value, quote: e.quote.slice(0, 120) })) },
      body: body && { rule: body.rule, passed: body.evidence.length, attrs: attrsOf(body.rule) },
      agree_summary: agree(d.rule, s.rule),
      agree_doc: full ? agree(d.rule, full.rule) : {},
      agree_body: body ? agree(d.rule, body.rule) : {},
      review: review && { rule: review.rule, passed: review.evidence.length, attrs: attrsOf(review.rule) },
      agree_review: review ? agree(d.rule, review.rule) : {},
    };
  });
  if (process.argv.includes("--json")) { console.log(JSON.stringify(rows, null, 1)); return; }

  const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
  const newAttrs = (r, k) => (r[k] ? r[k].attrs.filter((a) => !r.summary.attrs.includes(a)) : []);
  console.log(`원문 있는 법안: ${rows.filter((r) => r.has_doc).length}/${rows.length}`);
  console.log(`대조 통과 기준 수: 요약 ${sum((r) => r.summary.passed)}, 원문 전체 ${sum((r) => r.doc ? r.doc.passed : 0)}, 원문 본문(대비표 앞) ${sum((r) => r.body ? r.body.passed : 0)}`);
  console.log(`버린 후보 수: 요약 ${sum((r) => r.summary.dropped)}, 원문 전체 ${sum((r) => r.doc ? r.doc.dropped : 0)}`);
  console.log(`위임 문구 수(findDelegation): 요약 ${sum((r) => r.summary.delegation_phrases)}, 원문 ${sum((r) => r.doc ? r.doc.delegation_phrases : 0)}`);
  console.log(`기준이 하나라도 뽑힌 법안: 요약 ${rows.filter((r) => r.summary.passed).length}, 원문 전체 ${rows.filter((r) => r.doc && r.doc.passed).length}, 원문 본문 ${rows.filter((r) => r.body && r.body.passed).length}`);
  ATTRS.forEach((a) => {
    console.log(`  ${a}: 요약 ${rows.filter((r) => r.summary.attrs.includes(a)).length}건, 원문 전체 ${rows.filter((r) => r.doc && r.doc.attrs.includes(a)).length}건, 원문 본문 ${rows.filter((r) => r.body && r.body.attrs.includes(a)).length}건, 원문에서 새로 ${rows.filter((r) => newAttrs(r, "doc").includes(a)).length}건`);
  });
  const tally = (k) => {
    const c = {};
    rows.forEach((r) => Object.values(r[k]).forEach((v) => { c[v] = (c[v] || 0) + 1; }));
    return Object.entries(c).map(([k2, v]) => `${k2} ${v}`).join(", ");
  };
  console.log(`시범 규칙과 비교(기준 종류 수): 요약 [${tally("agree_summary")}]`);
  console.log(`                              원문 전체 [${tally("agree_doc")}]`);
  console.log(`                              원문 본문 [${tally("agree_body")}]`);
  console.log(`검토보고서: 있는 법안 ${rows.filter((r) => r.review).length}, 대조 통과 기준 ${sum((r) => r.review ? r.review.passed : 0)}, 시범 규칙과 비교 [${tally("agree_review")}]`);
  const txt = (rule) => attrsOf(rule).map((a) => a + "=" + JSON.stringify(rule[a])).join(" ") || "-";
  console.log("\n| 의안번호 | 시범 규칙 | 요약에서 | 원문 전체에서 | 원문 본문에서 | 원문에서 새로 |");
  console.log("|---|---|---|---|---|---|");
  rows.forEach((r) => {
    console.log(`| ${r.no} | ${txt(r.pilot)} | ${txt(r.summary.rule)} | ${r.doc ? txt(r.doc.rule) : "(원문 없음)"} | ${r.body ? txt(r.body.rule) : "-"} | ${newAttrs(r, "doc").join("·") || "-"} |`);
  });
}

if (require.main === module) main();
module.exports = { prepDoc, bodyOnly };
