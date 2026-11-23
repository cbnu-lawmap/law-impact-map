/*
 * Agentic RAG 의 출처 찾기와 근거 평가 (server/api/agent.js 의 mode "agentic", "rag1" 이 씀)
 *
 *   searchSource(D, no, source)   출처 하나의 글을 돌려준다. 없으면 found:false, text "없음"
 *     summary        제안이유 전문 (summaries.json, 없으면 bills.json 300자 요약)
 *     bill_text      법안 원문의 개정 부분 (bill_docs.json, criteria.js amendedText 로 만든 글)
 *     review_report  검토보고서에서 건물 기준 낱말이 든 문장 (bill_docs.json)
 *     similar_rules  제안이유가 비슷한 시범 법안의 규칙 (TF-IDF). "후보 규칙, 사람 확인 필요" 로만 쓴다
 *   evaluateSource(source, text, candidates)   기준 하나하나를 코드 규칙으로만 나눈다 (모델이 정하지 않음)
 *     판정에 충분  근거 문구가 출처 글에 그대로 있고 수치·단위가 다 있음 (criteria.verify 통과)
 *     위임 확인    수치는 없지만 그 기준을 시행령·부령·조례에 넘긴 위임 문구가 출처 글에 있음 (criteria.findDelegation)
 *     부족         기준을 말하는 낱말은 있지만 위 둘에 못 미침 (예: "일정 규모 이상")
 *   개정문 여부: bill_text 는 개정 부분 글만 싣고, review_report 는 개정 내용을 말하는 문장(개정안·안 제N조·신설·…하려는)에서 나온 기준만 받는다.
 *   원문·검토보고서에서 같은 기준의 수치가 여럿 다르게 나오면 (각 호 중 하나일 수 있음) 그 기준은 버린다.
 */
const Criteria = require("./criteria");
const { tfidfCharWb } = require("./nn");

const SOURCES = ["summary", "bill_text", "review_report", "similar_rules"];
const SOURCE_KO = {
  summary: "요약(제안이유)",
  bill_text: "법안 원문(개정 조문)",
  review_report: "검토보고서",
  similar_rules: "비슷한 법안 규칙",
};
const NONE = "없음";
const CANDIDATE_LABEL = "후보 규칙, 사람 확인 필요";
const ST_OK = "판정에 충분";
const ST_DELEG = "위임 확인";
const ST_LOW = "부족";
const ST_CAND = "후보";
const RANK = { [ST_OK]: 3, [ST_DELEG]: 2, [ST_LOW]: 1 };
const ATTRS = ["용도", "연면적", "층수", "사용승인"];
const CURRENT_LAW = "개정 내용을 말하는 문장이 아님 (현행법·참고 설명일 수 있음)";
// 검토보고서 문장이 개정 내용을 말하는지 (개정안, 안 제N조, 신설, …하려는 것)
const AMEND_MARK = /개정안|안\s*제\s*\d|신설|하려는|하려고|하도록\s*함/;
const AMBIGUOUS = "같은 기준의 수치가 여럿 (각 호 중 하나의 조건일 수 있어 버림)";

// 기준을 말하는 낱말 (수치가 없어도 "이 기준이 있다" 는 신호)
const CUES = {
  용도: null, // 용도 낱말은 extractCandidates 의 용도 후보로 본다
  연면적: /연면적|바닥면적|제곱미터|㎡|규모/,
  층수: /층수|\d+\s*층|고층/,
  사용승인: /준공|사용승인|노후/,
};

// 위임 문구가 그 기준을 넘긴 것인지 (위임한 기준 이름이나 위임 문장에 이 낱말이 있으면)
const DELEG_WORD = { 용도: /용도/, 연면적: /규모|면적/, 층수: /층/, 사용승인: /준공|사용승인|노후/ };

