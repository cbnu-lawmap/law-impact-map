/*
 * 법안 요약에서 적용 기준 뽑기와 원문 대조 (검토 에이전트의 extract_criteria 도구)
 *
 * 뽑기는 정규식으로 한다 (AI 호출 없음, 토큰을 쓰지 않음). 뽑은 기준마다 근거 문구(evidence)를 붙인다.
 * 대조는 collect/build_web_data.py 의 check_source() 와 같은 생각이다.
 *   1. 근거 문구가 법안 요약 원문에 그대로 있어야 한다 (공백만 맞춘다)
 *   2. 연면적·층수 수치는 근거 문구에 나와야 한다 (1000 → 1000, 1,000, 1천 / 100000 → 10만)
 *   3. 사용승인은 기준일(REF_DATE) - N년 이고, 근거 문구에 "N년" 이 있어야 한다
 *   4. 뽑은 값 자체가 근거 문장 안에 있어야 한다 ("근거 문장에 없는 값 제외")
 *      - 용도: 그 코드의 시설 이름(별표1 호 이름, 하위 시설 예. 예: 물류터미널 → 창고시설)이 근거에 있어야 한다
 *      - 연면적: 수치와 면적 단위(㎡·제곱미터), 층수: 수치와 "층", 위임: 위임한 기준 이름
 * 하나라도 어긋나면 그 기준은 버린다. 나중에 AI 가 뽑은 기준을 넣어도 같은 대조를 거친다.
 */
const { USE_NAMES } = require("./judge");
const USE_TERMS = require("./use-terms"); // data/building_use_codes.csv 에서 만든 시설 이름표
const NOT_IN_QUOTE = "근거 문장에 없는 값 제외";
const DELEG_NO_PHRASE = "근거 문장에 위임 문구(대통령령·부령·조례로 정하는) 없음";
const DELEG_LONG_VALUE = "위임 값이 기준 이름이 아님 (너무 긺)";
const DELEG_VALUE_MAX = 15; // 예: 규모, 용도, 소방시설 기준, 국토교통부령

const REF_DATE = "2026-11-01"; // collect/build_web_data.py 의 REF_DATE 와 같게
const MAX_QUOTE = 160;

