#!/usr/bin/env node
/*
 * 검토 에이전트 시험 (OpenAI 키 없이)
 *   AGENT_MOCK=1 (가짜 모델) + DATA_DIR=web/data (로컬 파일) 로 api/agent.js 핸들러를 직접 부른다.
 *   실행: node server/scripts/test-agent.js
 */
const assert = require("assert");
const path = require("path");

process.env.AGENT_MOCK = "1";
process.env.DATA_DIR = path.join(__dirname, "..", "..", "web", "data");
delete process.env.VERCEL;
delete process.env.OPENAI_API_KEY;
delete process.env.AGENT_MOCK_SCRIPT;

const handler = require("../api/agent");
const ask = require("../api/ask");
const Criteria = require("../lib/criteria");
const bills = require(path.join(process.env.DATA_DIR, "bills.json")).bills;
const demos = require(path.join(process.env.DATA_DIR, "demo_rules.json")).demos;

let ipSeq = 0;
function call(fn, { method = "POST", body, origin = "http://localhost:8000", ip } = {}) {
  return new Promise((resolve) => {
    const req = { method, body, headers: { origin, "x-forwarded-for": ip || "10.0.0." + (++ipSeq) } };
    const res = {
      code: 200, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(j) { resolve({ code: this.code, body: j, headers: this.headers }); },
      end() { resolve({ code: this.code, body: null, headers: this.headers }); },
    };
    fn(req, res);
  });
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("GET 은 가짜 모델로 준비됨을 알림", async () => {
  const r = await call(handler, { method: "GET" });
  assert.strictEqual(r.code, 200);
  assert.deepStrictEqual(r.body, { ok: true, model: "mock" });
});

test("2206436 끝까지 실행: 도구 순서, 동수 = 시범 규칙 동수, 초안", async () => {
  handler._test.clearCache();
  const r = await call(handler, { body: { bill: "2206436" } });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  const j = r.body;
  assert.deepStrictEqual(j.steps.map((s) => s.tool), ["get_bill", "extract_criteria", "crosscheck", "judge_buildings", "draft_review"]);
  j.steps.forEach((s) => { assert.ok(s.why && s.summary && s.ok, JSON.stringify(s)); });
  const demo = demos.find((d) => d.bill_no === "2206436");
  assert.deepStrictEqual(j.rule, demo.rule);
  assert.deepStrictEqual(j.counts, demo.counts);
  assert.strictEqual(j.rule_source, "판정 시범 규칙");
  assert.ok(j.draft.length > 50 && !j.draft.includes("—"));
  assert.strictEqual(j.needs_human_review, true);
  assert.strictEqual(j.cached, false);
  assert.strictEqual(j.model, "mock");
  assert.deepStrictEqual(j.unverified, []);
  assert.ok(j.crosscheck && j.crosscheck.found);
  assert.strictEqual(r.headers["Access-Control-Allow-Origin"], "http://localhost:8000");
});

test("같은 법안 두 번째는 저장한 결과 (cached: true)", async () => {
  const r = await call(handler, { body: { bill: "2206436" } });
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.cached, true);
  assert.strictEqual(r.body.steps.length, 5);
});

test("판정 시범이 아닌 법안: 원문 대조 통과 기준으로 판정, 근거는 요약의 부분 문자열", async () => {
  const b = bills.find((x) => x.no === "2220604");
  const r = await call(handler, { body: { bill: b.no } });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  const norm = Criteria.normText(b.summary);
  assert.ok(r.body.evidence.length > 0);
  r.body.evidence.forEach((e) => assert.ok(norm.includes(e.quote), e.quote));
  assert.ok(r.body.counts, "판정 동수 없음");
  assert.strictEqual(Object.values(r.body.counts).reduce((a, b) => a + b, 0), r.body.total);
});

test("근거 없는 기준은 버림 (문구가 원문에 없거나 수치가 문구에 없음)", async () => {
  const s = "현행법은 연면적 300제곱미터 이상인 건축물에 적용함.";
  const v = Criteria.verify([
    { attr: "연면적", bound: "min", value: 300, quote: "연면적 300제곱미터 이상" },
    { attr: "연면적", bound: "max", value: 500, quote: "연면적 300제곱미터 이상" },
    { attr: "층수", bound: "min", value: 3, quote: "3층 이상인 건축물" },
  ], s);
  assert.deepStrictEqual(v.rule, { 연면적: { min: 300 } });
  assert.strictEqual(v.dropped.length, 2);
});

