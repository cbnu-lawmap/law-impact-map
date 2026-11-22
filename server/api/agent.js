/*
 * 빼곡 신규 법안 검토 에이전트 (Vercel 서버리스 함수, POST /api/agent)
 *
 * 법안 하나(의안번호 7자리)를 받아 AI 가 도구를 골라 부르며 검토 초안을 만든다.
 * 도구 (OpenAI chat.completions 의 tools)
 *   get_bill          법안 요약·위원회·제안일·단계
 *   extract_criteria  요약에서 적용 기준(용도·연면적·층수·사용승인·위임) 뽑기 + 원문 대조 (lib/criteria.js)
 *   crosscheck        crosscheck.json 의 출처별 기준과 비교
 *   judge_buildings   web/judge.js 와 같은 판정 로직(lib/judge.js 복사본)으로 사창동 건물 집계
 *   draft_review      모은 결과로 검토 초안 문단 쓰기
 * 막는 것
 *   - 단계 최대 8번, 실행 1번에 토큰 합계 12,000 넘으면 멈춤, 호출마다 max_tokens
 *   - 같은 법안은 10분 동안 저장한 결과를 돌려줌 (cached: true)
 *   - 의안번호는 7자리 숫자이고 bills.json 에 있어야 함
 *   - CORS·IP당 호출 수·개인정보·개별 건물 판정 질문 거르기는 ask.js 와 같은 부품(lib/common.js)
 *   - judge_buildings 에 넘긴 규칙의 수치·용도는 원문 대조를 통과한 기준이나 시범 규칙에 있는 것만 받음
 * 결과는 AI 초안이며 사람 확인이 필요하다 (needs_human_review: true).
 *
 * 로컬 시험: AGENT_MOCK=1 이면 OpenAI 대신 정해진 순서로 도구를 부르는 가짜 모델을 쓴다 (키 없이 시험).
 *   Vercel(VERCEL 환경변수가 있음)이나 NODE_ENV=production 에서는 가짜 모델을 절대 쓰지 않는다.
 *   DATA_DIR=web/data 를 주면 공개 사이트 대신 로컬 파일을 읽는다.
 */
const {
  cors, createLimiter, clientIp, readBody, PII, PERSONAL_JUDGE, PII_ANSWER, PERSONAL_ANSWER,
  numbersNotInContext, loadJson, maskKey,
} = require("../lib/common");
const Judge = require("../lib/judge");
const Criteria = require("../lib/criteria");

const MAX_STEPS = 8;
const TOKEN_CAP = 12000;
const CALL_MAX_TOKENS = 500;
const DRAFT_MAX_TOKENS = 600;
const CACHE_MS = 10 * 60000;
const limited = createLimiter({ windowMs: 60000, max: 5 });

const TOOL_KO = {
  get_bill: "법안 정보 읽기",
  extract_criteria: "적용 기준 뽑기",
  crosscheck: "출처별 기준 비교",
  judge_buildings: "건물 판정 집계",
  draft_review: "검토 초안 쓰기",
};

// ---------------------------------------------------------------- 데이터 (10분 저장)
let dataCache = null;
async function loadData() {
  if (dataCache && Date.now() - dataCache.at < CACHE_MS) return dataCache;
  const [b, d, x, g] = await Promise.all([
    loadJson("bills.json"), loadJson("demo_rules.json"), loadJson("crosscheck.json"), loadJson("buildings.geojson"),
  ]);
  const demos = {};
  d.demos.forEach((v) => { demos[v.bill_no] = v; });
  // 판정에 필요한 속성만 남긴다 (PNU 도 쓰지 않음)
  const props = g.features.map((f) => {
    const p = f.properties;
    return { usability: p.usability, totalarea: p.totalarea, grnd_flr: p.grnd_flr, useapr_day: p.useapr_day };
  });
  const byNo = {};
  b.bills.forEach((v) => { byNo[v.no] = v; });
  dataCache = { at: Date.now(), byNo, demos, region: d.region, total: d.total, cross: x, props };
  return dataCache;
}