function normText(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

function numberForms(n) {
  const forms = new Set([String(n), Number(n).toLocaleString("en-US")]);
  if (Number.isInteger(n)) {
    if (n >= 10000 && n % 10000 === 0) forms.add(n / 10000 + "만");
    if (n >= 1000 && n % 1000 === 0 && n < 10000) forms.add(n / 1000 + "천");
  }
  return Array.from(forms);
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function numberInText(n, text) {
  return numberForms(n).some((f) => new RegExp("(?<![\\d,])" + escapeRe(f) + "(?![\\d,])").test(text));
}

// 용도 낱말 → 건축물대장 주용도 코드. "학교", "병원" 처럼 주변 설명에도 흔히 나오는 말은 넣지 않는다
const USE_WORDS = [
  [/공동주택|아파트/, ["02000"]],
  [/단독주택/, ["01000"]],
  [/제1종\s*근린생활시설/, ["03000"]],
  [/제2종\s*근린생활시설/, ["04000"]],
  [/(?<!제[12]종\s*)근린생활시설/, ["03000", "04000"]],
  [/문화\s*및\s*집회시설|전시시설|공연장/, ["05000"]],
  [/종교시설/, ["06000"]],
  [/판매시설/, ["07000"]],
  [/운수시설|여객터미널/, ["08000"]],
  [/의료시설/, ["09000"]],
  [/교육연구시설/, ["10000"]],
  [/노유자시설/, ["11000"]],
  [/수련시설/, ["12000"]],
  [/운동시설/, ["13000"]],
  [/업무시설/, ["14000"]],
  [/숙박시설/, ["15000"]],
  [/위락시설/, ["16000"]],
  [/공장/, ["17000"]],
  [/창고|물류터미널|물류시설|집배송/, ["18000"]],
  [/위험물/, ["19000"]],
  [/자동차\s*관련\s*시설/, ["20000"]],
  [/장례시설/, ["28000"]],
];

// 원문에서 match 위치를 담은 문장(너무 길면 앞뒤를 잘라 160자 안)을 근거 문구로 쓴다. 항상 원문의 부분 문자열이다
function quoteAround(text, index, length) {
  let start = text.lastIndexOf(". ", index);
  start = start < 0 ? 0 : start + 2;
  let end = text.indexOf(". ", index + length);
  end = end < 0 ? text.length : end + 1;
  if (end - start > MAX_QUOTE) {
    const pad = Math.max(0, Math.floor((MAX_QUOTE - length) / 2));
    start = Math.max(start, index - pad);
    end = Math.min(end, start + MAX_QUOTE);
  }
  return text.slice(start, end).trim();
}

// 코드의 시설 이름 중 근거 문장(공백 무시)에 나온 것. 없으면 null
function useTermIn(code, quote) {
  const q = String(quote || "").replace(/\s+/g, "");
  return (USE_TERMS[code] || []).find((t) => q.includes(t)) || null;
}
const AREA_UNIT = /제곱미터|㎡|평방미터|m2|m²/;

function toBound(word) { return word === "이상" || word === "초과" ? "min" : "max"; }

/** 요약 원문에서 기준 후보를 뽑는다: [{attr, bound?, value, quote}] */
function extractCandidates(summary) {
  const text = normText(summary);
  const out = [];
  let m;
  const area = /연면적(?:이|은|의|이\s*합계)?\s*(\d[\d,]*(?:\.\d+)?)\s*(만|천)?\s*(?:제곱미터|㎡|평방미터|m2)\s*(이상|이하|미만|초과)/g;
  while ((m = area.exec(text))) {
    let v = Number(m[1].replace(/,/g, ""));
    if (m[2] === "만") v *= 10000;
    if (m[2] === "천") v *= 1000;
    out.push({ attr: "연면적", bound: toBound(m[3]), value: v, quote: quoteAround(text, m.index, m[0].length) });
  }
  const floor = /(\d{1,3})\s*층\s*(이상|이하|미만|초과)/g;
  while ((m = floor.exec(text))) {
    out.push({ attr: "층수", bound: toBound(m[2]), value: Number(m[1]), quote: quoteAround(text, m.index, m[0].length) });
  }
  const age = /(?:준공|사용승인)[^.]{0,15}?(\d{1,3})\s*년\s*(?:이상|이 지난|경과)/g;
  while ((m = age.exec(text))) {
    const before = String(Number(REF_DATE.slice(0, 4)) - Number(m[1])) + REF_DATE.slice(4);
    out.push({ attr: "사용승인", value: before, quote: quoteAround(text, m.index, m[0].length) });
  }
  USE_WORDS.forEach(([re, codes]) => {
    const g = new RegExp(re.source, "g");
    const hit = g.exec(text);
    if (hit) out.push({ attr: "용도", value: codes, quote: quoteAround(text, hit.index, hit[0].length) });
  });
  // 판정 규칙에 넣는 위임은 예전과 같이 "대통령령으로 정하는 … 용도/규모" 만 (판정 수가 바뀌지 않게)
  findDelegation(text).filter((d) => d.by === "대통령령" && (d.value === "용도" || d.value === "규모"))
    .forEach((d) => out.push({ attr: "위임", value: d.value, quote: d.quote }));
  return out;
}

// 위임 문구: "대통령령으로 정하는 규모", "국토교통부령으로 정한다", "조례로 정하는" 등
const DELEG_RE = /(대통령령|총리령|[가-힣]{1,10}부령|[가-힣]{0,6}조례)(?:으로|로)\s*정(?:하는|한다|함|할|해)([^.]{0,30}?(용도|규모|기준|범위|요건))?/g;

/**
 * 요약 원문에서 위임 문구를 코드로 찾는다 (모델 결과와 상관없이 같은 답).
 * 값은 위임한 기준 이름(용도·규모·기준 …)이고, 없으면 위임한 법령 이름(대통령령 …). 값과 문구는 항상 원문에 있다.
 */
function findDelegation(summary) {
  const text = normText(summary);
  const out = [], seen = new Set();
  let m;
  DELEG_RE.lastIndex = 0;
  while ((m = DELEG_RE.exec(text))) {
    const value = m[3] || m[1];
    const quote = quoteAround(text, m.index, m[0].length);
    if (seen.has(value + "|" + quote)) continue;
    seen.add(value + "|" + quote);
    out.push({ attr: "위임", value, quote, by: m[1] });
  }
  return out;
}

/** 후보마다 원문 대조. 통과한 것만 규칙으로 묶는다. */
function verify(candidates, summary) {
  const text = normText(summary);
  const rule = {}, evidence = [], dropped = [];
  candidates.forEach((c0) => {
    // AI 가 낸 값의 형태를 맞춘다 (숫자 문자열 → 숫자, 용도 한 개 → 배열)
    const c = Object.assign({}, c0);
    if (c.attr === "연면적" || c.attr === "층수") c.value = Number(String(c.value).replace(/,/g, ""));
    if (c.attr === "용도" && !Array.isArray(c.value)) c.value = [String(c.value)];
    if (c.attr === "위임") c.value = String(c.value);
    const quote = normText(c.quote);
    let why = "";
    if (!["용도", "연면적", "층수", "사용승인", "위임"].includes(c.attr)) why = "모르는 기준";
    else if ((c.attr === "연면적" || c.attr === "층수") && (!isFinite(c.value) || c.value <= 0 || !["min", "max"].includes(c.bound))) why = "수치나 경계(min·max)가 올바르지 않음";
    else if (!quote || !text.includes(quote)) why = "근거 문구가 요약 원문에 그대로 없음";
    else if ((c.attr === "연면적" || c.attr === "층수") && !numberInText(c.value, quote)) why = "수치 " + c.value + " 가 근거 문구에 없음";
    else if (c.attr === "사용승인") {
      const years = Number(REF_DATE.slice(0, 4)) - Number(String(c.value).slice(0, 4));
      if (String(c.value).slice(4) !== REF_DATE.slice(4) || !new RegExp("(?<!\\d)" + years + "\\s*년").test(quote)) why = "근거 문구에 '" + years + "년' 이 없음";
    } else if (c.attr === "용도" && !(Array.isArray(c.value) && c.value.every((v) => USE_NAMES[v]))) why = "모르는 용도 코드";
    else if (c.attr === "연면적" && !AREA_UNIT.test(quote)) why = NOT_IN_QUOTE + " (면적 단위)";
    else if (c.attr === "층수" && !new RegExp("(?<![\\d,])" + c.value + "\\s*층").test(quote)) why = NOT_IN_QUOTE + " (" + c.value + "층)";
    else if (c.attr === "위임" && !quote.replace(/\s+/g, "").includes(c.value.replace(/\s+/g, ""))) why = NOT_IN_QUOTE + " (" + c.value + ")";
    // 위임은 근거 문장에 실제 위임 문구(대통령령·부령·조례로 정하는 …)가 있어야 하고, 값은 짧은 기준 이름이어야 한다
    else if (c.attr === "위임" && !new RegExp(DELEG_RE.source).test(quote)) why = DELEG_NO_PHRASE;
    else if (c.attr === "위임" && c.value.replace(/\s+/g, "").length > DELEG_VALUE_MAX) why = DELEG_LONG_VALUE;
    if (why) { dropped.push({ attr: c.attr, value: c.value, why }); return; }
    if (c.attr === "용도") {
      // 코드마다 따로 본다: 근거에 시설 이름이 있는 코드만 남기고 나머지는 버린다
      const kept = c.value.filter((v) => useTermIn(v, quote));
      const gone = c.value.filter((v) => !useTermIn(v, quote));
      if (gone.length) dropped.push({ attr: "용도", value: gone, why: NOT_IN_QUOTE + " (" + gone.map((v) => USE_NAMES[v] || v).join("·") + ")" });
      if (!kept.length) return;
      c.value = kept;
    }

    if (c.attr === "용도") rule.용도 = Array.from(new Set((rule.용도 || []).concat(c.value)));
    else if (c.attr === "위임") rule.위임 = Array.from(new Set((rule.위임 || []).concat(c.value)));
    else if (c.attr === "사용승인") rule.사용승인 = { before: c.value };
    else {
      rule[c.attr] = rule[c.attr] || {};
      if (rule[c.attr][c.bound] !== undefined) { dropped.push({ attr: c.attr, value: c.value, why: "같은 기준이 여러 번 나와 처음 것만 씀" }); return; }
      rule[c.attr][c.bound] = c.value;
    }
    evidence.push({ attr: c.attr, value: c.value, quote });
  });
  return { rule, evidence, dropped };
}

function extract(summary) { return verify(extractCandidates(summary), summary); }

/** 규칙 한 줄 설명 (crosscheck.json 의 ours 와 같은 표기: "100,000㎡ 이상", "2층 이하", "운수시설·공장") */
function ruleTexts(rule) {
  const out = {};
  if (rule.용도) out.용도 = rule.용도.map((c) => USE_NAMES[c] || c).join("·");
  [["연면적", "㎡"], ["층수", "층"]].forEach(([k, unit]) => {
    const r = rule[k];
    if (!r) return;
    const parts = [];
    if (r.min !== undefined) parts.push(Number(r.min).toLocaleString("en-US") + unit + " 이상");
    if (r.max !== undefined) parts.push(Number(r.max).toLocaleString("en-US") + unit + " 이하");
    out[k] = parts.join(", ");
  });
  if (rule.사용승인) out.사용승인 = rule.사용승인.before + " 이전";
  if (rule.위임 && rule.위임.length) out.위임 = rule.위임.join("·");
  return out;
}

module.exports = { NOT_IN_QUOTE, DELEG_NO_PHRASE, DELEG_LONG_VALUE, useTermIn, findDelegation, REF_DATE, normText, numberForms, numberInText, extractCandidates, verify, extract, ruleTexts };
