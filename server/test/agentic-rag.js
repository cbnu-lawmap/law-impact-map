/*
 * Agentic RAG 시험 (네트워크 없음, fetch 를 가짜 모델 서버로 바꿈)
 *   node test/agentic-rag.js
 *
 * - 없는 출처는 "없음"
 * - evaluate_evidence 는 코드 규칙으로 판정에 충분 / 위임 확인 / 부족 을 나눈다
 * - 재검색 순서 summary → bill_text → review_report → similar_rules, 최대 3번
 * - similar_rules 는 "후보 규칙, 사람 확인 필요" 로만, 판정에 쓰지 않음
 * - 토큰 상한 12,000 을 지킴, 재검색 결과는 모델에게 짧게만 감
 * - mode 를 주지 않으면 예전 agent 그대로, rag1 은 모델 호출 한 번
 */
const assert = require("assert");
const path = require("path");

["AGENT_LLM_BASE_URL", "AGENT_LLM_MODEL", "AGENT_LLM_KEY", "OPENAI_MODEL", "OPENAI_API_KEY", "AGENT_MOCK", "AGENT_MOCK_SCRIPT", "VERCEL", "AGENT_COMPARE_TOKEN"].forEach((k) => delete process.env[k]);
process.env.DATA_DIR = path.join(__dirname, "..", "..", "web", "data");

const handler = require("../api/agent");
const S = require("../lib/sources");
const Criteria = require("../lib/criteria");
const Agentic = require("../lib/agentic");
const DATA = process.env.DATA_DIR;
const docs = require(path.join(DATA, "bill_docs.json")).docs;
const demos = require(path.join(DATA, "demo_rules.json")).demos;
const { TOKEN_CAP } = handler._test;

let ip = 0;
function call(body, headers = {}) {
  return new Promise((resolve) => {
    const req = { method: "POST", body, url: "/api/agent", headers: Object.assign({ origin: "http://localhost:8000", "x-forwarded-for": "10.9.0." + (++ip) }, headers) };
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(j) { resolve({ code: this.code, body: j }); }, end() { resolve({ code: this.code }); } };
    handler(req, res);
  });
}

