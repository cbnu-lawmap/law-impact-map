/*
 * 빼곡 신규 법안 검토 에이전트 (Vercel 서버리스 함수, POST /api/agent)
 *
 * 법안 하나(의안번호 7자리)를 받아 AI 가 도구를 골라 부르며 검토 초안을 만든다.
 * 도구 (OpenAI chat.completions 의 tools)
 *   get_bill          법안 요약·위원회·제안일·단계
 *   extract_criteria  요약에서 적용 기준(용도·연면적·층수·세대수·사용승인·위임) 뽑기 + 원문 대조 (lib/criteria.js)
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
 * 모델 서버는 기본 OpenAI. AGENT_LLM_BASE_URL(·AGENT_LLM_MODEL·AGENT_LLM_KEY)을 주면 OpenAI 호환 로컬 서버(Ollama·vLLM 등)를 쓴다.
 *
 * 방식 (POST 본문 mode 또는 ?mode=, 없으면 agent)
 *   agent    지금까지의 도구 고르기 에이전트 (기본값, 기존 화면·호출은 그대로)
 *   agentic  Agentic RAG: search_sources 로 출처를 찾고 코드 규칙으로 근거를 평가해 부족하면 다음 출처를 찾는다 (lib/agentic.js)
 *   rag1     질의 도우미식 1회 RAG: 요약 한 번, 모델 호출 한 번으로 기준 뽑기, 코드로 대조·판정 (lib/agentic.js)
 *   비교 스크립트(scripts/compare-rag.js)용으로 AGENT_COMPARE_TOKEN 환경변수와 같은 x-compare-token 헤더를 보내면
 *   IP당 호출 수 제한과 사이트 확인, 10분 저장을 건너뛴다. 환경변수가 비어 있으면 이 길은 닫혀 있다.
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
const { loadModel } = require("../lib/nn");
const Agentic = require("../lib/agentic");
const Sources = require("../lib/sources");
const { similarByVector, primaryMethod, rrf, METHODS: SIMILAR_METHODS } = require("../lib/similar");
const { logRun } = require("../lib/runs");
const crypto = require("crypto");
const MODES = ["agent", "agentic", "rag1"];

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
  classify_field: "분야 분류 (직접 학습한 모델)",
  predict_pass: "통과 가능성 (직접 학습한 신경망)",
};

// ---------------------------------------------------------------- 데이터 (10분 저장)
let dataCache = null;
async function loadData() {
  if (dataCache && Date.now() - dataCache.at < CACHE_MS) return dataCache;
  const [b, d, x, g, sm] = await Promise.all([
    loadJson("bills.json"), loadJson("demo_rules.json"), loadJson("crosscheck.json"), loadJson("buildings.geojson"),
    loadJson("summaries.json").catch(() => null),   // 제안이유 전문 (없으면 bills.json 의 300자 요약)
  ]);
  // 비슷한 법안 방법 (collect/compare_similar.py 가 측정해 씀). 없으면 tfidf
  const sim = await loadJson("similar_method.json").catch(() => null);
  // 재검색 출처 (법안 원문 개정 부분, 검토보고서 문장). 없으면 search_sources 가 "없음" 으로 답한다
  const docs = await loadJson("bill_docs.json").catch(() => null);
  const demos = {};
  d.demos.forEach((v) => { demos[v.bill_no] = v; });
  // 판정에 필요한 속성만 남긴다 (PNU 도 쓰지 않음)
  const props = g.features.map((f) => {
    const p = f.properties;
    return { usability: p.usability, totalarea: p.totalarea, grnd_flr: p.grnd_flr, useapr_day: p.useapr_day, hhld_cnt: p.hhld_cnt };
  });
  const byNo = {};
  b.bills.forEach((v) => { byNo[v.no] = v; });
  // 직접 학습한 모델 (notebooks/*.ipynb 가 web/data/models/ 로 내보냄). 없으면 도구가 "모델 없음" 으로 답한다
  const [fm, pm] = await Promise.all([
    loadJson("models/field_classifier.json").catch(() => null),
    loadJson("models/pass_prediction.json").catch(() => null),
  ]);
  const models = { field: fm ? loadModel(fm) : null, pass: pm || null };
  const full = (sm && sm.summaries) || {};
  dataCache = { at: Date.now(), byNo, demos, region: d.region, total: d.total, cross: x, props, fields: b.fields, models, full, docs: (docs && docs.docs) || {},
    similarMethod: sim && SIMILAR_METHODS.includes(sim.method) ? sim.method : null };
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
  { name: "get_bill", description: "법안 요약·위원회·제안일·단계.", props: { no: noParam } },
  { name: "extract_criteria", description: "제안이유에서 건물 기준을 뽑아 원문 대조. use_rule = 판정에 쓸 규칙, null 이면 판정 보류.", props: { no: noParam } },
  { name: "crosscheck", description: "기준을 세 출처와 비교한 결론 (속성별 한 줄).", props: { no: noParam } },
  {
    name: "judge_buildings",
    description: "use_rule 을 그대로 넘겨 사창동 건물을 판정한다 (동수·사유·대표 사례 3건).",
    props: {
      rule: {
        type: "object",
        description: "extract_criteria 의 use_rule",
        properties: {
          용도: { type: "array", items: { type: "string" } },
          연면적: { type: "object", properties: { min: { type: "number" }, max: { type: "number" } } },
          층수: { type: "object", properties: { min: { type: "number" }, max: { type: "number" } } },
          세대수: { type: "object", properties: { min: { type: "number" }, max: { type: "number" } } },
          사용승인: { type: "object", properties: { before: { type: "string" } } },
          위임: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  { name: "draft_review", description: "검토 초안 작성. 마지막에 한 번.", props: { no: noParam } },
  // classify_field, predict_pass 는 모델이 고르지 않는다: 루프 전에 코드가 계산해 첫 메시지에 넣는다
].map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: { type: "object", properties: Object.assign({ reason: reasonParam }, t.props), required: ["reason"].concat(Object.keys(t.props)) },
  },
}));

const SYSTEM = [
  "너는 「빼곡」 법안 검토 도우미다. 도구를 하나씩 불러 검토 초안을 만든다.",
  "순서: get_bill, extract_criteria, crosscheck, judge_buildings, draft_review. reason 에 이유를 짧게 쓴다.",
  "분야 분류와 통과 가능성은 첫 메시지에 이미 계산돼 있다 (직접 학습한 모델 추정). 초안에 그대로 쓴다.",
  "judge_buildings 에는 use_rule 을 그대로 넘기고, use_rule 이 null 이면 건너뛴다. 숫자를 지어내지 않는다.",
  "draft_review 뒤에는 '끝'이라고만 답한다.",
].join("\n");

// 기준 뽑기 지시문 (extract_criteria). notebooks/local_llm_extraction.ipynb 도 data/verify_cases.json 을 거쳐 같은 글을 쓴다
const EXTRACT_PROMPT =
  "법안 요약에서 건축물 적용 기준만 JSON 으로 뽑는다. 형식: {\"items\":[{\"attr\":\"용도|연면적|층수|세대수|사용승인|위임\",\"bound\":\"min|max\",\"value\":값,\"quote\":\"근거 문구\"}]}. " +
  "quote 는 요약 원문을 한 글자도 바꾸지 말고 그대로 옮긴 160자 이내 문구. 용도 value 는 주용도 코드 배열 (" +
  Object.entries(Judge.USE_NAMES).map((x) => x[0] + " " + x[1]).join(", ") + "). 연면적은 ㎡, 층수는 층 수 숫자, 세대수는 세대 수 숫자 (quote 에 '30세대' 처럼 수치와 '세대' 가 붙어 있어야 함). " +
  "'이상·초과' 는 min, '이하·미만' 은 max. 사용승인은 '준공 후 N년 이상' 을 before \"" + (Number(Criteria.REF_DATE.slice(0, 4)) + "-N") + Criteria.REF_DATE.slice(4) + "\" 형식 날짜로. " +
  "위임 value 는 시행령(대통령령)·부령·조례에 넘긴 기준 이름(예: 용도, 규모) 한두 낱말이고, quote 에는 '대통령령으로 정하는' 같은 위임 문구가 그대로 있어야 한다. 그런 문구가 없으면 위임을 넣지 않는다.";

// ---------------------------------------------------------------- 모델 (OpenAI 또는 시험용 가짜)
function mockAllowed() {
  return process.env.AGENT_MOCK === "1" && !process.env.VERCEL && process.env.NODE_ENV !== "production";
}

// 모델 서버 고르기 (환경변수만으로 바꾼다. 아무것도 주지 않으면 지금과 같은 OpenAI)
//   AGENT_LLM_BASE_URL  OpenAI 호환 서버 주소 (예: 로컬 Ollama http://host:11434/v1, vLLM http://host:8000/v1)
//   AGENT_LLM_MODEL     모델 이름 (예: qwen2.5:1.5b-instruct). 없으면 OPENAI_MODEL, 그것도 없으면 gpt-4o-mini
//   AGENT_LLM_KEY       그 서버의 키 (없어도 됨). 다른 서버를 쓸 때 OpenAI 키는 보내지 않는다
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
function llmConfig(env = process.env) {
  const base = String(env.AGENT_LLM_BASE_URL || "").trim().replace(/\/+$/, "");
  const model = env.AGENT_LLM_MODEL || env.OPENAI_MODEL || "gpt-4o-mini";
  if (!base) return { provider: "openai", url: OPENAI_URL, model, key: env.OPENAI_API_KEY || "", ready: !!env.OPENAI_API_KEY };
  const url = /\/chat\/completions$/.test(base) ? base : base + "/chat/completions";
  return { provider: "custom", url, model, key: env.AGENT_LLM_KEY || "", ready: true };
}

function openaiLLM(key, model, url = OPENAI_URL) {
  async function call(body) {
    const headers = { "Content-Type": "application/json" };
    if (key) headers.Authorization = "Bearer " + key;
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(Object.assign({ model, temperature: 0.2 }, body)),
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || "모델 서버 오류 " + r.status);
    return { message: j.choices[0].message, tokens: (j.usage && j.usage.total_tokens) || 0 };
  }
  return {
    name: model,
    chat: (messages, maxTokens, tools) => call({ messages, tools: tools || TOOLS, tool_choice: "auto", parallel_tool_calls: false, max_tokens: maxTokens }),
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
// AGENT_MOCK_SCRIPT=invent 이면 근거 없는 규칙으로 판정을 시도한다(규칙 거절 시험),
// AGENT_MOCK_SCRIPT=nosplit 이면 위임만 든 규칙으로 판정을 시도한다(판정할 기준 없음 시험).
// AGENT_MOCK_SCRIPT=models 이면 직접 학습한 모델 도구(classify_field, predict_pass)도 부른다.
// AGENT_MOCK_SCRIPT=nodeleg 이면 추출 결과에서 위임을 뺀다(모델이 위임을 빠뜨린 경우 시험).
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
    classify_field: "직접 학습한 분야 분류 모델로 분야를 확인합니다.",
    predict_pass: "직접 학습한 통과 가능성 신경망 결과를 봅니다.",
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
        // nosplit: 첫 판정이 "판정할 기준이 없음"으로 거절되면 도구가 알려 준 대로 한 번 더 시도한다
        const retryJudge = script === "nosplit" && name === "judge_buildings" && done.filter((d) => d === name).length === 1 &&
          out.judge_buildings && out.judge_buildings.error;
        if (done.includes(name) && !retryJudge) continue;
        if (name === "judge_buildings") {
          const ex = out.extract_criteria || {};
          if (script === "nosplit" && !done.includes("judge_buildings")) return { message: callTool(name, { reason: "위임 기준만으로 집계해 봅니다.", rule: { 위임: ["용도"] } }), tokens };
          const rule = ex.use_rule;
          if (!rule) continue;
          if (script === "invent") return { message: callTool(name, { reason: "기준을 조금 넓혀 봅니다.", rule: { 연면적: { max: 777 } } }), tokens };
          const why = ex.use_rule_source === "원문 대조 통과 기준" ? WHY[name] : "요약에서 판정에 쓸 기준을 찾지 못해 판정 시범 규칙으로 집계합니다.";
          return { message: callTool(name, { reason: why, rule }), tokens };
        }
        return { message: callTool(name, { reason: WHY[name], no }), tokens };
      }
      return { message: { role: "assistant", content: "끝" }, tokens };
    },
    complete: async () => ({ text: "", tokens: script === "tokens" ? 5000 : 300 }), // 빈 글 → 서버가 틀 문장을 씀
    filterCandidates: script === "nodeleg" ? (cands) => cands.filter((c) => c.attr !== "위임") : null,
  };
}

// ---------------------------------------------------------------- 한 번 실행
function fmt(n) { return Number(n).toLocaleString("ko-KR"); }

// 건물을 실제로 가를 수 있는 기준(용도·연면적·층수·세대수·사용승인)이 하나라도 있는지. 위임만 있거나 비어 있으면 false
const SPLIT_KEYS = ["용도", "연면적", "층수", "세대수", "사용승인"];
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
const NO_SPLIT = "판정할 기준이 없음 (건물을 가르는 용도·연면적·층수·세대수·사용승인 기준 없이 위임만 있거나 비어 있음)";
const HOLD_DELEG = "판정 보류: 시행령(대통령령 등)에 위임돼 기준 확정 전";
const HOLD_NONE = "판정 보류: 요약문에서 판정 기준을 찾지 못함";
const DEMO_FALLBACK_DELEG = "추출 기준이 위임뿐이라 시범 규칙 사용";
const DEMO_FALLBACK_NONE = "근거 있는 추출 기준이 없어 시범 규칙 사용";
const TODO_DECREE = "시행령 입법예고 확인";
const TODO_ORIGINAL = "법안 원문(조문 대비표) 확인";
const DELEG_CHECKED = "위임 문구는 원문에서 직접 확인";

async function run(D, no, note, llm) {
  const bill = D.byNo[no];
  const demo = D.demos[no] || null;
  // 기준 뽑기·원문 대조는 300자로 자른 화면용 요약이 아니라 제안이유 전문으로 한다
  const fullText = (D.full && D.full[no]) || String(bill.summary || "").replace(/…$/, "");
  const fullUsed = !!(D.full && D.full[no]);
  const state = { steps: [], tokens: 0, stopped: "", bill: null, extracted: null, cross: null, judged: null, plan: null, delegation: [], field: null, pass: null, draft: "", draftCtx: "", unverified: [] };
  // 다음 호출이 최대로 쓸 출력(max_tokens)까지 더해 상한을 넘지 않게 본다
  const overBudget = (next = 0) => state.tokens + next >= TOKEN_CAP;

  // 판정에 넘긴 규칙은 원문 대조를 통과한 규칙이나 판정 시범 규칙과 똑같아야 한다.
  // 지어낸 수치·용도를 막고, 위임 같은 기준을 빼서 대상이 부풀려지는 것도 막는다.
  const KEYS = ["용도", "연면적", "층수", "세대수", "사용승인", "위임"];
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
  // 추출 결과로 판정 방법을 정한다: 추출 규칙 / 시범 규칙 대체 / 판정 보류
  // 위임 여부는 모델 결과가 아니라 원문 위임 문구(코드로 찾음)와 원문 대조를 통과한 위임 기준으로 정한다
  function planFor(extracted) {
    const r = extracted ? extracted.rule : {};
    if (judgeable(r)) return { use_rule: r, source: "원문 대조 통과 기준", note: "" };
    const deleg = !!(r && r.위임 && r.위임.length) || state.delegation.length > 0;
    if (demo) return { use_rule: demo.rule, source: "판정 시범 규칙", note: deleg ? DEMO_FALLBACK_DELEG : DEMO_FALLBACK_NONE };
    const hold = deleg ? HOLD_DELEG : HOLD_NONE;
    return { use_rule: null, source: null, hold, todo: deleg ? TODO_DECREE : TODO_ORIGINAL, note: hold };
  }

  function checkRule(rule) {
    if (!rule || typeof rule !== "object" || !Object.keys(rule).length) return { error: "규칙이 비어 있습니다", no_split: true };
    if (!judgeable(rule)) return { error: NO_SPLIT, no_split: true };
    const bad = Object.keys(rule).filter((k) => !KEYS.includes(k));
    if (bad.length) return { error: "모르는 기준: " + bad.join(", ") };
    const pools = [];
    if (state.extracted && judgeable(state.extracted.rule)) pools.push(["원문 대조 통과 기준", state.extracted.rule]);
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
    lines.push("요약: " + fullText.slice(0, 800));
    if (state.extracted) {
      const t = Criteria.ruleTexts(state.extracted.rule);
      lines.push("원문 대조 통과 기준: " + (Object.keys(t).length ? Object.keys(t).map((k) => k + " " + t[k]).join(", ") : "없음"));
      state.extracted.evidence.forEach((e) => lines.push("근거 문구(" + e.attr + "): " + e.quote));
      if (demo) lines.push("시범 규칙(" + demo.method + "): " + Object.entries(Criteria.ruleTexts(demo.rule)).map((x) => x.join(" ")).join(", ") + " | 근거 " + demo.source_text);
    }
    if (state.cross) lines.push("출처별 비교: " + state.cross.summary);
    if (state.field) lines.push("분야(직접 학습 " + modelKo(state.field.metrics) + " 추정" + (state.field.needs_check ? ", 분류 확인 필요" : "") + "): " + state.field.top.map((t) => t.name + " " + Math.round(t.p * 100) + "%").join(", "));
    if (state.pass) lines.push("통과 가능성(직접 학습 신경망 추정): " +
      (state.pass.tier ? state.pass.tier.name + " (비슷한 과거 법안 반영률 " + Math.round(state.pass.tier.actual_rate * 100) + "%, 확률 " + Math.round(state.pass.p * 100) + "%)"
        : Math.round(state.pass.p * 100) + "%") +
      (state.pass.metrics.test_auc != null ? " (모델 시험 AUC " + state.pass.metrics.test_auc + ")" : ""));
    if (state.judged) {
      const c = state.judged.counts;
      lines.push(`판정(${D.region} 건물 ${fmt(D.total)}동, ${state.judged.source} ${Object.entries(Criteria.ruleTexts(state.judged.rule)).map((x) => x.join(" ")).join(", ")}): 대상 ${fmt(c["대상"])}동, 경계선 ${fmt(c["경계선"])}동, 비대상 ${fmt(c["비대상"])}동, 판정불가 ${fmt(c["판정불가"])}동`);
      lines.push("주요 사유: " + state.judged.top.map((r) => r.status + " " + r.reason + " " + r.n + "동").join(", "));
    } else if (state.plan && state.plan.hold) {
      lines.push(state.plan.hold);
      if (state.delegation.length) lines.push("원문 위임 문구: " + state.delegation.map((d) => d.quote).join(" / "));
      lines.push("담당자 할 일: " + state.plan.todo + (state.plan.todo === TODO_DECREE ? " (위임된 기준이 정해지면 다시 판정)" : " (요약문에 없는 조문 기준이 있는지 확인)"));
    } else lines.push("판정: 근거 있는 기준이 없어 건물 판정을 하지 않음");
    if (note) lines.push("담당자 검토 관점: " + note);
    const ctx = lines.join("\n");

    // 틀 문장 (모델이 없거나 빈 답일 때). 숫자는 모두 ctx 에 있는 값만 쓴다
    const c = state.judged && state.judged.counts;
    const crit = state.judged ? Criteria.ruleTexts(state.judged.rule) : {};
    const fallback = [
      `의안번호 ${b.no} 「${b.name}」은 ${b.committee} 소관으로 ${b.date}에 제안되었습니다.`,
      state.extracted && !Object.keys(state.extracted.rule).length ? "공개된 요약 원문에서는 근거 문구가 맞는 건물 기준을 찾지 못했습니다." : "",
      Object.keys(crit).length ? "검토에 쓴 적용 기준은 " + state.judged.source + "인 " + Object.keys(crit).map((k) => k + " " + crit[k]).join(", ") + "입니다." :
        state.plan && state.plan.hold ? state.plan.hold + "이라 건물 판정은 하지 않았습니다. 담당자 할 일: " + state.plan.todo + "." :
        "판정에 쓸 수 있는 근거 있는 기준이 없어 건물 판정은 하지 않았습니다.",
      c ? `이 기준을 ${D.region} 건축물 ${fmt(D.total)}동에 적용하면 대상 ${fmt(c["대상"])}동, 경계선 ${fmt(c["경계선"])}동, 비대상 ${fmt(c["비대상"])}동, 판정불가 ${fmt(c["판정불가"])}동으로 추정됩니다.` : "",
      state.cross ? "출처별 기준 비교 결과는 " + state.cross.summary + "입니다." : "",
      "이 결과는 건축물 데이터로 추정한 것이며 법률 판단이 아니므로, 담당자가 원문과 시행령을 확인한 뒤 확정해야 합니다.",
    ].filter(Boolean).join(" ");

    let text = "";
    if (!overBudget(DRAFT_MAX_TOKENS)) {
      const r = await llm.complete(
        "너는 지자체 법안 검토 담당자의 초안 작성을 돕는다. [자료]에 있는 내용과 숫자만 써서 한국어 검토 초안 한 문단(5문장 이내, 쉬운 존댓말)을 쓴다. " +
        "계산하거나 지어낸 숫자를 쓰지 않는다. [자료]에 판정 보류와 담당자 할 일이 있으면 그 내용을 꼭 쓴다. 판정은 건축물 데이터 기반 추정이며 법률 판단이 아니고 담당자 확인이 필요하다는 점을 끝에 적는다. 줄표(—)를 쓰지 않는다.",
        "[자료]\n" + ctx, DRAFT_MAX_TOKENS, false);
      state.tokens += r.tokens;
      text = r.text;
    }
    state.draft = (text || fallback).replace(/—/g, ", ");
    // 판정 보류인데 모델이 할 일을 빠뜨렸으면 덧붙인다
    if (!state.judged && state.plan && state.plan.hold && state.draft.indexOf(state.plan.todo) < 0) state.draft += " 담당자 할 일: " + state.plan.todo + ".";
    state.draftCtx = ctx;
    state.unverified = numbersNotInContext(state.draft, ctx, note || "");
    return { draft: state.draft, unverified: state.unverified, template: !text };
  }

  async function extractCriteria() {
    let cands = Criteria.extractCandidates(fullText);
    let how = "정규식";
    if (llm.filterCandidates) cands = llm.filterCandidates(cands); // 시험용 가짜 모델만 (모델이 위임을 빠뜨린 경우 흉내)
    if (llm.name !== "mock" && !overBudget(CALL_MAX_TOKENS)) {
      try {
        const r = await llm.complete(EXTRACT_PROMPT, "[요약]\n" + fullText, CALL_MAX_TOKENS, true);
        state.tokens += r.tokens;
        const items = JSON.parse(r.text).items;
        if (Array.isArray(items)) { cands = items; how = "AI"; }
      } catch (e) { /* 실패하면 정규식 결과를 쓴다 */ }
    }
    const v = Criteria.verify(cands, fullText);
    state.extracted = v;
    // 근거 평가 (Agentic RAG 와 같은 코드 규칙, 요약 한 출처만). 응답의 evaluation 으로 세 방식을 같은 틀로 비교한다
    state.evaluation = Sources.mergeEvaluations([Object.assign(Sources.evaluateSource("summary", fullText, cands), { source: "summary", found: true })]);
    // 확인용: 모델이 낸 후보 수와 원문 대조 결과 (notebooks/local_llm_extraction.ipynb 의 비교와 같은 셈)
    state.extraction = {
      method: how, model: llm.name, candidates_n: cands.length, passed: v.evidence.length,
      dropped: v.dropped.map((d) => ({ attr: d.attr, why: d.why })), rule: v.rule,
    };
    // 위임 문구는 모델과 상관없이 원문에서 코드로 찾는다 (모델이 빠뜨려도 같은 결과)
    state.delegation = Criteria.findDelegation(fullText).map((d) => ({ value: d.value, by: d.by, quote: d.quote }));
    state.plan = planFor(v);
    return {
      method: how + " 추출 · 원문 대조" + (fullUsed ? " (제안이유 전문 " + fullText.length + "자)" : " (300자 요약)"),
      rule: v.rule,
      judgeable: judgeable(v.rule),
      use_rule: state.plan.use_rule,
      use_rule_source: state.plan.source,
      hold: state.plan.hold || null,
      hold_todo: state.plan.todo || null,
      delegation: state.delegation,
      plan_note: state.plan.note || null,
      evidence: v.evidence,
      dropped: v.dropped,
      demo_rule: demo ? { rule: demo.rule, source_text: demo.source_text, method: demo.method, note: "판정 시범 규칙 (데이터 만들 때 전체 요약 원문과 대조 통과)" } : null,
    };
  }

  function crosscheck() {
    const X = D.cross && D.cross.bills && D.cross.bills[no];
    const useExtracted = state.extracted && judgeable(state.extracted.rule);
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
    if (ok.no_split) {
      const p = state.plan || planFor(state.extracted);
      return { error: ok.error, next: p.use_rule ? "use_rule(" + p.source + ")로 judge_buildings 를 다시 부르세요" : "판정하지 말고 draft_review 를 부르세요 (" + p.hold + ")" };
    }
    if (ok.error) return { error: ok.error };
    const clean = JSON.parse(JSON.stringify(ok.rule));
    const J = Judge.countAll(D.props, clean);
    const top = Object.keys(J.reasons).map((k) => ({ status: k.split("|")[0], reason: k.split("|")[1], n: J.reasons[k] }))
      .sort((a, b) => b.n - a.n).slice(0, 4);
    // 대표 사례: 대상(없으면 경계선) 건물 3동의 속성만 (주소·PNU 없음)
    const samples = [];
    for (const st of ["대상", "경계선"]) {
      for (const p of D.props) {
        if (samples.length >= 3) break;
        const r = Judge.judge(p, clean);
        if (r.status === st) samples.push({ status: st, 용도: Judge.useName(p.usability), 연면적: p.totalarea, 층수: p.grnd_flr, 세대수: p.hhld_cnt || null, 사용승인: p.useapr_day ? String(p.useapr_day).slice(0, 4) : null });
      }
      if (samples.length) break;
    }
    state.judged = { rule: clean, source: ok.source, counts: J.counts, top };
    return { region: D.region, total: D.total, rule: clean, rule_source: ok.source, counts: J.counts, top_reasons: top, samples };
  }

  // 제안이유 머리말·공백 정리 (notebooks/field_classifier.ipynb 의 clean 과 같게)
  // 분야 분류 모델 이름 (노트북이 검증 성적이 높은 쪽을 골라 metrics.model 에 적는다)
  function modelKo(m) {
    return m && m.model === "logreg" ? "로지스틱 회귀" : m && m.model === "nn" ? "신경망" : "모델";
  }

  function cleanSummary(t) {
    return String(t || "").replace(/^\s*제안이유\s*(및\s*주요내용)?/, "").replace(/\s+/g, " ").trim();
  }

  function classifyField() {
    const M = D.models && D.models.field;
    if (!M) return { error: "분야 분류 모델 파일이 아직 없습니다 (models/field_classifier.json)" };
    const prob = M.predict(cleanSummary(fullText));
    const top = prob.map((p, i) => ({ field: M.labels[i], p })).sort((a, b) => b.p - a.p).slice(0, 3)
      .map((x) => ({ field: x.field, name: (D.fields && D.fields[x.field]) || x.field, p: Math.round(x.p * 1000) / 1000 }));
    // 1위 확률이 노트북 9-2절 기준값(review_threshold) 미만이면 "분류 확인 필요"
    const review = typeof M.metrics.review_threshold === "number" ? M.metrics.review_threshold : 0.6;
    const needsCheck = top[0].p < review;
    state.field = { top, metrics: M.metrics, needs_check: needsCheck, current: bill.field != null ? String(bill.field) : null };
    return { top, current_field: state.field.current, current_name: bill.field != null && D.fields ? D.fields[bill.field] : null,
      same_as_current: state.field.current === top[0].field, needs_check: needsCheck, review_threshold: review, model: M.metrics };
  }

  function predictPass() {
    const pm = D.models && D.models.pass;
    if (!pm) return { error: "통과 가능성 모델 결과가 아직 없습니다 (models/pass_prediction.json)" };
    const p = bill.pass_prob;
    if (p === undefined || p === null) return { error: "이 법안은 모델 예측이 없습니다 (학습 뒤에 들어온 새 법안이면 다음 학습 때 반영)" };
    // 3단계 구간 (notebooks/pass_prediction.ipynb 10-3절, 시간 분리 시험에서 정한 경계와 구간별 실제 반영 비율)
    const tiers = Array.isArray(pm.tiers) ? pm.tiers : [];
    const t = tiers.length ? (tiers.find((x) => p < x.max) || tiers[tiers.length - 1]) : null;
    // 화면과 같은 이름: 가장 높은 구간도 실제 반영률이 20%대라 "상대적으로 높음"
    const LABEL = { 낮음: "낮음", 보통: "보통", 높음: "상대적으로 높음" };
    const tier = t ? { name: LABEL[t.name] || t.name, actual_rate: t.actual_rate, n: t.n, min: t.min, max: t.max } : null;
    state.pass = { p, tier, metrics: pm.metrics || {} };
    return { pass_prob: p, tier: tier ? tier.name : null, tier_actual_rate: tier ? tier.actual_rate : null,
      label: tier ? "통과 가능성 " + tier.name : p >= (pm.threshold || 0.5) ? "통과 가능성 높음" : "통과 가능성 낮음",
      threshold: pm.threshold || 0.5, model: pm.metrics || {},
      note: "21대 국회 처리 결과로 학습한 신경망 추정. 제안한 날 알 수 있는 정보만 사용. 구간의 실제 반영률은 21대 나중에 낸 법안(시간 분리 시험)에서 잰 값. 법안의 좋고 나쁨과 무관" };
  }

  async function exec(name, args) {
    if (name !== "judge_buildings" && name !== "draft_review" && args.no && args.no !== no) return { error: "이번 검토 대상은 " + no + " 입니다" };
    if (name === "get_bill") {
      state.bill = bill;
      return { no: bill.no, name: bill.name, committee: bill.committee, date: bill.date, stage: bill.stage || null, stage_date: bill.stage_date || null, summary: fullText.slice(0, 1500), summary_chars: fullText.length, full_text: fullUsed };
    }
    if (name === "extract_criteria") return extractCriteria();
    if (name === "crosscheck") return crosscheck();
    if (name === "judge_buildings") return judgeBuildings(args.rule);
    if (name === "draft_review") return draftReview();
    if (name === "classify_field") return classifyField();
    if (name === "predict_pass") return predictPass();
    return { error: "모르는 도구" };
  }

  // 근거 문장에 없는 값을 버렸으면 단계 기록에 무엇을 뺐는지 남긴다
  function notInQuote(dropped) {
    const d = (dropped || []).filter((x) => String(x.why).indexOf(Criteria.NOT_IN_QUOTE) === 0);
    return d.length ? " · " + Criteria.NOT_IN_QUOTE + ": " + d.map((x) => x.why.replace(Criteria.NOT_IN_QUOTE, "").replace(/^\s*\(|\)\s*$/g, "")).join(", ") : "";
  }

  // 대화에 다시 실리는 도구 결과는 매 단계 토큰으로 쌓이므로, 모델에게는 결론만 짧게 준다
  function forModel(name, r) {
    if (r.error) return { error: r.error, next: r.next };
    if (name === "get_bill") return { no: r.no, name: r.name, committee: r.committee, stage: r.stage, summary: String(r.summary).slice(0, 400) };
    if (name === "extract_criteria") {
      const t = Criteria.ruleTexts(r.use_rule || {});
      return { use_rule: r.use_rule, source: r.use_rule_source, hold: r.hold,
        line: Object.keys(t).map((k) => k + " " + t[k]).join(", ") || "기준 없음", dropped: (r.dropped || []).length };
    }
    if (name === "crosscheck") {
      return { lines: (r.items || []).map((i) => `${i.attr}: ${i.status}` + (i.note ? ` (${String(i.note).slice(0, 40)})` : "")) };
    }
    if (name === "judge_buildings") {
      return { counts: r.counts, source: r.rule_source, reasons: (r.top_reasons || []).map((t) => `${t.status} ${t.reason} ${t.n}동`), samples: r.samples };
    }
    if (name === "classify_field" || name === "predict_pass") return { line: summarize(name, r) };
    if (name === "draft_review") return { ok: true, chars: (r.draft || "").length };
    return r;
  }

  function summarize(name, r) {
    if (r.error) return "실행하지 않음: " + r.error;
    if (name === "get_bill") return `${r.name} · ${r.committee} · 제안 ${r.date} · 단계 ${r.stage || "정보 없음"}`;
    if (name === "extract_criteria") {
      const t = Criteria.ruleTexts(r.rule);
      return "원문 대조 통과 기준 " + Object.keys(t).length + "개" + (Object.keys(t).length ? " (" + Object.keys(t).map((k) => k + " " + t[k]).join(", ") + ")" : "") +
        (r.dropped.length ? ", 근거가 맞지 않아 버린 기준 " + r.dropped.length + "개" : "") +
        notInQuote(r.dropped) + (r.demo_rule ? ", 판정 시범 규칙 있음" : "") +
        (r.delegation && r.delegation.length ? " · " + DELEG_CHECKED + " (" + Array.from(new Set(r.delegation.map((d) => d.by + "으로 정하는 " + d.value))).join(", ") + ")" : "") +
        (r.plan_note ? " · " + r.plan_note : "");
    }
    if (name === "crosscheck") return r.summary;
    if (name === "judge_buildings") {
      const c = r.counts;
      return `${r.rule_source}으로 ${r.region} ${fmt(r.total)}동 중 대상 ${fmt(c["대상"])}, 경계선 ${fmt(c["경계선"])}, 비대상 ${fmt(c["비대상"])}, 판정불가 ${fmt(c["판정불가"])}`;
    }
    if (name === "classify_field") {
      const t = r.top[0];
      return `${t.name} ${Math.round(t.p * 100)}%` + (r.top[1] ? `, 다음 ${r.top[1].name} ${Math.round(r.top[1].p * 100)}%` : "") +
        (r.current_name ? (r.same_as_current ? " (목록 분야와 같음)" : ` (목록 분야 ${r.current_name}와 다름)`) : "") +
        (r.needs_check ? ` · 분류 확인 필요 (확신도 ${r.review_threshold} 미만)` : "") +
        ` · ${modelKo(r.model)}` + (r.model && r.model.test_acc != null ? ` 모델 시험 정확도 ${Math.round(r.model.test_acc * 100)}%` : "");
    }
    if (name === "predict_pass") {
      return (r.tier ? `${r.label} (비슷한 과거 법안 반영률 ${Math.round(r.tier_actual_rate * 100)}%, 신경망 추정 ${Math.round(r.pass_prob * 100)}%, 모델 추정)`
        : `${r.label} (${Math.round(r.pass_prob * 100)}%, 모델 추정)`) +
        " · 제안한 날 알 수 있는 정보만 사용" + (r.model && r.model.test_auc != null ? ` · 모델 시험 AUC ${r.model.test_auc}` : "");
    }
    if (name === "draft_review") return "검토 초안 " + r.draft.length + "자" + (r.template ? " (정해진 틀로 작성)" : "") + (r.unverified.length ? ", 근거에 없는 숫자 " + r.unverified.length + "개" : "");
    return "";
  }

  // 필수 계산: 직접 학습한 모델 두 개는 모델이 고르게 두지 않고 코드가 먼저 계산한다 (단계 기록에는 "자동 계산")
  const auto = [];
  for (const name of ["classify_field", "predict_pass"]) {
    const r = await exec(name, { no });
    state.steps.push({ tool: name, tool_ko: TOOL_KO[name], why: "자동 계산 (도구를 고르기 전에 코드가 직접 계산)", summary: summarize(name, r), ok: !r.error, auto: true });
    auto.push(TOOL_KO[name] + ": " + (r.error ? "없음 (" + r.error + ")" : summarize(name, r)));
  }
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: "의안번호 " + no + " 법안의 검토 초안을 만들어 주세요." + (note ? " 검토 관점: " + note : "") +
      "\n[자동 계산]\n" + auto.join("\n") },
  ];
  while (true) {
    if (state.steps.filter((s) => !s.auto).length >= MAX_STEPS) { state.stopped = "단계 " + MAX_STEPS + "번에 도달해 멈춤"; break; }
    if (overBudget(CALL_MAX_TOKENS)) { state.stopped = "토큰 " + fmt(TOKEN_CAP) + "개를 넘기 전에 멈춤"; break; }
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
      if (state.steps.filter((s) => !s.auto).length >= MAX_STEPS) result = { error: "단계 제한" };
      else if (name === "classify_field" || name === "predict_pass") result = { error: "이미 자동 계산함 (첫 메시지 참고)" };
      else {
        result = TOOL_KO[name] ? await exec(name, args) : { error: "모르는 도구" };
        state.steps.push({ tool: name, tool_ko: TOOL_KO[name] || name, why: String(args.reason || "(이유를 적지 않음)").slice(0, 160), summary: summarize(name, result), ok: !result.error });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(forModel(name, result)).slice(0, 1500) });
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
    mode: "agent",
    steps: state.steps,
    step_count: state.steps.length,
    evaluation: state.evaluation ? state.evaluation.criteria : [],
    revived: [],
    sources_used: [{ source: "summary", source_ko: Sources.SOURCE_KO.summary, found: !!fullText }],
    draft: state.draft,
    rule: state.judged ? state.judged.rule : state.extracted ? state.extracted.rule : null,
    evidence: state.extracted ? state.extracted.evidence : [],
    extraction: state.extraction || null,
    rule_source: state.judged ? state.judged.source : null,
    counts: state.judged ? state.judged.counts : null,
    hold: !state.judged && state.plan && state.plan.hold ? state.plan.hold : null,
    hold_todo: !state.judged && state.plan && state.plan.hold ? state.plan.todo : null,
    delegation: state.delegation,
    region: D.region,
    total: D.total,
    crosscheck: state.cross,
    field_model: state.field || null,
    pass_model: state.pass || null,
    needs_human_review: true,
    unverified: state.unverified,
    model: llm.name,
    tokens: state.tokens,
    limits: { max_steps: MAX_STEPS, token_cap: TOKEN_CAP, stopped: state.stopped || null },
    cached: false,
  };
}