// ---------------------------------------------------------------- 결과 저장 (법안별 10분)
const results = new Map(); // key -> { at, body }
function cacheGet(key) {
  const c = results.get(key);
  if (c && Date.now() - c.at < CACHE_MS) return c.body;
  results.delete(key);
  return null;
}

// ---------------------------------------------------------------- 도구 정의
const reasonParam = { type: "string", description: "이 도구를 지금 부르는 이유 (한국어 한 문장)" };
const noParam = { type: "string", description: "의안번호 7자리" };
const TOOLS = [
  { name: "get_bill", description: "법안 요약, 소관 위원회, 제안일, 진행 단계를 읽는다.", props: { no: noParam } },
  { name: "extract_criteria", description: "법안 요약에서 건축물 적용 기준(용도, 연면적, 층수, 사용승인, 시행령 위임)을 뽑고 원문 대조를 통과한 것만 돌려준다. 이미 판정한 시범 규칙(demo_rule)이 있으면 함께 돌려준다.", props: { no: noParam } },
  { name: "crosscheck", description: "같은 법안의 기준을 세 출처(우리 AI, 규칙 기반, 팀원 AI)와 비교한 자료를 보고, 뽑은 기준과 같은지 본다.", props: { no: noParam } },
  {
    name: "judge_buildings",
    description: "규칙을 시범 지역 건물 전체에 적용해 대상, 경계선, 비대상, 판정불가 동수를 센다. rule 은 extract_criteria 결과의 rule 이나 demo_rule.rule 을 그대로 넘긴다.",
    props: {
      rule: {
        type: "object",
        description: '예: {"용도":["02000"],"연면적":{"min":1000},"층수":{"max":2},"사용승인":{"before":"1996-11-01"},"위임":["규모"]}',
        properties: {
          용도: { type: "array", items: { type: "string" } },
          연면적: { type: "object", properties: { min: { type: "number" }, max: { type: "number" } } },
          층수: { type: "object", properties: { min: { type: "number" }, max: { type: "number" } } },
          사용승인: { type: "object", properties: { before: { type: "string" } } },
          위임: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  { name: "draft_review", description: "지금까지 모은 결과로 담당자용 검토 초안 문단을 쓴다. 마지막에 한 번 부른다.", props: { no: noParam } },
].map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: { type: "object", properties: Object.assign({ reason: reasonParam }, t.props), required: ["reason"].concat(Object.keys(t.props)) },
  },
}));

const SYSTEM = [
  "너는 「빼곡」의 신규 법안 검토 도우미다. 지자체 담당 공무원이 법안 하나의 검토 초안을 만든다.",
  "도구를 하나씩 골라 부른다. 보통 순서는 get_bill, extract_criteria, crosscheck, judge_buildings, draft_review 이다.",
  "도구를 부를 때마다 reason 에 왜 부르는지 한국어 한 문장으로 쓴다.",
  "judge_buildings 의 rule 은 extract_criteria 결과의 rule 을 그대로 쓰고, 그것이 비어 있으면 demo_rule.rule 을 쓴다. 둘 다 없으면 judge_buildings 를 부르지 않는다.",
  "숫자와 용도 코드를 지어내지 않는다. draft_review 를 부른 뒤에는 도구를 더 부르지 말고 '끝' 이라고만 답한다.",
].join("\n");

// ---------------------------------------------------------------- 모델 (OpenAI 또는 시험용 가짜)
function mockAllowed() {
  return process.env.AGENT_MOCK === "1" && !process.env.VERCEL && process.env.NODE_ENV !== "production";
}

function openaiLLM(key, model) {
  async function call(body) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(Object.assign({ model, temperature: 0.2 }, body)),
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || "OpenAI 오류 " + r.status);
    return { message: j.choices[0].message, tokens: (j.usage && j.usage.total_tokens) || 0 };
  }
  return {
    name: model,
    chat: (messages, maxTokens) => call({ messages, tools: TOOLS, tool_choice: "auto", parallel_tool_calls: false, max_tokens: maxTokens }),
    complete: async (system, user, maxTokens, json) => {
      const r = await call({
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        max_tokens: maxTokens,
        response_format: json ? { type: "json_object" } : undefined,
      });
      return { text: String(r.message.content || "").trim(), tokens: r.tokens };
    },
  };
}