// 다음 출처를 고르는 이유 (평가 결과 → 다음 출처)
const NEXT_WHY = {
  bill_text: "요약에 없는 수치·단위는 개정 조문에 있을 수 있어 법안 원문(개정 조문)을 찾습니다",
  review_report: "개정 조문으로도 부족해 검토보고서의 설명 문장을 찾습니다",
  similar_rules: "문서에서 근거를 다 찾지 못해 비슷한 시범 법안의 규칙을 후보로만 찾습니다 (사람 확인 필요)",
};

// ---------------------------------------------------------------- 비슷한 법안 규칙 (TF-IDF, 나중에 pgvector 로 바꿀 수 있게 함수 하나로)
function buildTfidf(docs) {
  // sklearn TfidfVectorizer(analyzer="char_wb", ngram (2,3), sublinear_tf, smooth idf, l2) 와 같은 셈
  const df = new Map();
  docs.forEach((t) => {
    const seen = new Set();
    String(t).toLowerCase().split(/\s+/).filter(Boolean).forEach((w) => {
      const pw = " " + w + " ";
      for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= pw.length; i++) seen.add(pw.slice(i, i + n));
    });
    seen.forEach((g) => df.set(g, (df.get(g) || 0) + 1));
  });
  const vocab = {}, idf = [];
  Array.from(df.keys()).sort().forEach((g, i) => { vocab[g] = i; idf.push(Math.log((1 + docs.length) / (1 + df.get(g))) + 1); });
  return { type: "tfidf_char_wb", ngram: [2, 3], lowercase: true, sublinear_tf: true, norm: "l2", vocab, idf };
}
function cosine(a, b) {
  let s = 0;
  a.forEach((x, k) => { const y = b.get(k); if (y) s += x * y; });
  return s;
}

/**
 * 시범 규칙이 있는 법안들과 제안이유 전문의 TF-IDF 유사도로 비슷한 법안 k 개를 찾는 함수를 만든다.
 * 돌려주는 함수 similarRules(no, k) 는 [{no, title, score, rule, label}] 를 낸다 (자기 자신은 뺌).
 * pgvector 로 바꿀 때는 같은 모양을 돌려주는 함수를 D.similarRules 에 넣으면 된다.
 */
function createSimilarRules(D) {
  const pilots = Object.keys(D.demos || {});
  const textOf = (no) => (D.full && D.full[no]) || (D.byNo[no] && D.byNo[no].summary) || "";
  const spec = buildTfidf(pilots.map(textOf));
  const vecs = pilots.map((no) => [no, tfidfCharWb(textOf(no), spec)]);
  return function similarRules(no, k = 3) {
    const q = tfidfCharWb(textOf(no), spec);
    return vecs.filter((v) => v[0] !== no)
      .map(([pno, v]) => ({ no: pno, title: D.demos[pno].title, score: Math.round(cosine(q, v) * 1000) / 1000, rule: D.demos[pno].rule, label: CANDIDATE_LABEL }))
      .sort((a, b) => b.score - a.score).slice(0, k);
  };
}

// ---------------------------------------------------------------- 출처 찾기
/** 출처 글 하나. 없으면 {found:false, text:"없음"} */
function searchSource(D, no, source) {
  if (!SOURCES.includes(source)) return { source, source_ko: source, found: false, text: NONE, error: "모르는 출처: " + source };
  const base = { source, source_ko: SOURCE_KO[source] };
  if (source === "summary") {
    const full = D.full && D.full[no];
    const t = full || String((D.byNo[no] && D.byNo[no].summary) || "").replace(/…$/, "");
    return t ? Object.assign(base, { found: true, text: t, chars: t.length, full_text: !!full }) : Object.assign(base, { found: false, text: NONE });
  }
  if (source === "similar_rules") {
    const fn = D.similarRules || (D.similarRules = createSimilarRules(D));
    const cands = fn(no, 3);
    return cands.length ? Object.assign(base, { found: true, text: "", candidates: cands, label: CANDIDATE_LABEL }) : Object.assign(base, { found: false, text: NONE, candidates: [] });
  }
  const doc = D.docs && D.docs[no];
  const t = doc && doc[source];
  if (!t) return Object.assign(base, { found: false, text: NONE, why: doc && source === "bill_text" && doc.bill_text === "" ? "개정문을 찾지 못함" : "이 법안의 " + SOURCE_KO[source] + " 자료 없음" });
  return Object.assign(base, { found: true, text: t, chars: t.length });
}

