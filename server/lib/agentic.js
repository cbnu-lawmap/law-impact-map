/*
 * 검토 에이전트의 두 가지 다른 방식 (server/api/agent.js 의 mode 로 고름)
 *
 *   rag1     질의 도우미식 1회 RAG: 요약을 한 번 찾고, 모델 호출 한 번으로 기준을 뽑고, 코드로 원문 대조·평가·판정.
 *            도구 고르기 반복 없음. 초안은 정해진 틀 문장.
 *   agentic  Agentic RAG: 모델이 search_sources 로 출처를 찾고, 찾을 때마다 서버 코드가 근거를 평가(evaluate_evidence)해
 *            부족하면 다음 출처를 고르게 한다. 순서 summary → bill_text → review_report → similar_rules, 재검색 최대 3번.
 *            similar_rules 의 규칙은 "후보 규칙, 사람 확인 필요" 로만 보이고 판정에 넣지 않는다.
 *
 * 근거 평가는 모델이 하지 않는다 (lib/sources.js 의 evaluateSource: 원문 대조, 수치·단위, 개정문 여부).
 * 토큰 상한(12,000)은 agent 방식과 같고, 재검색 결과는 모델에게 평가 한 줄과 다음 할 일만 준다 (출처 글 전체를 주지 않음).
 */
const Judge = require("./judge");
const Criteria = require("./criteria");
const S = require("./sources");
const { numbersNotInContext } = require("./common");

const MAX_RESEARCH = 3;
const SPLIT_KEYS = ["용도", "연면적", "층수", "사용승인"];
const KEYS = ["용도", "연면적", "층수", "사용승인", "위임"];
const HOLD_DELEG = "판정 보류: 시행령(대통령령 등)에 위임돼 기준 확정 전";
const HOLD_NONE_ALL = "판정 보류: 찾아본 출처에서 판정 기준을 찾지 못함";
const TODO_DECREE = "시행령 입법예고 확인";
const TODO_CHECK = "법안 원문(조문 대비표)과 후보 규칙 사람 확인";
const DEMO_FALLBACK = "근거 있는 추출 기준이 없어 시범 규칙 사용";
const NO_SPLIT = "판정할 기준이 없음 (건물을 가르는 용도·연면적·층수·사용승인 기준 없이 위임만 있거나 비어 있음)";

const TOOL_KO = {
  search_sources: "출처 찾기",
  evaluate_evidence: "근거 평가 (코드 규칙)",
  extract_criteria: "적용 기준 뽑기 (모델 1번)",
  judge_buildings: "건물 판정 집계",
  draft_review: "검토 초안 쓰기",
};

function fmt(n) { return Number(n).toLocaleString("ko-KR"); }

function judgeable(rule) {
  if (!rule || typeof rule !== "object") return false;
  return SPLIT_KEYS.some((k) => {
    const v = rule[k];
    if (v === undefined || v === null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).some((b) => v[b] !== undefined && v[b] !== null && v[b] !== "");
    return String(v) !== "";
  });
}
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

/** 규칙으로 사창동 건물 판정 (agent.js 의 judgeBuildings 와 같은 셈) */
function judgeWith(D, rule) {
  const clean = JSON.parse(JSON.stringify(rule));
  const J = Judge.countAll(D.props, clean);
  const top = Object.keys(J.reasons).map((k) => ({ status: k.split("|")[0], reason: k.split("|")[1], n: J.reasons[k] }))
    .sort((a, b) => b.n - a.n).slice(0, 4);
  return { rule: clean, counts: J.counts, top };
}

const reasonParam = { type: "string", description: "이 도구를 지금 부르는 이유 (한국어 한 문장)" };
const noParam = { type: "string", description: "의안번호 7자리" };
const AGENTIC_TOOLS = [
  {
    name: "search_sources",
    description: "출처 하나를 찾아 근거를 모은다. 찾을 때마다 서버 코드가 근거를 평가해 next 로 다음 할 일을 알려 준다. 순서 summary, bill_text, review_report, similar_rules. 재검색 최대 3번.",
    props: { no: noParam, source: { type: "string", enum: S.SOURCES, description: "summary 요약, bill_text 법안 원문(개정 조문), review_report 검토보고서, similar_rules 비슷한 법안 규칙(후보)" } },
  },
  {
    name: "judge_buildings",
    description: "use_rule 을 그대로 넘겨 사창동 건물을 판정한다. 후보 규칙은 넘기지 않는다.",
    props: { rule: { type: "object", description: "search_sources 결과의 use_rule" } },
  },
  { name: "draft_review", description: "검토 초안 작성. 마지막에 한 번.", props: { no: noParam } },
].map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: { type: "object", properties: Object.assign({ reason: reasonParam }, t.props), required: ["reason"].concat(Object.keys(t.props)) },
  },
}));