// 가짜 모델: 정해진 순서로 도구를 부른다. AGENT_MOCK_SCRIPT=loop 이면 끝없이 부르고(단계 제한 시험),
// AGENT_MOCK_SCRIPT=tokens 이면 호출마다 토큰을 많이 쓴 것처럼 센다(토큰 제한 시험),
// AGENT_MOCK_SCRIPT=invent 이면 근거 없는 규칙으로 판정을 시도한다(규칙 거절 시험).
function mockLLM() {
  const script = process.env.AGENT_MOCK_SCRIPT || "normal";
  const tokens = script === "tokens" ? 5000 : 400;
  const ORDER = ["get_bill", "extract_criteria", "crosscheck", "judge_buildings", "draft_review"];
  const WHY = {
    get_bill: "법안 요약과 진행 단계를 먼저 확인합니다.",
    extract_criteria: "요약에서 건물 기준을 뽑아 원문과 대조합니다.",
    crosscheck: "뽑은 기준이 다른 출처와 같은지 봅니다.",
    judge_buildings: "원문 대조를 통과한 기준으로 사창동 건물을 집계합니다.",
    draft_review: "모은 결과로 검토 초안을 씁니다.",
  };
  let n = 0;
  const callTool = (name, args) => ({
    role: "assistant", content: null,
    tool_calls: [{ id: "mock_" + (++n), type: "function", function: { name, arguments: JSON.stringify(args) } }],
  });
  return {
    name: "mock",
    chat: async (messages) => {
      const no = (messages[1].content.match(/\d{7}/) || [""])[0];
      if (script === "loop") return { message: callTool("get_bill", { reason: "다시 확인합니다.", no }), tokens };
      const done = [], out = {};
      messages.forEach((m, i) => {
        if (m.role === "assistant" && m.tool_calls) {
          const name = m.tool_calls[0].function.name;
          done.push(name);
          const reply = messages[i + 1];
          try { out[name] = JSON.parse(reply.content); } catch (e) { out[name] = {}; }
        }
      });
      for (const name of ORDER) {
        if (done.includes(name)) continue;
        if (name === "judge_buildings") {
          const ex = out.extract_criteria || {};
          const rule = ex.rule && Object.keys(ex.rule).length ? ex.rule : ex.demo_rule && ex.demo_rule.rule;
          if (!rule) continue;
          if (script === "invent") return { message: callTool(name, { reason: "기준을 조금 넓혀 봅니다.", rule: { 연면적: { max: 777 } } }), tokens };
          const why = ex.rule && Object.keys(ex.rule).length ? WHY[name] : "요약에서 근거 있는 기준을 찾지 못해 판정 시범 규칙으로 집계합니다.";
          return { message: callTool(name, { reason: why, rule }), tokens };
        }
        return { message: callTool(name, { reason: WHY[name], no }), tokens };
      }
      return { message: { role: "assistant", content: "끝" }, tokens };
    },
    complete: async () => ({ text: "", tokens: script === "tokens" ? 5000 : 300 }), // 빈 글 → 서버가 틀 문장을 씀
  };
}

// ---------------------------------------------------------------- 한 번 실행
function fmt(n) { return Number(n).toLocaleString("ko-KR"); }

