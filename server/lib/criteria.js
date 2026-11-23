/*
 * 법안 요약에서 적용 기준 뽑기와 원문 대조 (검토 에이전트의 extract_criteria 도구)
 *
 * 뽑기는 정규식으로 한다 (AI 호출 없음, 토큰을 쓰지 않음). 뽑은 기준마다 근거 문구(evidence)를 붙인다.
 * 대조는 collect/build_web_data.py 의 check_source() 와 같은 생각이다.
 *   1. 근거 문구가 법안 요약 원문에 그대로 있어야 한다 (공백만 맞춘다)
 *   2. 연면적·층수·세대수 수치는 근거 문구에 나와야 한다 (1000 → 1000, 1,000, 1천 / 100000 → 10만)
 *   3. 사용승인은 기준일(REF_DATE) - N년 이고, 근거 문구에 "N년" 이 있어야 한다
 *   4. 뽑은 값 자체가 근거 문장 안에 있어야 한다 ("근거 문장에 없는 값 제외")
 *      - 용도: 그 코드의 시설 이름(별표1 호 이름, 하위 시설 예. 예: 물류터미널 → 창고시설)이 근거에 있어야 한다
 *      - 연면적: 수치와 면적 단위(㎡·제곱미터), 층수: 수치와 "층", 세대수: 수치 바로 뒤에 "세대" (30세대, 1천 세대), 위임: 위임한 기준 이름
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
// 수치 바로 뒤에 단위가 붙어 있는지 (30세대, 1천 세대, 1,000세대)
function numberWithUnit(n, unit, text) {
  return numberForms(n).some((f) => new RegExp("(?<![\\d,])" + escapeRe(f) + "\\s*" + unit).test(text));
}
const NUM_ATTRS = ["연면적", "층수", "세대수"];

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
  // 세대수: "30세대 이상", "1천세대 이상". "1세대 1주택", "1세대당" 처럼 경계 낱말이 바로 붙지 않으면 뽑지 않는다
  const hh = /(\d[\d,]*)\s*(만|천)?\s*세대\s*(이상|이하|미만|초과)/g;
  while ((m = hh.exec(text))) {
    let v = Number(m[1].replace(/,/g, ""));
    if (m[2] === "만") v *= 10000;
    if (m[2] === "천") v *= 1000;
    out.push({ attr: "세대수", bound: toBound(m[3]), value: v, quote: quoteAround(text, m.index, m[0].length) });
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

// ---------------------------------------------------------------- 현행·개정·통계 문장 나누기
/*
 * 제안이유에는 지금 법 설명(현행), 통계·배경, 바꾸려는 내용(개정)이 섞여 있다. 수치 기준은 개정 내용에서만 받는다.
 * 문장은 ". " 에서 나누고 (quoteAround 와 같은 경계), 한 문장 안에서도 "…으나, " "…지만, " 뒤에서 한 번 더 나눈다
 * ("현행법은 300세대 이상으로 하고 있으나, 이를 30세대 이상으로 확대하려는 것임" 의 앞뒤를 따로 본다).
 * 조각마다 아래 순서로 처음 맞는 종류를 붙인다.
 *   1. 개정 (강)   하려는 것 · 하려 함 · 하고자 함 · 개정안은 · (안 제N조)
 *   2. 현행        현행 · 현재는 · 종전에는 · 으로 되어 있 · 하고 있으나 · 규정하고 있(규정하고 있어 포함) · 정하고 있
 *   3. 통계·배경   에 달함 · 로 나타남 · 로 조사 · N% · 퍼센트 · 비율 · 건수 · 연도별 · 차지하고 · 지적이 · 의견이 있 · 필요가 있다는 · 상황임 · 실정임
 *   4. 개정 (약)   확대 · 신설 · 상향 · 하향 · 강화 · 완화 · 개정 · 하도록 함
 *   5. 기타
 * 수치 기준(연면적·층수·세대수·사용승인)은
 *   - 현행 조각의 수치는 판정 규칙에 넣지 않고 current(현행 기준, 참고)로 따로 둔다
 *   - 통계·배경 조각의 수치는 버린다
 *   - 기타 조각의 수치는 같은 기준이 개정 조각에 없을 때만 받는다 (개정 조각에 있으면 그것만)
 */