// 가짜 모델 서버. script(messages) 가 다음 assistant 메시지를 정한다. 기준 뽑기(JSON) 호출에는 정규식 후보를 돌려준다
const calls = [];
const realFetch = global.fetch;
function fakeServer(script, tokens = 100) {
  return function (url, opts) {
    const body = JSON.parse(opts.body);
    calls.push(body);
    let message;
    if (body.response_format && body.response_format.type === "json_object") {
      const text = body.messages[1].content.replace(/^\[[^\]]*\]\n/, "");
      message = { role: "assistant", content: JSON.stringify({ items: Criteria.extractCandidates(text) }) };
    } else if (body.tools) message = script(body.messages);
    else message = { role: "assistant", content: "" }; // 초안 → 틀 문장
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message }], usage: { total_tokens: tokens } }) });
  };
}
const toolCall = (name, args, n) => ({ role: "assistant", content: null, tool_calls: [{ id: "c" + n, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
// 서버가 알려 준 next 를 따르는 모델
function follower(messages) {
  const no = (messages[1].content.match(/\d{7}/) || [""])[0];
  return Agentic.followNext(messages, no);
}
async function withModel(script, fn, tokens) {
  process.env.OPENAI_API_KEY = "sk-test";
  calls.length = 0;
  global.fetch = fakeServer(script, tokens);
  handler._test.clearCache();
  try { return await fn(); } finally { global.fetch = realFetch; delete process.env.OPENAI_API_KEY; }
}

const D0 = (() => {
  const byNo = {};
  require(path.join(DATA, "bills.json")).bills.forEach((b) => { byNo[b.no] = b; });
  const dm = {};
  demos.forEach((d) => { dm[d.bill_no] = d; });
  return { byNo, demos: dm, full: require(path.join(DATA, "summaries.json")).summaries, docs };
})();

const tests = [];
const test = (n, f) => tests.push([n, f]);

// ---------------------------------------------------------------- 출처
test("없는 출처는 \"없음\" (원문·검토보고서 자료가 없는 법안, 모르는 출처)", async () => {
  assert.ok(!docs["2207658"], "시험 전제: 2207658 은 bill_docs 에 없음");
  ["bill_text", "review_report"].forEach((s) => {
    const r = S.searchSource(D0, "2207658", s);
    assert.strictEqual(r.found, false);
    assert.strictEqual(r.text, "없음");
  });
  assert.strictEqual(S.searchSource(D0, "2207658", "nope").text, "없음");
  assert.strictEqual(S.searchSource(D0, "2207658", "summary").found, true);
  assert.strictEqual(S.evaluateSource("bill_text", "없음", []).items && Object.keys(S.evaluateSource("bill_text", "없음", []).items).length, 0);
});

test("bill_docs.json: 원문은 개정 부분, 사람 이름이 든 문장 없음", async () => {
  Object.keys(docs).forEach((no) => {
    const d = docs[no];
    ["bill_text", "review_report"].forEach((k) => { if (d[k]) assert.ok(!/의원|전문위원|조사관|위원장|대표발의/.test(d[k]), no + " " + k); });
    if (d.review_report) assert.ok(d.review_report.length <= 3000, no);
  });
});

// ---------------------------------------------------------------- 근거 평가 (코드 규칙)
test("evaluate_evidence: 판정에 충분 / 위임 확인 / 부족 (코드 규칙만)", async () => {
  const t1 = "연면적 1천제곱미터 이상인 공장에 소방시설을 설치하도록 한다.";
  const e1 = S.evaluateSource("summary", t1, Criteria.extractCandidates(t1));
  assert.strictEqual(e1.items.연면적.status, S.ST_OK);
  assert.deepStrictEqual(e1.items.연면적.value, { min: 1000 });
  assert.strictEqual(e1.items.용도.status, S.ST_OK);

  const t2 = "대통령령으로 정하는 규모 이상의 건축물에는 점검을 의무화한다.";
  const e2 = S.evaluateSource("summary", t2, Criteria.extractCandidates(t2));
  assert.strictEqual(e2.items.연면적.status, S.ST_DELEG);

  const t3 = "일정 규모 이상의 건축물에는 점검을 의무화한다.";
  const e3 = S.evaluateSource("summary", t3, Criteria.extractCandidates(t3));
  assert.strictEqual(e3.items.연면적.status, S.ST_LOW);

  // 모델이 지어낸 근거 문구: 원문 대조 실패 → 부족
  const e4 = S.evaluateSource("summary", t3, [{ attr: "연면적", bound: "min", value: 500, quote: "연면적 500제곱미터 이상" }]);
  assert.strictEqual(e4.items.연면적.status, S.ST_LOW);
  assert.ok(/그대로 없음/.test(e4.items.연면적.why), e4.items.연면적.why);

  // 수치는 있지만 단위가 없음 → 부족
  const t5 = "연면적 1000 이상인 건축물에 적용한다.";
  const e5 = S.evaluateSource("summary", t5, [{ attr: "연면적", bound: "min", value: 1000, quote: t5 }]);
  assert.strictEqual(e5.items.연면적.status, S.ST_LOW);

  // 검토보고서의 현행법 설명 문장은 개정 내용이 아님 → 버림
  const t6 = "현행법은 연면적 3천제곱미터 이상인 공장에 적용하고 있음.";
  const e6 = S.evaluateSource("review_report", t6, Criteria.extractCandidates(t6));
  assert.notStrictEqual(e6.items.연면적.status, S.ST_OK);
  assert.ok(e6.dropped.some((d) => d.why === S.CURRENT_LAW));

  // 원문 개정 부분에 같은 기준 수치가 여럿 → 버림
  const t7 = "1. 연면적 1천제곱미터 이상인 공장. 2. 연면적 5천제곱미터 이상인 창고.";
  const e7 = S.evaluateSource("bill_text", t7, Criteria.extractCandidates(t7));
  assert.notStrictEqual(e7.items.연면적.status, S.ST_OK);
  assert.ok(e7.dropped.some((d) => d.why === S.AMBIGUOUS));
});

test("기준별로 모으기: 요약에서 부족 → 나중 출처에서 충분이면 revived", async () => {
  const sum = "일정 규모 이상의 공장에 적용한다.";
  const doc = "연면적 2천제곱미터 이상인 공장에 적용한다.";
  const evals = [
    Object.assign(S.evaluateSource("summary", sum, Criteria.extractCandidates(sum)), { source: "summary", found: true }),
    Object.assign(S.evaluateSource("bill_text", doc, Criteria.extractCandidates(doc)), { source: "bill_text", found: true }),
  ];
  const m1 = S.mergeEvaluations(evals.slice(0, 1));
  assert.ok(S.needMore(m1));
  const m = S.mergeEvaluations(evals);
  assert.ok(!S.needMore(m));
  assert.deepStrictEqual(m.rule, { 용도: ["17000"], 연면적: { min: 2000 } });
  assert.deepStrictEqual(m.revived.map((r) => [r.attr, r.from, r.by]), [["연면적", S.ST_LOW, "bill_text"]]);
});

// ---------------------------------------------------------------- Agentic RAG 실행
test("재검색 순서 summary → bill_text → review_report → similar_rules, 3번까지, 단계에 '평가 → 다음 출처' 이유", async () => {
  const r = await withModel(follower, () => call({ bill: "2219223", mode: "agentic" }));
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  const j = r.body;
  assert.strictEqual(j.mode, "agentic");
  assert.deepStrictEqual(j.steps.filter((s) => s.tool === "search_sources").map((s) => s.source), ["summary", "bill_text", "review_report", "similar_rules"]);
  assert.strictEqual(j.researches, 3);
  assert.deepStrictEqual(j.sources_used.map((s) => s.source), S.SOURCES);
  const evals = j.steps.filter((s) => s.tool === "evaluate_evidence");
  assert.strictEqual(evals.length, 4);
  evals.forEach((s) => assert.ok(s.auto && /평가 결과: .* → /.test(s.summary), s.summary));
  evals.slice(0, 3).forEach((s) => assert.ok(/다음 출처 .* 선택: /.test(s.summary), s.summary));
  assert.ok(/재검색 3번을 다 써서|더 찾을 출처가 없음/.test(j.search_stop), j.search_stop);
  assert.ok(j.step_count === j.steps.length && j.tokens > 0);
  assert.ok(Array.isArray(j.evaluation) && j.evaluation.every((c) => [S.ST_OK, S.ST_DELEG, S.ST_LOW].includes(c.status)));
  assert.ok(j.draft && j.needs_human_review);
  assert.ok(!/—/.test(j.draft));
});

test("근거가 충분하면 더 찾지 않음 (2206436: 요약만)", async () => {
  const r = await withModel(follower, () => call({ bill: "2206436", mode: "agentic" }));
  const j = r.body;
  assert.deepStrictEqual(j.sources_used.map((s) => s.source), ["summary"]);
  assert.strictEqual(j.researches, 0);
  const demo = demos.find((d) => d.bill_no === "2206436");
  assert.deepStrictEqual(j.rule, demo.rule);
  assert.strictEqual(j.rule_source, "원문 대조 통과 기준");
});

test("순서를 어기거나 3번을 넘긴 재검색은 거절", async () => {
  const plan = ["summary", "review_report", "bill_text", "review_report", "similar_rules", "bill_text", "summary"];
  let n = 0;
  const greedy = (messages) => {
    const no = (messages[1].content.match(/\d{7}/) || [""])[0];
    if (n >= plan.length) return { role: "assistant", content: "끝" };
    const src = plan[n++];
    return toolCall("search_sources", { reason: "찾아봅니다.", no, source: src }, n);
  };
  const r = await withModel(greedy, () => call({ bill: "2219223", mode: "agentic" }));
  const j = r.body;
  const ss = j.steps.filter((s) => s.tool === "search_sources");
  assert.deepStrictEqual(ss.filter((s) => s.ok).map((s) => s.source), ["summary", "bill_text", "review_report", "similar_rules"]);
  const bad = ss.filter((s) => !s.ok);
  assert.strictEqual(bad.length, 3, JSON.stringify(bad));
  assert.ok(/순서상 다음 출처는 bill_text/.test(bad[0].summary), bad[0].summary);
  assert.ok(bad.slice(1).every((s) => /재검색은 3번까지/.test(s.summary)), JSON.stringify(bad));
  assert.strictEqual(j.researches, 3);
});

test("similar_rules 는 '후보 규칙, 사람 확인 필요' 로만, 판정에 넘기면 거절", async () => {
  let cand = null, n = 0;
  const tryCandidate = (messages) => {
    const no = (messages[1].content.match(/\d{7}/) || [""])[0];
    const tools = messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
    const last = tools[tools.length - 1];
    if (last && last.candidates && !cand) {
      cand = last.candidates[0];
      // 모델에게 간 후보에는 규칙 값이 없다 (요약만). 모델이 후보 법안의 규칙을 아는 척 넘겨 본다
      const rule = demos.find((d) => d.bill_no === cand.no).rule;
      return toolCall("judge_buildings", { reason: "비슷한 법안 규칙으로 집계해 봅니다.", rule }, ++n);
    }
    if (cand && n < 50) { n = 50; return toolCall("draft_review", { reason: "초안", no }, n); }
    return Agentic.followNext(messages, no);
  };
  const r = await withModel(tryCandidate, () => call({ bill: "2219223", mode: "agentic" }));
  const j = r.body;
  assert.ok(j.candidates.length > 0);
  j.candidates.forEach((c) => assert.strictEqual(c.label, "후보 규칙, 사람 확인 필요"));
  assert.ok(cand && cand.label === S.CANDIDATE_LABEL);
  const judged = j.steps.filter((s) => s.tool === "judge_buildings");
  assert.ok(/후보 규칙은 사람 확인 전이라 판정에 쓰지 않습니다/.test(judged[0].summary), judged[0].summary);
  assert.ok(judged[0].ok === false);
  // 후보 규칙이 판정 규칙이 되지 않았다
  assert.notStrictEqual(Agentic.canon(j.rule), Agentic.canon(demos.find((d) => d.bill_no === cand.no).rule));
  assert.ok(j.evaluation.every((c) => c.source !== "similar_rules"));
  assert.ok(j.revived.every((x) => x.by !== "similar_rules"));
});

test("토큰 상한 12,000 을 넘기 전에 멈추고, 서버가 토큰 없이 마무리", async () => {
  const r = await withModel(follower, () => call({ bill: "2219223", mode: "agentic" }), 2900);
  const j = r.body;
  assert.ok(j.tokens <= TOKEN_CAP, String(j.tokens));
  assert.ok(/토큰/.test(j.limits.stopped || ""), JSON.stringify(j.limits));
  assert.strictEqual(j.limits.token_cap, 12000);
  assert.ok(j.draft);
  // 마지막 모델 호출 뒤 남은 출처는 서버가 정규식으로 (순서와 3번 제한 같게)
  assert.deepStrictEqual(j.steps.filter((s) => s.tool === "search_sources").map((s) => s.source).slice(0, 4), S.SOURCES.slice(0, j.sources_used.length));
});

test("재검색 결과는 모델에게 짧게만 (출처 글 전체를 대화에 싣지 않음)", async () => {
  await withModel(follower, () => call({ bill: "2219223", mode: "agentic" }));
  const chats = calls.filter((c) => c.tools);
  const tail = docs["2219223"].review_report.slice(100, 160);
  chats.forEach((c) => c.messages.filter((m) => m.role === "tool").forEach((m) => {
    assert.ok(m.content.length <= 1200, m.content.length);
    assert.ok(m.content.indexOf(tail) < 0, "검토보고서 글이 대화에 실림");
  }));
  // 대화에 쓴 도구 목록은 Agentic RAG 도구
  assert.deepStrictEqual(chats[0].tools.map((t) => t.function.name), ["search_sources", "judge_buildings", "draft_review"]);
});

// ---------------------------------------------------------------- 다른 방식
test("rag1: 요약 한 번, 모델 호출 한 번, 도구 고르기 없음", async () => {
  const r = await withModel(follower, () => call({ bill: "2206436", mode: "rag1" }));
  const j = r.body;
  assert.strictEqual(r.code, 200, JSON.stringify(j));
  assert.strictEqual(j.mode, "rag1");
  assert.strictEqual(calls.length, 1);
  assert.ok(!calls[0].tools && calls[0].response_format);
  assert.deepStrictEqual(j.sources_used.map((s) => s.source), ["summary"]);
  assert.deepStrictEqual(j.steps.map((s) => s.tool), ["search_sources", "extract_criteria", "evaluate_evidence", "judge_buildings", "draft_review"]);
  assert.ok(j.tokens === 100 && j.counts);
});

test("mode 를 주지 않으면 예전 agent 그대로, 모르는 mode 는 400, ?mode= 도 받음", async () => {
  process.env.AGENT_MOCK = "1";
  try {
    handler._test.clearCache();
    const a = await call({ bill: "2206436" });
    assert.strictEqual(a.body.mode, "agent");
    assert.deepStrictEqual(a.body.steps.map((s) => s.tool), ["classify_field", "predict_pass", "get_bill", "extract_criteria", "crosscheck", "judge_buildings", "draft_review"]);
    assert.ok(Array.isArray(a.body.evaluation) && a.body.sources_used.length === 1 && a.body.step_count === a.body.steps.length);
    const bad = await call({ bill: "2206436", mode: "zzz" });
    assert.strictEqual(bad.code, 400);
    const q = await new Promise((resolve) => {
      const req = { method: "POST", body: { bill: "2206436" }, url: "/api/agent?mode=rag1", headers: { origin: "http://localhost:8000", "x-forwarded-for": "10.9.9.9" } };
      const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(j) { resolve({ code: this.code, body: j }); } };
      handler(req, res);
    });
    assert.strictEqual(q.body.mode, "rag1");
  } finally { delete process.env.AGENT_MOCK; }
});

test("비교용 열쇠: 환경변수가 없거나 짧으면 닫힘, 같을 때만 열림", async () => {
  const { compareAllowed } = handler._test;
  const req = (t) => ({ headers: { "x-compare-token": t } });
  assert.strictEqual(compareAllowed(req("abcdefghijklmnop"), {}), false);
  assert.strictEqual(compareAllowed(req("short"), { AGENT_COMPARE_TOKEN: "short" }), false);
  assert.strictEqual(compareAllowed(req("abcdefghijklmnop"), { AGENT_COMPARE_TOKEN: "abcdefghijklmnop" }), true);
  assert.strictEqual(compareAllowed(req("abcdefghijklmnoX"), { AGENT_COMPARE_TOKEN: "abcdefghijklmnop" }), false);
  // 열쇠가 맞으면 사이트 확인·호출 수 제한을 건너뜀 (가짜 모델로 6번 연속)
  process.env.AGENT_MOCK = "1";
  process.env.AGENT_COMPARE_TOKEN = "test-token-0123456789";
  try {
    for (let i = 0; i < 6; i++) {
      const r = await call({ bill: "2206436", mode: "rag1" }, { origin: "", "x-forwarded-for": "10.8.8.8", "x-compare-token": "test-token-0123456789" });
      assert.strictEqual(r.code, 200, "요청 " + (i + 1) + ": " + JSON.stringify(r.body));
    }
    const no = await call({ bill: "2206436", mode: "rag1" }, { origin: "" });
    assert.strictEqual(no.code, 403);
  } finally { delete process.env.AGENT_MOCK; delete process.env.AGENT_COMPARE_TOKEN; }
});

(async () => {
  let fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("통과  " + n); } catch (e) { fail++; console.log("실패  " + n + "\n      " + (e.stack || e.message).split("\n").slice(0, 3).join("\n      ")); }
  }
  console.log(fail ? "실패 " + fail + "개" : "모두 통과 (" + tests.length + "개)");
  process.exit(fail ? 1 : 0);
})();