async function run(D, no, note, llm) {
  const bill = D.byNo[no];
  const demo = D.demos[no] || null;
  const state = { steps: [], tokens: 0, stopped: "", bill: null, extracted: null, cross: null, judged: null, draft: "", draftCtx: "", unverified: [] };
  const overBudget = () => state.tokens >= TOKEN_CAP;

  // 판정에 넘긴 규칙은 원문 대조를 통과한 규칙이나 판정 시범 규칙과 똑같아야 한다.
  // 지어낸 수치·용도를 막고, 위임 같은 기준을 빼서 대상이 부풀려지는 것도 막는다.
  const KEYS = ["용도", "연면적", "층수", "사용승인", "위임"];
  function canon(rule) {
    const out = {};
    KEYS.forEach((k) => {
      const v = rule[k];
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
  function checkRule(rule) {
    if (!rule || typeof rule !== "object" || !Object.keys(rule).length) return { error: "규칙이 비어 있습니다" };
    const bad = Object.keys(rule).filter((k) => !KEYS.includes(k));
    if (bad.length) return { error: "모르는 기준: " + bad.join(", ") };
    const pools = [];
    if (state.extracted && Object.keys(state.extracted.rule).length) pools.push(["원문 대조 통과 기준", state.extracted.rule]);
    if (demo) pools.push(["판정 시범 규칙", demo.rule]);
    if (!pools.length) return { error: "원문 대조를 통과한 기준이 없어 판정하지 않습니다" };
    const hit = pools.find((p) => canon(p[1]) === canon(rule));
    if (!hit) return { error: "넘긴 규칙이 원문 대조를 통과한 기준이나 판정 시범 규칙과 다릅니다" };
    return { source: hit[0], rule: hit[1] };
  }

  async function draftReview() {
    const b = state.bill || bill;
    const lines = [];
    lines.push(`법안 ${b.no} ${b.name} | 위원회 ${b.committee} | 제안일 ${b.date} | 단계 ${b.stage || "정보 없음"}${b.stage_date ? " (" + b.stage_date + ")" : ""}`);
    lines.push("요약: " + String(b.summary).slice(0, 600));
    if (state.extracted) {
      const t = Criteria.ruleTexts(state.extracted.rule);
      lines.push("원문 대조 통과 기준: " + (Object.keys(t).length ? Object.keys(t).map((k) => k + " " + t[k]).join(", ") : "없음"));
      state.extracted.evidence.forEach((e) => lines.push("근거 문구(" + e.attr + "): " + e.quote));
      if (demo) lines.push("시범 규칙(" + demo.method + "): " + Object.entries(Criteria.ruleTexts(demo.rule)).map((x) => x.join(" ")).join(", ") + " | 근거 " + demo.source_text);
    }
    if (state.cross) lines.push("출처별 비교: " + state.cross.summary);
    if (state.judged) {
      const c = state.judged.counts;
      lines.push(`판정(${D.region} 건물 ${fmt(D.total)}동, ${state.judged.source} ${Object.entries(Criteria.ruleTexts(state.judged.rule)).map((x) => x.join(" ")).join(", ")}): 대상 ${fmt(c["대상"])}동, 경계선 ${fmt(c["경계선"])}동, 비대상 ${fmt(c["비대상"])}동, 판정불가 ${fmt(c["판정불가"])}동`);
      lines.push("주요 사유: " + state.judged.top.map((r) => r.status + " " + r.reason + " " + r.n + "동").join(", "));
    } else lines.push("판정: 근거 있는 기준이 없어 건물 판정을 하지 않음");
    if (note) lines.push("담당자 검토 관점: " + note);
    const ctx = lines.join("\n");

    // 틀 문장 (모델이 없거나 빈 답일 때). 숫자는 모두 ctx 에 있는 값만 쓴다
    const c = state.judged && state.judged.counts;
    const crit = state.judged ? Criteria.ruleTexts(state.judged.rule) : {};
    const fallback = [
      `의안번호 ${b.no} 「${b.name}」은 ${b.committee} 소관으로 ${b.date}에 제안되었습니다.`,
      state.extracted && !Object.keys(state.extracted.rule).length ? "공개된 요약 원문에서는 근거 문구가 맞는 건물 기준을 찾지 못했습니다." : "",
      Object.keys(crit).length ? "검토에 쓴 적용 기준은 " + state.judged.source + "인 " + Object.keys(crit).map((k) => k + " " + crit[k]).join(", ") + "입니다." : "판정에 쓸 수 있는 근거 있는 기준이 없어 건물 판정은 하지 않았습니다.",
      c ? `이 기준을 ${D.region} 건축물 ${fmt(D.total)}동에 적용하면 대상 ${fmt(c["대상"])}동, 경계선 ${fmt(c["경계선"])}동, 비대상 ${fmt(c["비대상"])}동, 판정불가 ${fmt(c["판정불가"])}동으로 추정됩니다.` : "",
      state.cross ? "출처별 기준 비교 결과는 " + state.cross.summary + "입니다." : "",
      "이 결과는 건축물 데이터로 추정한 것이며 법률 판단이 아니므로, 담당자가 원문과 시행령을 확인한 뒤 확정해야 합니다.",
    ].filter(Boolean).join(" ");

    let text = "";
    if (!overBudget()) {
      const r = await llm.complete(
        "너는 지자체 법안 검토 담당자의 초안 작성을 돕는다. [자료]에 있는 내용과 숫자만 써서 한국어 검토 초안 한 문단(5문장 이내, 쉬운 존댓말)을 쓴다. " +
        "계산하거나 지어낸 숫자를 쓰지 않는다. 판정은 건축물 데이터 기반 추정이며 법률 판단이 아니고 담당자 확인이 필요하다는 점을 끝에 적는다. 줄표(—)를 쓰지 않는다.",
        "[자료]\n" + ctx, DRAFT_MAX_TOKENS, false);
      state.tokens += r.tokens;
      text = r.text;
    }
    state.draft = (text || fallback).replace(/—/g, ", ");
    state.draftCtx = ctx;
    state.unverified = numbersNotInContext(state.draft, ctx, note || "");
    return { draft: state.draft, unverified: state.unverified, template: !text };
  }

  async function extractCriteria() {
    let cands = Criteria.extractCandidates(bill.summary);
    let how = "정규식";
    if (llm.name !== "mock" && !overBudget()) {
      try {
        const r = await llm.complete(
          "법안 요약에서 건축물 적용 기준만 JSON 으로 뽑는다. 형식: {\"items\":[{\"attr\":\"용도|연면적|층수|사용승인|위임\",\"bound\":\"min|max\",\"value\":값,\"quote\":\"근거 문구\"}]}. " +
          "quote 는 요약 원문을 한 글자도 바꾸지 말고 그대로 옮긴 160자 이내 문구. 용도 value 는 주용도 코드 배열 (" +
          Object.entries(Judge.USE_NAMES).map((x) => x[0] + " " + x[1]).join(", ") + "). 연면적은 ㎡, 층수는 층 수 숫자. " +
          "'이상·초과' 는 min, '이하·미만' 은 max. 사용승인은 '준공 후 N년 이상' 을 before \"" + (Number(Criteria.REF_DATE.slice(0, 4)) + "-N") + Criteria.REF_DATE.slice(4) + "\" 형식 날짜로. " +
          "위임 value 는 시행령(대통령령)에 넘긴 기준 이름(용도 또는 규모). 확실하지 않으면 넣지 않는다.",
          "[요약]\n" + bill.summary, CALL_MAX_TOKENS, true);
        state.tokens += r.tokens;
        const items = JSON.parse(r.text).items;
        if (Array.isArray(items)) { cands = items; how = "AI"; }
      } catch (e) { /* 실패하면 정규식 결과를 쓴다 */ }
    }
    const v = Criteria.verify(cands, bill.summary);
    state.extracted = v;
    return {
      method: how + " 추출 · 원문 대조",
      rule: v.rule,
      evidence: v.evidence,
      dropped: v.dropped,
      demo_rule: demo ? { rule: demo.rule, source_text: demo.source_text, method: demo.method, note: "판정 시범 규칙 (데이터 만들 때 전체 요약 원문과 대조 통과)" } : null,
    };
  }

  function crosscheck() {
    const X = D.cross && D.cross.bills && D.cross.bills[no];
    const useExtracted = state.extracted && Object.keys(state.extracted.rule).length;
    const mine = useExtracted ? state.extracted.rule : demo ? demo.rule : {};
    const basis = useExtracted ? "원문 대조 통과 기준" : demo ? "판정 시범 규칙" : "비교할 기준 없음";
    const texts = Criteria.ruleTexts(mine);
    if (!X) {
      state.cross = { found: false, basis, items: [], compare: [], summary: "교차 확인 자료에 이 법안이 없음" };
      return state.cross;
    }
    const tally = {};
    X.items.forEach((it) => { tally[it.status] = (tally[it.status] || 0) + 1; });
    const compare = Object.keys(texts).filter((k) => k !== "위임").map((attr) => {
      const it = X.items.find((i) => i.attr === attr);
      const ours = it ? it.ours : "";
      return { attr, agent: texts[attr], ours, rule: it ? it.rule : "", team: it ? it.team : "", same: !!ours && ours === texts[attr], status: it ? it.status : "자료 없음" };
    });
    const same = compare.filter((c) => c.same).length;
    const summary = Object.keys(tally).map((s) => s + " " + tally[s] + "개").join(", ") +
      (useExtracted && compare.length ? `, 에이전트가 뽑은 기준과 우리 AI 기준 ${compare.length}개 중 ${same}개 같음` : "") +
      (!useExtracted && demo ? " (에이전트가 새로 뽑은 기준이 없어 판정 시범 규칙 기준)" : "");
    state.cross = { found: true, basis, items: X.items, compare, tally, summary };
    return state.cross;
  }

  function judgeBuildings(rule) {
    const ok = checkRule(rule);
    if (ok.error) return { error: ok.error };
    const clean = JSON.parse(JSON.stringify(ok.rule));
    const J = Judge.countAll(D.props, clean);
    const top = Object.keys(J.reasons).map((k) => ({ status: k.split("|")[0], reason: k.split("|")[1], n: J.reasons[k] }))
      .sort((a, b) => b.n - a.n).slice(0, 4);
    state.judged = { rule: clean, source: ok.source, counts: J.counts, top };
    return { region: D.region, total: D.total, rule: clean, rule_source: ok.source, counts: J.counts, top_reasons: top };
  }

  async function exec(name, args) {
    if (name !== "judge_buildings" && name !== "draft_review" && args.no && args.no !== no) return { error: "이번 검토 대상은 " + no + " 입니다" };
    if (name === "get_bill") {
      state.bill = bill;
      return { no: bill.no, name: bill.name, committee: bill.committee, date: bill.date, stage: bill.stage || null, stage_date: bill.stage_date || null, summary: String(bill.summary).slice(0, 600) };
    }
    if (name === "extract_criteria") return extractCriteria();
    if (name === "crosscheck") return crosscheck();
    if (name === "judge_buildings") return judgeBuildings(args.rule);
    if (name === "draft_review") return draftReview();
    return { error: "모르는 도구" };
  }

  function summarize(name, r) {
    if (r.error) return "실행하지 않음: " + r.error;
    if (name === "get_bill") return `${r.name} · ${r.committee} · 제안 ${r.date} · 단계 ${r.stage || "정보 없음"}`;
    if (name === "extract_criteria") {
      const t = Criteria.ruleTexts(r.rule);
      return "원문 대조 통과 기준 " + Object.keys(t).length + "개" + (Object.keys(t).length ? " (" + Object.keys(t).map((k) => k + " " + t[k]).join(", ") + ")" : "") +
        (r.dropped.length ? ", 근거가 맞지 않아 버린 기준 " + r.dropped.length + "개" : "") + (r.demo_rule ? ", 판정 시범 규칙 있음" : "");
    }
    if (name === "crosscheck") return r.summary;
    if (name === "judge_buildings") {
      const c = r.counts;
      return `${r.rule_source}으로 ${r.region} ${fmt(r.total)}동 중 대상 ${fmt(c["대상"])}, 경계선 ${fmt(c["경계선"])}, 비대상 ${fmt(c["비대상"])}, 판정불가 ${fmt(c["판정불가"])}`;
    }
    if (name === "draft_review") return "검토 초안 " + r.draft.length + "자" + (r.template ? " (정해진 틀로 작성)" : "") + (r.unverified.length ? ", 근거에 없는 숫자 " + r.unverified.length + "개" : "");
    return "";
  }

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: "의안번호 " + no + " 법안의 검토 초안을 만들어 주세요." + (note ? " 검토 관점: " + note : "") },
  ];
  while (true) {
    if (state.steps.length >= MAX_STEPS) { state.stopped = "단계 " + MAX_STEPS + "번에 도달해 멈춤"; break; }
    if (overBudget()) { state.stopped = "토큰 " + fmt(TOKEN_CAP) + "개를 넘어 멈춤"; break; }
    const r = await llm.chat(messages, CALL_MAX_TOKENS);
    state.tokens += r.tokens;
    const msg = r.message;
    const calls = msg.tool_calls || [];
    if (!calls.length) break;
    messages.push({ role: "assistant", content: msg.content || null, tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch (e) { args = {}; }
      const name = call.function.name;
      let result;
      if (state.steps.length >= MAX_STEPS) result = { error: "단계 제한" };
      else {
        result = TOOL_KO[name] ? await exec(name, args) : { error: "모르는 도구" };
        state.steps.push({ tool: name, tool_ko: TOOL_KO[name] || name, why: String(args.reason || "(이유를 적지 않음)").slice(0, 160), summary: summarize(name, result), ok: !result.error });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 4000) });
    }
  }

  // 모델이 초안 단계를 부르지 않고 끝냈으면 서버가 마무리한다 (단계 제한·토큰 제한에 걸린 경우도 틀 문장으로)
  if (!state.draft) {
    const r = await draftReview();
    if (state.steps.length < MAX_STEPS) state.steps.push({ tool: "draft_review", tool_ko: TOOL_KO.draft_review, why: "모델이 초안 단계를 부르지 않아 서버가 마무리했습니다.", summary: summarize("draft_review", r), ok: true, by_server: true });
  }

  return {
    no,
    name: bill.name,
    steps: state.steps,
    draft: state.draft,
    rule: state.judged ? state.judged.rule : state.extracted ? state.extracted.rule : null,
    evidence: state.extracted ? state.extracted.evidence : [],
    rule_source: state.judged ? state.judged.source : null,
    counts: state.judged ? state.judged.counts : null,
    region: D.region,
    total: D.total,
    crosscheck: state.cross,
    needs_human_review: true,
    unverified: state.unverified,
    model: llm.name,
    tokens: state.tokens,
    limits: { max_steps: MAX_STEPS, token_cap: TOKEN_CAP, stopped: state.stopped || null },
    cached: false,
  };
}