// ---------------------------------------------------------------- 핸들러
function queryMode(req) {
  if (req.query && req.query.mode) return String(req.query.mode);
  const m = /[?&]mode=([a-z0-9]+)/.exec(String(req.url || ""));
  return m ? m[1] : "";
}
// 비교 스크립트용 열쇠: 환경변수 AGENT_COMPARE_TOKEN(16자 이상)과 헤더가 같을 때만. 코드에 열쇠를 넣지 않는다
function compareAllowed(req, env = process.env) {
  const want = String(env.AGENT_COMPARE_TOKEN || "");
  const got = String((req.headers && req.headers["x-compare-token"]) || "");
  if (want.length < 16 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

module.exports = async function handler(req, res) {
  const okOrigin = cors(req, res);
  const mock = mockAllowed();
  const cfg = llmConfig();
  const MODEL = cfg.model;
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method === "GET") { res.status(200).json({ ok: mock || cfg.ready, model: mock ? "mock" : MODEL }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 받습니다" }); return; }
  const compare = compareAllowed(req);
  if (!okOrigin && !compare) { res.status(403).json({ error: "허용하지 않은 사이트입니다" }); return; }
  if (!compare && limited(clientIp(req))) { res.status(429).json({ error: "요청이 너무 잦습니다. 1분 뒤에 다시 해 주세요." }); return; }

  const body = readBody(req);
  const no = String(body.bill || "").trim();
  const note = String(body.note || "").trim().slice(0, 200);
  const mode = String(body.mode || queryMode(req) || "agent").trim();
  if (!MODES.includes(mode)) { res.status(400).json({ error: "mode 는 " + MODES.join(", ") + " 중 하나입니다" }); return; }
  if (!/^\d{7}$/.test(no)) { res.status(400).json({ error: "의안번호는 7자리 숫자여야 합니다" }); return; }
  if (PII.test(note)) { res.status(200).json({ fixed: true, answer: PII_ANSWER, steps: [], needs_human_review: true }); return; }
  if (PERSONAL_JUDGE.test(note)) { res.status(200).json({ fixed: true, answer: PERSONAL_ANSWER, steps: [], needs_human_review: true }); return; }

  try {
    const D = await loadData();
    if (!D.byNo[no]) { res.status(404).json({ error: "의안번호 " + no + " 법안을 찾지 못했습니다" }); return; }
    const key = no + "|" + note + (mode === "agent" ? "" : "|" + mode); // agent 는 예전과 같은 열쇠
    const hit = compare ? null : cacheGet(key);
    if (hit) { res.status(200).json(Object.assign({}, hit, { cached: true })); return; }
    if (!mock && !cfg.ready) { res.status(503).json({ error: "AI 키가 설정되지 않았습니다" }); return; }
    const llm = mock ? mockLLM() : openaiLLM(cfg.key, MODEL, cfg.url);
    const limits = { TOKEN_CAP, MAX_STEPS, CALL_MAX_TOKENS, DRAFT_MAX_TOKENS };
    const DD = mode === "agentic" ? await withVectorRules(D, no) : D;
    const out = mode === "agent" ? await run(D, no, note, llm)
      : await (mode === "agentic" ? Agentic.runAgentic : Agentic.runRag1)({ D: DD, no, note, llm, limits, EXTRACT_PROMPT });
    results.set(key, { at: Date.now(), body: out });
    if (!mock) await logRun({ bill_no: no, mode, steps: out.step_count || (out.steps || []).length, tokens: out.tokens });
    res.status(200).json(out);
  } catch (e) {
    res.status(502).json({ error: "검토 초안을 만들지 못했습니다: " + maskKey(e) });
  }
};

/**
 * Agentic RAG 의 비슷한 법안 규칙(similar_rules)도 비슷한 법안 찾기(lib/similar.js)와 같은 방법을 따른다.
 *   tfidf (측정 결과 TF-IDF 가 이김, 또는 SIMILAR_METHOD=tfidf)  → D 그대로 (시범 법안 사이 TF-IDF, sources.js)
 *   hybrid → 시범 규칙이 있는 법안 중 pgvector 상위 20 과 TF-IDF 순위를 RRF 로 합친 3건.
 *            pgvector 를 못 쓰면(키 없음·임베딩 없음·실패) TF-IDF 그대로.
 * 공용 D 는 캐시라 고치지 않고, 이 요청에만 쓰는 얕은 사본을 돌려준다.
 */
async function withVectorRules(D, no) {
  if (primaryMethod({ measured: D.similarMethod }) !== "hybrid") return D;
  const near = await similarByVector(no, 20);
  const vNos = (near || []).map((x) => x.no).filter((x) => x !== no && D.demos[x]);
  if (!vNos.length) return D;
  const tf = (D.similarRules || Sources.createSimilarRules(D))(no, Object.keys(D.demos).length);
  const tScore = new Map(tf.map((x) => [x.no, x.score]));
  const vScore = new Map(near.map((x) => [x.no, x.score]));
  const rules = rrf([tf.map((x) => x.no), vNos]).slice(0, 3).map((x) => ({
    no: x.no, title: D.demos[x.no].title, score: tScore.has(x.no) ? tScore.get(x.no) : Math.round(vScore.get(x.no) * 1000) / 1000,
    rrf: Math.round(x.rrf * 10000) / 10000, rule: D.demos[x.no].rule, label: Sources.CANDIDATE_LABEL, method: "hybrid",
  }));
  return Object.assign(Object.create(D), { similarRules: (n, k = 3) => rules.slice(0, k) });
}

// 시험용 (node server/scripts/test-agent.js)
module.exports._test = { clearCache: () => { results.clear(); dataCache = null; }, TOOLS, MAX_STEPS, TOKEN_CAP, llmConfig, OPENAI_URL, EXTRACT_PROMPT, compareAllowed, MODES, withVectorRules };