// ---------------------------------------------------------------- 근거 평가 (코드 규칙만)
function dropAmbiguous(cands) {
  const vals = {};
  cands.forEach((c) => {
    if (c.attr !== "연면적" && c.attr !== "층수") return;
    const k = c.attr + "|" + c.bound;
    (vals[k] = vals[k] || new Set()).add(Number(String(c.value).replace(/,/g, "")));
  });
  const amb = new Set(Object.keys(vals).filter((k) => vals[k].size > 1));
  const dropped = [];
  const kept = cands.filter((c) => {
    if (!amb.has(c.attr + "|" + c.bound)) return true;
    dropped.push({ attr: c.attr, value: c.value, why: AMBIGUOUS });
    return false;
  });
  return { kept, dropped };
}

/**
 * 출처 하나의 글과 기준 후보(모델이나 정규식이 낸 것)로 기준별 상태를 코드로 정한다.
 * 돌려줌: { rule, evidence, dropped, delegation, items: {attr: {status, value, quote, why}} }
 * items 에는 이 출처에서 말한 기준만 들어간다.
 */
function evaluateSource(source, text, candidates) {
  if (!text || text === NONE) return { rule: {}, evidence: [], dropped: [], delegation: [], items: {} };
  let cands = (candidates || []).slice();
  let pre = [];
  if (source === "bill_text" || source === "review_report") {
    const a = dropAmbiguous(cands);
    cands = a.kept; pre = a.dropped;
  }
  if (source === "review_report") {
    cands = cands.filter((c) => {
      const q = Criteria.normText(c.quote);
      if (!AMEND_MARK.test(q)) { pre.push({ attr: c.attr, value: c.value, why: CURRENT_LAW }); return false; }
      return true;
    });
  }
  const v = Criteria.verify(cands, text);
  const dropped = pre.concat(v.dropped);
  const delegation = Criteria.findDelegation(text);
  const norm = Criteria.normText(text);
  const useCue = Criteria.extractCandidates(norm).some((c) => c.attr === "용도");
  const items = {};
  ATTRS.forEach((attr) => {
    const ev = v.evidence.find((e) => e.attr === attr);
    if (ev && v.rule[attr] !== undefined) {
      items[attr] = { status: ST_OK, value: v.rule[attr], quote: ev.quote, why: "원문 대조 통과 (근거 문구가 출처 글에 그대로 있고 수치·단위가 맞음)" };
      return;
    }
    const cued = attr === "용도" ? useCue : CUES[attr].test(norm);
    const tried = dropped.filter((d) => d.attr === attr);
    if (!cued && !tried.length) return; // 이 출처에서는 말하지 않은 기준
    const d = delegation.find((x) => DELEG_WORD[attr].test(x.value) || DELEG_WORD[attr].test(x.quote));
    if (d) { items[attr] = { status: ST_DELEG, value: null, quote: d.quote, why: d.by + "으로 정하는 " + d.value + " (위임 문구를 출처 글에서 확인)" }; return; }
    items[attr] = { status: ST_LOW, value: null, quote: null, why: tried.length ? tried.map((t) => t.why).join("; ") : "기준 낱말은 있지만 수치·단위가 있는 근거 문구 없음" };
  });
  return { rule: v.rule, evidence: v.evidence, dropped, delegation, items };
}