test("의안번호가 7자리가 아니면 400, 없는 번호면 404", async () => {
  assert.strictEqual((await call(handler, { body: { bill: "12345" } })).code, 400);
  assert.strictEqual((await call(handler, { body: { bill: "22064361" } })).code, 400);
  assert.strictEqual((await call(handler, { body: {} })).code, 400);
  assert.strictEqual((await call(handler, { body: { bill: "9999999" } })).code, 404);
});

test("개인정보·개별 건물 판정 요청은 고정 문구", async () => {
  const a = await call(handler, { body: { bill: "2206436", note: "담당 010-1234-5678 로 연락" } });
  assert.strictEqual(a.body.fixed, true);
  assert.ok(/개인정보/.test(a.body.answer));
  const b = await call(handler, { body: { bill: "2206436", note: "우리 집이 대상인지 알려줘" } });
  assert.strictEqual(b.body.fixed, true);
  assert.ok(/판정하지 않습니다/.test(b.body.answer));
});

test("단계 제한: 모델이 끝없이 도구를 불러도 8단계에서 멈춤", async () => {
  handler._test.clearCache();
  process.env.AGENT_MOCK_SCRIPT = "loop";
  const r = await call(handler, { body: { bill: "2206436" } });
  delete process.env.AGENT_MOCK_SCRIPT;
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.body.steps.length, handler._test.MAX_STEPS);
  assert.ok(/단계/.test(r.body.limits.stopped));
  assert.ok(r.body.draft.length > 0, "멈춰도 틀 문장 초안은 있어야 함");
});

test("토큰 제한: 합계 12,000 넘으면 멈춤", async () => {
  handler._test.clearCache();
  process.env.AGENT_MOCK_SCRIPT = "tokens";
  const r = await call(handler, { body: { bill: "2206436" } });
  delete process.env.AGENT_MOCK_SCRIPT;
  assert.strictEqual(r.code, 200);
  assert.ok(/토큰/.test(r.body.limits.stopped), JSON.stringify(r.body.limits));
  assert.ok(r.body.steps.length < 5);
  assert.ok(r.body.tokens >= handler._test.TOKEN_CAP);
  handler._test.clearCache();
});

test("근거 없는 규칙으로 판정하려 하면 거절 (지어낸 수치)", async () => {
  handler._test.clearCache();
  process.env.AGENT_MOCK_SCRIPT = "invent";
  const r = await call(handler, { body: { bill: "2206436" } });
  delete process.env.AGENT_MOCK_SCRIPT;
  const j = r.body.steps.find((s) => s.tool === "judge_buildings");
  assert.strictEqual(j.ok, false);
  assert.ok(/실행하지 않음/.test(j.summary));
  assert.strictEqual(r.body.counts, null);
  assert.ok(!/777/.test(r.body.draft));
  handler._test.clearCache();
});

test("허용하지 않은 사이트에서는 403", async () => {
  const r = await call(handler, { body: { bill: "2206436" }, origin: "https://evil.example" });
  assert.strictEqual(r.code, 403);
});

test("IP당 1분 5회 넘으면 429", async () => {
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await call(handler, { body: { bill: "12345" }, ip: "10.9.9.9" })).code);
  assert.deepStrictEqual(codes, [400, 400, 400, 400, 400, 429]);
});

test("Vercel 에서는 가짜 모델을 쓰지 않음 (키 없으면 503)", async () => {
  handler._test.clearCache();
  process.env.VERCEL = "1";
  const g = await call(handler, { method: "GET" });
  const r = await call(handler, { body: { bill: "2206436" } });
  delete process.env.VERCEL;
  assert.deepStrictEqual(g.body.ok, false);
  assert.strictEqual(r.code, 503);
});

test("ask.js 는 공통 부품으로 바꾼 뒤에도 그대로 동작 (키 없음 GET, 개인정보 고정 문구, 403)", async () => {
  const g = await call(ask, { method: "GET" });
  assert.deepStrictEqual(g.body, { ok: false, model: "gpt-4o-mini" });
  const p = await call(ask, { body: { q: "제 메일 a@b.com 이에요" } });
  assert.strictEqual(p.body.fixed, true);
  const f = await call(ask, { body: { q: "질문" }, origin: "https://evil.example" });
  assert.strictEqual(f.code, 403);
  const e = await call(ask, { body: { q: "" } });
  assert.strictEqual(e.code, 400);
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("통과  " + name); } catch (e) { fail++; console.log("실패  " + name + "\n      " + e.message); }
  }
  console.log(fail ? fail + "개 실패" : "모두 통과 (" + tests.length + "개)");
  process.exit(fail ? 1 : 0);
})();