// ---------------------------------------------------------------- 핸들러
module.exports = async function handler(req, res) {
  const okOrigin = cors(req, res);
  const mock = mockAllowed();
  const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method === "GET") { res.status(200).json({ ok: mock || !!process.env.OPENAI_API_KEY, model: mock ? "mock" : MODEL }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 받습니다" }); return; }
  if (!okOrigin) { res.status(403).json({ error: "허용하지 않은 사이트입니다" }); return; }
  if (limited(clientIp(req))) { res.status(429).json({ error: "요청이 너무 잦습니다. 1분 뒤에 다시 해 주세요." }); return; }

  const body = readBody(req);
  const no = String(body.bill || "").trim();
  const note = String(body.note || "").trim().slice(0, 200);
  if (!/^\d{7}$/.test(no)) { res.status(400).json({ error: "의안번호는 7자리 숫자여야 합니다" }); return; }
  if (PII.test(note)) { res.status(200).json({ fixed: true, answer: PII_ANSWER, steps: [], needs_human_review: true }); return; }
  if (PERSONAL_JUDGE.test(note)) { res.status(200).json({ fixed: true, answer: PERSONAL_ANSWER, steps: [], needs_human_review: true }); return; }

  try {
    const D = await loadData();
    if (!D.byNo[no]) { res.status(404).json({ error: "의안번호 " + no + " 법안을 찾지 못했습니다" }); return; }
    const key = no + "|" + note;
    const hit = cacheGet(key);
    if (hit) { res.status(200).json(Object.assign({}, hit, { cached: true })); return; }
    if (!mock && !process.env.OPENAI_API_KEY) { res.status(503).json({ error: "AI 키가 설정되지 않았습니다" }); return; }
    const llm = mock ? mockLLM() : openaiLLM(process.env.OPENAI_API_KEY, MODEL);
    const out = await run(D, no, note, llm);
    results.set(key, { at: Date.now(), body: out });
    res.status(200).json(out);
  } catch (e) {
    res.status(502).json({ error: "검토 초안을 만들지 못했습니다: " + maskKey(e) });
  }
};

// 시험용 (node server/scripts/test-agent.js)
module.exports._test = { clearCache: () => { results.clear(); dataCache = null; }, TOOLS, MAX_STEPS, TOKEN_CAP };