/**
 * 출처를 차례로 평가한 결과를 기준별로 모은다. 기준 목록은 요약에서 말한 기준이고,
 * 요약에서 아무 기준도 못 찾았으면 기준을 처음 말한 출처의 기준이다.
 * 나중 출처에서 처음 나온 기준은 extra (참고, 판정 규칙에 넣지 않음).
 */
function mergeEvaluations(evals) {
  const tracked = new Map(); // attr -> { attr, status, value, quote, source, history, revived_by }
  const extra = [];
  let anchor = null; // 기준 목록을 정한 출처
  evals.forEach((e) => {
    if (e.source === "similar_rules") return;
    const attrs = Object.keys(e.items);
    if (!anchor && attrs.length) {
      anchor = e.source;
      attrs.forEach((a) => tracked.set(a, { attr: a, status: null, value: null, quote: null, source: null, history: [], revived_by: null }));
      // 앞서 찾았지만 아무 기준도 말하지 않은 출처는 "언급 없음" 으로 남긴다
      evals.slice(0, evals.indexOf(e)).filter((p) => p.source !== "similar_rules").forEach((p) => tracked.forEach((t) => t.history.push({ source: p.source, status: "언급 없음" })));
    }
    tracked.forEach((t, a) => {
      const it = e.items[a];
      t.history.push({ source: e.source, status: it ? it.status : e.found === false ? "출처 없음" : "언급 없음", why: it ? it.why : undefined });
      if (it && (!t.status || RANK[it.status] > RANK[t.status])) {
        if (it.status === ST_OK && t.history.length > 1) t.revived_by = e.source;
        Object.assign(t, { status: it.status, value: it.value, quote: it.quote, source: e.source });
      }
    });
    if (anchor && anchor !== e.source) {
      attrs.filter((a) => !tracked.has(a) && e.items[a].status === ST_OK)
        .forEach((a) => extra.push({ attr: a, source: e.source, value: e.items[a].value, quote: e.items[a].quote, label: "요약에 없던 기준, 참고만 (사람 확인 필요)" }));
    }
  });
  const list = Array.from(tracked.values()).map((t) => Object.assign(t, { status: t.status || ST_LOW }));
  // 판정에 쓸 규칙: 기준마다 처음 "판정에 충분" 이 된 출처의 값 + 문서에서 원문 대조를 통과한 위임
  const rule = {};
  list.filter((t) => t.status === ST_OK).forEach((t) => { rule[t.attr] = t.value; });
  const deleg = [];
  evals.forEach((e) => { if (e.rule && e.rule.위임) e.rule.위임.forEach((x) => { if (!deleg.includes(x)) deleg.push(x); }); });
  if (deleg.length) rule.위임 = deleg;
  const revived = list.filter((t) => t.revived_by).map((t) => ({ attr: t.attr, from: t.history[0].status, by: t.revived_by, by_ko: SOURCE_KO[t.revived_by] }));
  return { criteria: list, extra, rule, revived, anchor };
}

/** 더 찾아야 하는지: 기준이 하나도 없거나 "부족" 인 기준이 있으면 */
function needMore(merged) {
  return !merged.criteria.length || merged.criteria.some((c) => c.status === ST_LOW);
}

/** 평가 결과를 한 줄로 (단계 기록·모델에게 주는 짧은 글) */
function evalLine(merged) {
  if (!merged.criteria.length) return "판정 기준을 말하는 문구를 아직 찾지 못함";
  return merged.criteria.map((c) => c.attr + " " + c.status + (c.status === ST_OK ? " (" + SOURCE_KO[c.source] + ")" : "")).join(", ");
}

module.exports = {
  SOURCES, SOURCE_KO, NONE, CANDIDATE_LABEL, ST_OK, ST_DELEG, ST_LOW, ST_CAND, NEXT_WHY, CURRENT_LAW, AMBIGUOUS,
  createSimilarRules, searchSource, evaluateSource, mergeEvaluations, needMore, evalLine, dropAmbiguous,
};