const SYSTEM = [
  "너는 「빼곡」 법안 검토 도우미다 (Agentic RAG). 도구를 하나씩 불러 근거를 모으고 검토 초안을 만든다.",
  "먼저 search_sources 로 summary 를 찾는다. 근거 평가는 서버 코드가 하고, 도구 결과의 next 가 다음 할 일이다. next 를 따른다.",
  "출처 순서는 summary, bill_text, review_report, similar_rules 이고 재검색은 최대 3번이다. reason 에 이유를 짧게 쓴다.",
  "similar_rules 의 규칙은 후보일 뿐(사람 확인 필요)이라 judge_buildings 에 넘기지 않는다. judge_buildings 에는 use_rule 을 그대로 넘기고, use_rule 이 null 이면 건너뛴다.",
  "숫자를 지어내지 않는다. draft_review 뒤에는 '끝'이라고만 답한다.",
].join("\n");

/** 가짜 모델(AGENT_MOCK=1)용: 마지막 도구 결과의 next 를 그대로 따른다 */
function followNext(messages, no) {
  const tools = messages.filter((m) => m.role === "tool");
  const call = (name, args) => ({ role: "assistant", content: null, tool_calls: [{ id: "mock_" + (tools.length + 1), type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  if (!tools.length) return call("search_sources", { reason: "요약(제안이유)부터 찾습니다.", no, source: "summary" });
  let last = {};
  try { last = JSON.parse(tools[tools.length - 1].content); } catch (e) { last = {}; }
  const nx = last.next;
  if (!nx) return { role: "assistant", content: "끝" };
  if (nx.tool === "search_sources") return call("search_sources", { reason: nx.why, no, source: nx.source });
  if (nx.tool === "judge_buildings") return call("judge_buildings", { reason: "평가를 통과한 규칙으로 집계합니다.", rule: nx.use_rule });
  if (nx.tool === "draft_review") return call("draft_review", { reason: "모은 결과로 초안을 씁니다.", no });
  return { role: "assistant", content: "끝" };
}

/** 공통 상태 (두 방식이 같이 씀) */
function makeCtx(o) {
  const { D, no, llm, limits } = o;
  const bill = D.byNo[no];
  const demo = D.demos[no] || null;
  const st = { steps: [], tokens: 0, stopped: "", evals: [], merged: S.mergeEvaluations([]), researches: 0, plan: null, judged: null, draft: "", unverified: [], candidates: [], extraction: [], stopWhy: "" };
  const overBudget = (next = 0) => st.tokens + next >= limits.TOKEN_CAP;

  async function extractFor(source, text, allowModel) {
    let cands = Criteria.extractCandidates(text);
    let how = "정규식";
    if (allowModel && llm.name !== "mock" && !overBudget(limits.CALL_MAX_TOKENS)) {
      try {
        const r = await llm.complete(o.EXTRACT_PROMPT, "[" + S.SOURCE_KO[source] + "]\n" + text.slice(0, 3500), limits.CALL_MAX_TOKENS, true);
        st.tokens += r.tokens;
        const items = JSON.parse(r.text).items;
        if (Array.isArray(items)) { cands = items; how = "AI"; }
      } catch (e) { /* 실패하면 정규식 결과 */ }
    }
    return { cands, how };
  }

  /** 출처 하나 찾고 코드로 평가 → 단계 두 개(출처 찾기, 근거 평가) */
  async function searchAndEvaluate(source, why, opts = {}) {
    const r = S.searchSource(D, no, source);
    if (source !== "summary") st.researches++;
    let ev = { source, found: r.found, items: {}, rule: {}, evidence: [], dropped: [], delegation: [] };
    let how = "";
    if (r.found && source !== "similar_rules") {
      const x = await extractFor(source, r.text, opts.model !== false);
      how = x.how;
      ev = Object.assign(S.evaluateSource(source, r.text, x.cands), { source, found: true });
      st.extraction.push({ source, method: how, candidates_n: x.cands.length, passed: ev.evidence.length, dropped: ev.dropped.map((d) => ({ attr: d.attr, why: d.why })), rule: ev.rule });
    }
    if (source === "similar_rules" && r.found) st.candidates = r.candidates;
    st.evals.push(ev);
    st.merged = S.mergeEvaluations(st.evals);
    const searchSummary = !r.found ? S.SOURCE_KO[source] + ": " + S.NONE + (r.why ? " (" + r.why + ")" : "") :
      source === "similar_rules" ? "비슷한 시범 법안 " + r.candidates.length + "건: " + r.candidates.map((c) => c.no + " (유사도 " + c.score + ")").join(", ") + " · " + S.CANDIDATE_LABEL :
        S.SOURCE_KO[source] + " " + fmt(r.chars) + "자" + (how ? " · " + how + " 추출" : "");
    st.steps.push({ tool: "search_sources", tool_ko: TOOL_KO.search_sources + " (" + S.SOURCE_KO[source] + ")", source, why: String(why || "").slice(0, 160), summary: searchSummary, ok: !r.error, by_server: !!opts.byServer });
    const next = nextAction();
    const evalSummary = (source === "similar_rules" ? "후보 규칙은 판정에 넣지 않음 (" + S.CANDIDATE_LABEL + "). " : "") +
      "평가 결과: " + S.evalLine(st.merged) + " → " + next.line;
    st.steps.push({ tool: "evaluate_evidence", tool_ko: TOOL_KO.evaluate_evidence, source, why: "자동 평가 (모델이 아니라 코드 규칙으로: 원문 대조, 수치·단위, 개정문 여부)", summary: evalSummary, ok: true, auto: true,
      evaluation: Object.keys(ev.items).map((a) => ({ attr: a, status: ev.items[a].status, why: ev.items[a].why })), next: next.model });
    return { r, ev, next };
  }

  function planFor() {
    const m = st.merged;
    if (judgeable(m.rule)) return { use_rule: m.rule, source: "원문 대조 통과 기준", note: "" };
    if (demo) return { use_rule: demo.rule, source: "판정 시범 규칙", note: DEMO_FALLBACK };
    const deleg = m.criteria.some((c) => c.status === S.ST_DELEG) || !!(m.rule.위임 && m.rule.위임.length);
    const hold = deleg ? HOLD_DELEG : HOLD_NONE_ALL;
    return { use_rule: null, source: null, hold, todo: deleg ? TODO_DECREE : TODO_CHECK, note: hold };
  }

  /** 평가 결과로 다음 할 일 (코드가 정함). line = 단계 기록용 "다음 출처 선택 이유" */
  function nextAction() {
    const searched = st.evals.map((e) => e.source);
    const more = S.needMore(st.merged);
    const rest = S.SOURCES.filter((s) => !searched.includes(s));
    if (more && rest.length && st.researches < MAX_RESEARCH) {
      const src = rest[0];
      const low = st.merged.criteria.filter((c) => c.status === S.ST_LOW).map((c) => c.attr);
      const why = (low.length ? low.join("·") + " 부족, " : "판정 기준을 아직 못 찾음, ") + S.NEXT_WHY[src];
      return { line: "다음 출처 " + S.SOURCE_KO[src] + " 선택: " + why, model: { tool: "search_sources", source: src, why } };
    }
    st.stopWhy = !more ? "모든 기준이 판정에 충분하거나 위임 확인이라 더 찾지 않음" : st.researches >= MAX_RESEARCH ? "재검색 " + MAX_RESEARCH + "번을 다 써서 더 찾지 않음" : "더 찾을 출처가 없음";
    st.plan = planFor();
    if (st.plan.use_rule) return { line: st.stopWhy + ". " + st.plan.source + "으로 건물 판정", model: { tool: "judge_buildings", use_rule: st.plan.use_rule, source: st.plan.source } };
    return { line: st.stopWhy + ". " + st.plan.hold, model: { tool: "draft_review", hold: st.plan.hold } };
  }

  function judgeTool(rule, byServer, why) {
    let err = "";
    if (!rule || typeof rule !== "object" || !Object.keys(rule).length) err = "규칙이 비어 있습니다";
    else if (!judgeable(rule)) err = NO_SPLIT;
    else if (Object.keys(rule).some((k) => !KEYS.includes(k))) err = "모르는 기준: " + Object.keys(rule).filter((k) => !KEYS.includes(k)).join(", ");
    let source = null, use = null;
    if (!err) {
      const pools = [];
      if (judgeable(st.merged.rule)) pools.push(["원문 대조 통과 기준", st.merged.rule]);
      if (demo) pools.push(["판정 시범 규칙", demo.rule]);
      const hit = pools.find((p) => canon(p[1]) === canon(rule));
      if (hit) { source = hit[0]; use = hit[1]; }
      else if (st.candidates.some((c) => canon(c.rule) === canon(rule))) err = "후보 규칙은 사람 확인 전이라 판정에 쓰지 않습니다 (" + S.CANDIDATE_LABEL + ")";
      else err = pools.length ? "넘긴 규칙이 원문 대조를 통과한 기준이나 판정 시범 규칙과 다릅니다" : "원문 대조를 통과한 기준이 없어 판정하지 않습니다";
    }
    if (err) {
      st.steps.push({ tool: "judge_buildings", tool_ko: TOOL_KO.judge_buildings, why: String(why || "").slice(0, 160), summary: "실행하지 않음: " + err, ok: false });
      const p = st.plan || planFor();
      return { error: err, next: p.use_rule ? { tool: "judge_buildings", use_rule: p.use_rule } : { tool: "draft_review", hold: p.hold } };
    }
    const j = judgeWith(D, use);
    st.judged = Object.assign(j, { source });
    const c = j.counts;
    st.steps.push({ tool: "judge_buildings", tool_ko: TOOL_KO.judge_buildings, why: String(why || "").slice(0, 160),
      summary: `${source}으로 ${D.region} ${fmt(D.total)}동 중 대상 ${fmt(c["대상"])}, 경계선 ${fmt(c["경계선"])}, 비대상 ${fmt(c["비대상"])}, 판정불가 ${fmt(c["판정불가"])}`, ok: true, by_server: !!byServer });
    return { counts: c, source, reasons: j.top.map((t) => `${t.status} ${t.reason} ${t.n}동`), next: { tool: "draft_review" } };
  }

  async function draftTool(allowModel, byServer, why) {
    if (!st.plan) st.plan = planFor();
    const lines = [];
    lines.push(`법안 ${bill.no} ${bill.name} | 위원회 ${bill.committee} | 제안일 ${bill.date} | 단계 ${bill.stage || "정보 없음"}`);
    lines.push("찾은 출처: " + st.evals.map((e) => S.SOURCE_KO[e.source] + (e.found ? "" : " 없음")).join(", "));
    st.merged.criteria.forEach((c) => lines.push(`기준 ${c.attr}: ${c.status}` + (c.source ? " (" + S.SOURCE_KO[c.source] + ")" : "") + (c.quote ? " 근거 문구: " + c.quote : "")));
    st.merged.revived.forEach((r) => lines.push(`재검색으로 확인: ${r.attr} (${r.by_ko})`));
    if (st.candidates.length) lines.push("비슷한 법안 후보 규칙 (" + S.CANDIDATE_LABEL + "): " + st.candidates.map((c) => c.no + " " + c.title).join(", "));
    if (st.judged) {
      const c = st.judged.counts;
      lines.push(`판정(${D.region} 건물 ${fmt(D.total)}동, ${st.judged.source} ${Object.entries(Criteria.ruleTexts(st.judged.rule)).map((x) => x.join(" ")).join(", ")}): 대상 ${fmt(c["대상"])}동, 경계선 ${fmt(c["경계선"])}동, 비대상 ${fmt(c["비대상"])}동, 판정불가 ${fmt(c["판정불가"])}동`);
    } else if (st.plan.hold) lines.push(st.plan.hold + " · 담당자 할 일: " + st.plan.todo);
    if (o.note) lines.push("담당자 검토 관점: " + o.note);
    const ctx = lines.join("\n");
    const c = st.judged && st.judged.counts;
    const crit = st.judged ? Criteria.ruleTexts(st.judged.rule) : {};
    const fallback = [
      `의안번호 ${bill.no} 「${bill.name}」은 ${bill.committee} 소관으로 ${bill.date}에 제안되었습니다.`,
      "찾아본 출처는 " + st.evals.map((e) => S.SOURCE_KO[e.source] + (e.found ? "" : "(없음)")).join(", ") + "입니다.",
      st.merged.revived.length ? "요약에서 부족했던 " + st.merged.revived.map((r) => r.attr + "(" + r.by_ko + ")").join(", ") + " 기준을 재검색으로 확인했습니다." : "",
      Object.keys(crit).length ? "검토에 쓴 적용 기준은 " + st.judged.source + "인 " + Object.keys(crit).map((k) => k + " " + crit[k]).join(", ") + "입니다." :
        st.plan.hold ? st.plan.hold + "이라 건물 판정은 하지 않았습니다. 담당자 할 일: " + st.plan.todo + "." : "판정에 쓸 수 있는 근거 있는 기준이 없어 건물 판정은 하지 않았습니다.",
      c ? `이 기준을 ${D.region} 건축물 ${fmt(D.total)}동에 적용하면 대상 ${fmt(c["대상"])}동, 경계선 ${fmt(c["경계선"])}동, 비대상 ${fmt(c["비대상"])}동, 판정불가 ${fmt(c["판정불가"])}동으로 추정됩니다.` : "",
      st.candidates.length ? "비슷한 법안의 규칙은 후보로만 적었으며 사람 확인이 필요합니다." : "",
      "이 결과는 건축물 데이터로 추정한 것이며 법률 판단이 아니므로, 담당자가 원문과 시행령을 확인한 뒤 확정해야 합니다.",
    ].filter(Boolean).join(" ");
    let text = "";
    if (allowModel && llm.name !== "mock" && !overBudget(limits.DRAFT_MAX_TOKENS)) {
      const r = await llm.complete(
        "너는 지자체 법안 검토 담당자의 초안 작성을 돕는다. [자료]에 있는 내용과 숫자만 써서 한국어 검토 초안 한 문단(5문장 이내, 쉬운 존댓말)을 쓴다. " +
        "계산하거나 지어낸 숫자를 쓰지 않는다. 후보 규칙은 사람 확인이 필요한 후보라고만 쓴다. 판정 보류와 담당자 할 일이 있으면 꼭 쓴다. 판정은 건축물 데이터 기반 추정이며 법률 판단이 아니고 담당자 확인이 필요하다는 점을 끝에 적는다. 줄표(—)를 쓰지 않는다.",
        "[자료]\n" + ctx, limits.DRAFT_MAX_TOKENS, false);
      st.tokens += r.tokens;
      text = r.text;
    }
    st.draft = (text || fallback).replace(/—/g, ", ");
    if (!st.judged && st.plan.hold && st.draft.indexOf(st.plan.todo) < 0) st.draft += " 담당자 할 일: " + st.plan.todo + ".";
    st.unverified = numbersNotInContext(st.draft, ctx, o.note || "");
    st.steps.push({ tool: "draft_review", tool_ko: TOOL_KO.draft_review, why: String(why || "").slice(0, 160),
      summary: "검토 초안 " + st.draft.length + "자" + (text ? "" : " (정해진 틀로 작성)") + (st.unverified.length ? ", 근거에 없는 숫자 " + st.unverified.length + "개" : ""), ok: true, by_server: !!byServer });
    return { ok: true, chars: st.draft.length };
  }

  function result(mode) {
    const m = st.merged;
    const plan = st.plan || planFor();
    return {
      no, name: bill.name, mode,
      steps: st.steps,
      step_count: st.steps.length,
      draft: st.draft,
      rule: st.judged ? st.judged.rule : m.rule,
      evidence: m.criteria.filter((c) => c.status === S.ST_OK).map((c) => ({ attr: c.attr, value: c.value, quote: c.quote, source: c.source })),
      extraction: { rule: m.rule, by_source: st.extraction, method: st.extraction.map((x) => x.source + " " + x.method).join(", ") },
      evaluation: m.criteria,
      extra_criteria: m.extra,
      revived: m.revived,
      sources_used: st.evals.map((e) => ({ source: e.source, source_ko: S.SOURCE_KO[e.source], found: e.found })),
      researches: st.researches,
      candidates: st.candidates,
      search_stop: st.stopWhy || null,
      rule_source: st.judged ? st.judged.source : null,
      counts: st.judged ? st.judged.counts : null,
      hold: !st.judged && plan.hold ? plan.hold : null,
      hold_todo: !st.judged && plan.hold ? plan.todo : null,
      delegation: [],
      region: D.region, total: D.total,
      crosscheck: null,
      needs_human_review: true,
      unverified: st.unverified,
      model: llm.name,
      tokens: st.tokens,
      limits: { max_steps: limits.MAX_STEPS, token_cap: limits.TOKEN_CAP, max_researches: MAX_RESEARCH, stopped: st.stopped || null },
      cached: false,
    };
  }

  return { st, bill, demo, overBudget, searchAndEvaluate, nextAction, planFor, judgeTool, draftTool, result };
}

// ---------------------------------------------------------------- rag1: 1회 RAG
async function runRag1(o) {
  const c = makeCtx(o);
  const { st } = c;
  // 요약을 한 번 찾고 (코드), 기준 뽑기 모델 호출 한 번, 코드 평가
  const r = S.searchSource(o.D, o.no, "summary");
  st.steps.push({ tool: "search_sources", tool_ko: TOOL_KO.search_sources + " (" + S.SOURCE_KO.summary + ")", source: "summary", why: "1회 RAG: 요약을 한 번만 찾습니다.", summary: r.found ? S.SOURCE_KO.summary + " " + fmt(r.chars) + "자" : S.NONE, ok: r.found });
  let ev = { source: "summary", found: r.found, items: {}, rule: {}, evidence: [], dropped: [], delegation: [] };
  if (r.found) {
    let cands = Criteria.extractCandidates(r.text), how = "정규식";
    if (o.llm.name !== "mock" && !c.overBudget(o.limits.CALL_MAX_TOKENS)) {
      try {
        const x = await o.llm.complete(o.EXTRACT_PROMPT, "[요약]\n" + r.text.slice(0, 3500), o.limits.CALL_MAX_TOKENS, true);
        st.tokens += x.tokens;
        const items = JSON.parse(x.text).items;
        if (Array.isArray(items)) { cands = items; how = "AI"; }
      } catch (e) { /* 정규식 */ }
    }
    ev = Object.assign(S.evaluateSource("summary", r.text, cands), { source: "summary", found: true });
    st.extraction.push({ source: "summary", method: how, candidates_n: cands.length, passed: ev.evidence.length, dropped: ev.dropped.map((d) => ({ attr: d.attr, why: d.why })), rule: ev.rule });
    st.steps.push({ tool: "extract_criteria", tool_ko: TOOL_KO.extract_criteria, why: "모델 호출 한 번으로 기준 후보를 뽑습니다.", summary: how + " 추출 후보 " + cands.length + "개, 원문 대조 통과 " + ev.evidence.length + "개", ok: true });
  }
  st.evals.push(ev);
  st.merged = S.mergeEvaluations(st.evals);
  st.plan = c.planFor();
  st.stopWhy = "1회 RAG 라 다시 찾지 않음";
  st.steps.push({ tool: "evaluate_evidence", tool_ko: TOOL_KO.evaluate_evidence, source: "summary", why: "자동 평가 (모델이 아니라 코드 규칙으로)", ok: true, auto: true,
    summary: "평가 결과: " + S.evalLine(st.merged) + " → " + st.stopWhy + ". " + (st.plan.use_rule ? st.plan.source + "으로 건물 판정" : st.plan.hold),
    evaluation: Object.keys(ev.items).map((a) => ({ attr: a, status: ev.items[a].status, why: ev.items[a].why })) });
  if (st.plan.use_rule) c.judgeTool(st.plan.use_rule, false, "평가를 통과한 규칙(없으면 시범 규칙)으로 집계합니다.");
  await c.draftTool(false, false, "정해진 틀 문장으로 초안을 씁니다 (모델 호출 없음).");
  return c.result("rag1");
}

// ---------------------------------------------------------------- agentic: Agentic RAG
async function runAgentic(o) {
  const c = makeCtx(o);
  const { st } = c;
  const { limits, llm, no } = o;
  const modelSteps = () => st.steps.filter((s) => !s.auto && !s.by_server).length;

  async function exec(name, args) {
    if (name === "search_sources") {
      if (args.no && args.no !== no) return { error: "이번 검토 대상은 " + no + " 입니다" };
      const src = String(args.source || "");
      const searched = st.evals.map((e) => e.source);
      if (!S.SOURCES.includes(src)) return { error: "모르는 출처: " + src + " (summary, bill_text, review_report, similar_rules)" };
      if (searched.length && st.researches >= MAX_RESEARCH) return { error: "재검색은 " + MAX_RESEARCH + "번까지입니다", next: c.nextAction().model };
      if (searched.includes(src)) return { error: "이미 찾은 출처입니다: " + src, next: c.nextAction().model };
      const expected = S.SOURCES.find((s) => !searched.includes(s));
      if (searched.length && !S.needMore(st.merged)) return { error: "근거 평가가 끝나 더 찾지 않습니다", next: c.nextAction().model };
      if (src !== expected) return { error: "순서상 다음 출처는 " + expected + " 입니다", next: { tool: "search_sources", source: expected } };
      const x = await c.searchAndEvaluate(src, args.reason);
      // 모델에게는 평가 한 줄과 다음 할 일만 (출처 글은 주지 않음)
      const out = { source: src, found: x.r.found, eval: S.evalLine(st.merged), next: x.next.model };
      if (src === "similar_rules" && x.r.found) out.candidates = x.r.candidates.map((k) => ({ no: k.no, title: k.title, label: S.CANDIDATE_LABEL }));
      return out;
    }
    if (name === "judge_buildings") return c.judgeTool(args.rule, false, args.reason);
    if (name === "draft_review") return c.draftTool(true, false, args.reason);
    return { error: "모르는 도구" };
  }

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: "의안번호 " + no + " 법안의 검토 초안을 만들어 주세요." + (o.note ? " 검토 관점: " + o.note : "") },
  ];
  const chat = llm.name === "mock" ? async (msgs) => ({ message: followNext(msgs, no), tokens: 300 }) : (msgs, mt) => llm.chat(msgs, mt, AGENTIC_TOOLS);
  while (true) {
    if (modelSteps() >= limits.MAX_STEPS) { st.stopped = "단계 " + limits.MAX_STEPS + "번에 도달해 멈춤"; break; }
    if (c.overBudget(limits.CALL_MAX_TOKENS)) { st.stopped = "토큰 " + fmt(limits.TOKEN_CAP) + "개를 넘기 전에 멈춤"; break; }
    const r = await chat(messages, limits.CALL_MAX_TOKENS);
    st.tokens += r.tokens;
    const calls = r.message.tool_calls || [];
    if (!calls.length) break;
    messages.push({ role: "assistant", content: r.message.content || null, tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch (e) { args = {}; }
      const name = call.function.name;
      let res;
      if (modelSteps() >= limits.MAX_STEPS) res = { error: "단계 제한" };
      else {
        const before = st.steps.length;
        res = await exec(name, args);
        // 도구가 단계를 남기지 않은 거절(순서·재검색 제한 등)도 기록한다
        if (st.steps.length === before) st.steps.push({ tool: name, tool_ko: TOOL_KO[name] || name, source: args.source, why: String(args.reason || "(이유를 적지 않음)").slice(0, 160), summary: "실행하지 않음: " + (res.error || "알 수 없음"), ok: false });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(res).slice(0, 1200) });
    }
    if (st.draft) {
      // 초안까지 썼으면 한 번 더 묻지 않고 끝낸다 (토큰 절약)
      break;
    }
  }

  // 모델이 멈췄거나 제한에 걸렸으면 서버가 코드 규칙대로 마무리한다 (토큰을 더 쓰지 않음)
  if (!st.evals.length) await c.searchAndEvaluate("summary", "모델이 출처를 찾지 않아 서버가 요약을 찾습니다.", { model: false, byServer: true });
  if (!st.plan) {
    // 서버가 찾는 출처는 정규식 추출만 써서 토큰을 쓰지 않는다. 순서와 재검색 3번 제한은 같다
    let nx = c.nextAction();
    while (nx.model.tool === "search_sources") {
      const x = await c.searchAndEvaluate(nx.model.source, "모델이 멈춰 서버가 다음 출처를 찾습니다: " + nx.model.why, { model: false, byServer: true });
      nx = x.next;
    }
  }
  if (!st.judged && st.plan.use_rule) c.judgeTool(st.plan.use_rule, true, "모델이 판정을 부르지 않아 서버가 평가를 통과한 규칙으로 집계했습니다.");
  if (!st.draft) await c.draftTool(!c.overBudget(limits.DRAFT_MAX_TOKENS) && !st.stopped, true, "모델이 초안 단계를 부르지 않아 서버가 마무리했습니다.");
  return c.result("agentic");
}

module.exports = { runAgentic, runRag1, AGENTIC_TOOLS, MAX_RESEARCH, judgeable, canon, followNext, HOLD_NONE_ALL, TOOL_KO };