const SENT_ATTRS = ["연면적", "층수", "세대수", "사용승인"];
const KIND_AMEND = "개정", KIND_CURRENT = "현행", KIND_STAT = "통계·배경", KIND_OTHER = "기타";
const WHY_CURRENT = "현행 기준 설명 문장";
const WHY_STAT = "통계·배경 문장";
const WHY_OTHER = "개정 문장에 같은 기준이 있어 기타 문장 값은 쓰지 않음";
const SENT_RULES = [
  [KIND_AMEND, /하려는\s*것|하려\s*함|하려고\s*함|하고자\s*함|하고자\s*하는\s*것|개정안은|\(\s*안\s*제\s*\d+\s*조/],
  [KIND_CURRENT, /현행|현재는|종전에는|종전의\s*규정|(?:으로|로)\s*되어\s*있|하고\s*있으나|규정하고\s*있|정하고\s*있/],
  [KIND_STAT, /에\s*달하|에\s*달함|(?:으로|로)\s*나타나|(?:으로|로)\s*나타남|(?:으로|로)\s*조사|\d\s*%|퍼센트|비율|건수|연도별|차지하고|지적이|지적도|의견이\s*있|필요가\s*있다는|상황임|실정임/],
  [KIND_AMEND, /확대|신설|상향|하향|강화|완화|개정|하도록\s*함/],
];
function sentenceKind(s) {
  const hit = SENT_RULES.find(([, re]) => re.test(s));
  return hit ? hit[0] : KIND_OTHER;
}

/** 글을 문장(조각)으로 나누고 종류를 붙인다: [{text, kind, start, end}] (start·end 는 normText 한 글 안의 위치) */
function classifySentences(text0) {
  const text = normText(text0);
  const out = [];
  const cut = /\.\s+|(?:으나|지만),\s+/g;
  let start = 0, m;
  while ((m = cut.exec(text))) {
    const end = m.index + m[0].length;
    out.push({ start, end });
    start = end;
  }
  if (start < text.length) out.push({ start, end: text.length });
  return out.map((p) => {
    const t = text.slice(p.start, p.end).trim();
    return { text: t, kind: sentenceKind(t), start: p.start, end: p.end };
  }).filter((p) => p.text);
}

// 후보 수치가 근거 문구 안 어디에 있는지 (세대수는 "N세대", 층수는 "N층", 사용승인은 "N년", 연면적은 수치)
function valueRe(c) {
  const forms = c.attr === "사용승인" ? [String(Number(REF_DATE.slice(0, 4)) - Number(String(c.value).slice(0, 4)))] : numberForms(c.value);
  const unit = c.attr === "세대수" ? "\\s*세대" : c.attr === "층수" ? "\\s*층" : c.attr === "사용승인" ? "\\s*년" : "";
  return new RegExp("(?<![\\d,])(?:" + forms.map(escapeRe).join("|") + ")(?![\\d,])" + unit, "g");
}
/** 후보 하나가 놓인 문장 종류들 (근거 문구가 원문에 나오는 모든 자리, 그 안에서 수치가 있는 조각) */
function candidateKinds(c, text, sents) {
  const quote = normText(c.quote);
  const kinds = new Set();
  let at = text.indexOf(quote);
  while (at >= 0) {
    const re = valueRe(c);
    let m, found = false;
    while ((m = re.exec(quote))) {
      found = true;
      const pos = at + m.index;
      const s = sents.find((x) => pos >= x.start && pos < x.end);
      if (s) kinds.add(s.kind);
    }
    if (!found) { const s = sents.find((x) => at >= x.start && at < x.end); if (s) kinds.add(s.kind); }
    at = text.indexOf(quote, at + 1);
  }
  return kinds;
}

/**
 * 후보마다 원문 대조. 통과한 것만 규칙으로 묶는다.
 * opts.sentences (기본 true): 위 현행·개정 문장 나누기를 쓴다. 현행 문장의 수치는 current 로 따로 돌려준다.
 *   의안 원문의 개정 부분(amendedText)은 이미 고친 뒤 글만이라 false 로 부른다.
 *   data/verify_cases.json (노트북 파이썬 대조와 맞추는 사례) 도 false 로 만든다.
 * 돌려줌: { rule, evidence, dropped, current }
 */
function verify(candidates, summary, opts = {}) {
  const text = normText(summary);
  const useSent = opts.sentences !== false;
  const sents = useSent ? classifySentences(text) : [];
  const rule = {}, evidence = [], dropped = [], current = {};
  // 수치 기준마다 개정 문장에 놓인 후보가 있는지 (있으면 기타 문장 후보는 쓰지 않음)
  const amendAttrs = new Set();
  const kindsOf = new Map();
  const requoted = new Map(); // i → 개정 문장 (모델이 다른 문장을 근거로 골랐지만 같은 수치·단위가 개정 문장에 있을 때)
  if (useSent) candidates.forEach((c, i) => {
    if (!c || !SENT_ATTRS.includes(c.attr) || !c.quote) return;
    const v = c.attr === "사용승인" ? String(c.value) : Number(String(c.value).replace(/,/g, ""));
    let k = candidateKinds({ attr: c.attr, value: v, quote: c.quote }, text, sents);
    if (!k.has(KIND_AMEND) && text.includes(normText(c.quote))) {
      // 같은 수치·단위가 들어 있는 개정 문장이 꼭 하나면 그 문장을 근거로 바꾼다 (코드 규칙, 모델 판단 아님)
      const hits = sents.filter((s) => s.kind === KIND_AMEND && valueRe({ attr: c.attr, value: v }).test(s.text) &&
        (c.attr !== "연면적" || AREA_UNIT.test(s.text)));
      if (hits.length === 1) { requoted.set(i, hits[0].text); k = new Set([KIND_AMEND]); }
    }
    kindsOf.set(i, k);
    if (k.has(KIND_AMEND)) amendAttrs.add(c.attr);
  });
  candidates.forEach((c0, i) => {
    // AI 가 낸 값의 형태를 맞춘다 (숫자 문자열 → 숫자, 용도 한 개 → 배열)
    const c = Object.assign({}, c0);
    if (requoted.has(i)) c.quote = requoted.get(i);
    if (NUM_ATTRS.includes(c.attr)) c.value = Number(String(c.value).replace(/,/g, ""));
    if (c.attr === "용도" && !Array.isArray(c.value)) c.value = [String(c.value)];
    if (c.attr === "위임") c.value = String(c.value);
    const quote = normText(c.quote);
    let why = "";
    if (!["용도", "연면적", "층수", "세대수", "사용승인", "위임"].includes(c.attr)) why = "모르는 기준";
    else if (NUM_ATTRS.includes(c.attr) && (!isFinite(c.value) || c.value <= 0 || !["min", "max"].includes(c.bound))) why = "수치나 경계(min·max)가 올바르지 않음";
    else if (!quote || !text.includes(quote)) why = "근거 문구가 요약 원문에 그대로 없음";
    else if (NUM_ATTRS.includes(c.attr) && !numberInText(c.value, quote)) why = "수치 " + c.value + " 가 근거 문구에 없음";
    else if (c.attr === "사용승인") {
      const years = Number(REF_DATE.slice(0, 4)) - Number(String(c.value).slice(0, 4));
      if (String(c.value).slice(4) !== REF_DATE.slice(4) || !new RegExp("(?<!\\d)" + years + "\\s*년").test(quote)) why = "근거 문구에 '" + years + "년' 이 없음";
    } else if (c.attr === "용도" && !(Array.isArray(c.value) && c.value.every((v) => USE_NAMES[v]))) why = "모르는 용도 코드";
    else if (c.attr === "연면적" && !AREA_UNIT.test(quote)) why = NOT_IN_QUOTE + " (면적 단위)";
    else if (c.attr === "층수" && !new RegExp("(?<![\\d,])" + c.value + "\\s*층").test(quote)) why = NOT_IN_QUOTE + " (" + c.value + "층)";
    else if (c.attr === "세대수" && !numberWithUnit(c.value, "세대", quote)) why = NOT_IN_QUOTE + " (" + c.value + "세대)";
    else if (c.attr === "위임" && !quote.replace(/\s+/g, "").includes(c.value.replace(/\s+/g, ""))) why = NOT_IN_QUOTE + " (" + c.value + ")";
    // 위임은 근거 문장에 실제 위임 문구(대통령령·부령·조례로 정하는 …)가 있어야 하고, 값은 짧은 기준 이름이어야 한다
    else if (c.attr === "위임" && !new RegExp(DELEG_RE.source).test(quote)) why = DELEG_NO_PHRASE;
    else if (c.attr === "위임" && c.value.replace(/\s+/g, "").length > DELEG_VALUE_MAX) why = DELEG_LONG_VALUE;
    if (why) { dropped.push({ attr: c.attr, value: c.value, why }); return; }
    // 문장 종류: 현행 문장 수치는 current 로, 통계·배경 문장 수치는 버림, 기타 문장은 개정 문장에 같은 기준이 없을 때만
    if (useSent && kindsOf.has(i)) {
      const k = kindsOf.get(i);
      const ok = k.has(KIND_AMEND) || (k.has(KIND_OTHER) && !amendAttrs.has(c.attr));
      if (!ok) {
        const w = k.has(KIND_CURRENT) ? WHY_CURRENT : k.has(KIND_STAT) ? WHY_STAT : WHY_OTHER;
        dropped.push({ attr: c.attr, value: c.value, why: w });
        if (w === WHY_CURRENT) {
          if (c.attr === "사용승인") current.사용승인 = current.사용승인 || { before: c.value };
          else {
            current[c.attr] = current[c.attr] || {};
            if (current[c.attr][c.bound] === undefined) current[c.attr][c.bound] = c.value;
          }
        }
        return;
      }
    }
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
  return { rule, evidence, dropped, current };
}

function extract(summary, opts) { return verify(extractCandidates(summary), summary, opts); }

/** 규칙 한 줄 설명 (crosscheck.json 의 ours 와 같은 표기: "100,000㎡ 이상", "2층 이하", "운수시설·공장") */
function ruleTexts(rule) {
  const out = {};
  if (rule.용도) out.용도 = rule.용도.map((c) => USE_NAMES[c] || c).join("·");
  [["연면적", "㎡"], ["층수", "층"], ["세대수", "세대"]].forEach(([k, unit]) => {
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

/** 현행 기준 한 줄 설명 (current → {세대수: "300세대 이상, 300세대 이하"}). 판정에 쓰지 않는 참고 값 */
function currentTexts(current) { return ruleTexts(current || {}); }

// ---------------------------------------------------------------- 의안 원문에서 "개정 부분"만 고르기
/*
 * 의안 원문(PDF 에서 뽑은 글)에는 제안이유, 개정문, 부칙, 신·구조문대비표가 다 들어 있다.
 * 제안이유는 지금 법 설명이 섞이고, 대비표는 PDF 글에서 "현 행" 칸과 "개 정 안" 칸이 섞여 나와 칸별로 믿을 수 없다.
 * 그래서 원문에서 기준을 뽑을 때는 개정문("…일부를 다음과 같이 개정한다." 다음부터 부칙 또는 대비표 앞까지)에서
 * 새로 들어가는 글만 쓴다.
 *   - 제N조 … 중 "A"를 "B"로 한다          → B 만 (A 는 지금 법 글)
 *   - … 다음과 같이 신설한다 / 다음과 같이 한다 → 그 뒤에 오는 새 글
 *   - 정의 조문(제2조, 제목에 "정의"가 든 조)을 고치는 것 → 뺀다
 * 개정문을 못 찾으면 "" 를 돌려준다 (원문 전체로 대신하지 않는다).
 */

/** PDF 에서 뽑은 원문을 한 덩어리 글로: 쪽 번호("- 3 -")와 대비표의 "-----" 를 지우고 줄은 공백 없이 잇는다 (PDF 줄바꿈은 낱말 중간에서 끊김) */
function prepDocText(raw) {
  return String(raw || "").split(/\r?\n/)
    .filter((l) => !/^\s*-\s*\d+\s*-\s*$/.test(l))
    .map((l) => l.replace(/-{3,}/g, " ").replace(/\s+$/, ""))
    .join("")
    .replace(/\s+/g, " ").trim();
}

const AMEND_START = /다음과\s*같이\s*개정한다\s*\./;
const AMEND_END = /부\s*칙|신\s*[ㆍ·]\s*구\s*조\s*문\s*대\s*비\s*표/;
// 따옴표 글 하나 (안에 따옴표가 한 겹 더 있어도 됨: “건축물(이하 “공공건축물”이라 한다)”)
const QUOTED = "“(?:[^“”]|“[^”]*”)*”";
// 개정 지시문: 제N조(…)로 시작해 "…로 한다." / "…신설한다." / "…같이 한다." / "…삭제한다." 로 끝나는 한 문장.
// 따옴표 밖에는 마침표가 없다. "제45조의17에 따른" 처럼 다른 법 조문을 가리키는 말은 지시문 시작이 아니다
const INSTR = new RegExp(
  "(?:제\\d+장(?:제\\d+절)?에\\s*)?제\\d+조(?:의\\d+)?(?![\\d(]|의\\d)(?!(?:제\\d+[항호목](?:의\\d+)?)*\\s*(?:에\\s*)?(?:따른|따라|의한|의하여|관한|해당|규정))" +
  "(?:[^.“”]|" + QUOTED + ")*?(?:로|신설|같이|삭제)\\s*한다\\.", "g");
const PAIR = new RegExp("(" + QUOTED + ")\\s*(?:을|를)\\s*(" + QUOTED + ")\\s*(?:으로|로)", "g");
const INSTR_VERB = /중\s*“|다음과\s*같이|각각|삭제|(?:을|를)\s*제\d+/;

/** 원문 어디서든(대비표 제목 포함) "제N조(…정의…)" 꼴로 나온 조 번호 */
function definitionArticles(text) {
  const out = new Set(["2"]); // 법률의 제2조는 거의 언제나 정의 조문
  const re = /제(\d+)조(의\d+)?\s*\(([^)]{0,40})\)/g;
  let m;
  while ((m = re.exec(text))) if (/정의/.test(m[3])) out.add(m[1] + (m[2] || ""));
  return out;
}
function targetArticle(instr) {
  const m = /제(\d+)조(의\d+)?/.exec(instr);
  return m ? m[1] + (m[2] || "") : "";
}
// 새로 넣는 조 글의 제목이 정의인지: "제12조의2(정의) …"
function isDefinitionText(t) { return /^제\d+조(?:의\d+)?\s*\([^)]*정의[^)]*\)/.test(t); }

/**
 * 의안 원문 → 기준 근거로 받아 줄 "개정 부분" 글. 고친 뒤 들어가는 글(B, 신설 글, 바꾸는 글)만 ". " 로 이어 붙인다.
 * 개정문이 없으면 "".
 */
function amendedText(raw) {
  const text = /\n/.test(String(raw || "")) ? prepDocText(raw) : normText(raw);
  const s = AMEND_START.exec(text);
  if (!s) return "";
  const from = s.index + s[0].length;
  const rest = text.slice(from);
  const e = rest.search(AMEND_END);
  const body = e >= 0 ? rest.slice(0, e) : rest;
  const defs = definitionArticles(text);

  // 지시문을 차례로 찾는다. 따옴표 밖 지시 낱말(중 “ / 다음과 같이 / 각각 / 삭제)이 없으면 지시문이 아니다
  const instrs = [];
  INSTR.lastIndex = 0;
  let m;
  while ((m = INSTR.exec(body))) {
    const bare = m[0].replace(new RegExp(QUOTED, "g"), "“”");
    if (!INSTR_VERB.test(bare) || /^제\d+조(?:의\d+)?\s*\(/.test(m[0])) { INSTR.lastIndex = m.index + 1; continue; }
    instrs.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  const pieces = [];
  instrs.forEach((ins, i) => {
    const art = targetArticle(ins.text);
    if (defs.has(art)) return; // 정의 조문을 고치는 것은 통째로 뺀다
    let p;
    PAIR.lastIndex = 0;
    while ((p = PAIR.exec(ins.text))) pieces.push(p[2].slice(1, -1)); // B 만
    if (/다음과\s*같이/.test(ins.text.replace(new RegExp(QUOTED, "g"), "“”"))) {
      const next = i + 1 < instrs.length ? instrs[i + 1].start : body.length;
      const added = body.slice(ins.end, next).trim();
      if (added && !isDefinitionText(added)) pieces.push(added);
    }
  });
  return pieces.map((t) => normText(t).replace(/\.$/, "")).filter(Boolean).join(". ").concat(pieces.length ? "." : "");
}

const AMBIGUOUS = "개정 부분에 같은 기준의 수치가 여럿 (각 호 중 하나의 조건일 수 있어 버림)";

/**
 * 의안 원문에서 기준 뽑기: 개정 부분 글(amendedText)에서만 뽑고 그 글로 대조한다.
 * 개정 부분에서 같은 기준(연면적 이상 등)의 수치가 둘 이상 다르게 나오면 ("다음 각 호의 어느 하나" 목록 등)
 * 어느 것이 대상 기준인지 알 수 없으므로 그 기준은 버린다.
 */
function extractFromDoc(raw) {
  const text = amendedText(raw);
  if (!text) return { text, rule: {}, evidence: [], dropped: [] };
  const cands = extractCandidates(text);
  const vals = {};
  cands.forEach((c) => {
    if (!NUM_ATTRS.includes(c.attr)) return;
    const k = c.attr + "|" + c.bound;
    (vals[k] = vals[k] || new Set()).add(c.value);
  });
  const amb = new Set(Object.keys(vals).filter((k) => vals[k].size > 1));
  const dropped0 = [];
  const kept = cands.filter((c) => {
    if (!amb.has(c.attr + "|" + c.bound)) return true;
    dropped0.push({ attr: c.attr, value: c.value, why: AMBIGUOUS });
    return false;
  });
  const r = verify(kept, text, { sentences: false }); // 개정 부분 글은 이미 고친 뒤 글만
  return { text, rule: r.rule, evidence: r.evidence, dropped: dropped0.concat(r.dropped) };
}

module.exports = { KIND_AMEND, KIND_CURRENT, KIND_STAT, KIND_OTHER, WHY_CURRENT, WHY_STAT, WHY_OTHER, classifySentences, currentTexts,
  NUM_ATTRS, NOT_IN_QUOTE, DELEG_NO_PHRASE, DELEG_LONG_VALUE, useTermIn, findDelegation, REF_DATE, normText, numberForms, numberInText, extractCandidates, verify, extract, ruleTexts,
  prepDocText, amendedText, extractFromDoc };
