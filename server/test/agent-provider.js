/*
 * 모델 서버 바꾸기 시험 (네트워크 없음, fetch 를 가짜로 바꿈)
 *   node test/agent-provider.js
 *
 * - 환경변수를 주지 않으면 지금과 같은 OpenAI 주소·gpt-4o-mini·OPENAI_API_KEY
 * - AGENT_LLM_BASE_URL 을 주면 모든 모델 호출이 그 주소의 /chat/completions 로 가고,
 *   모델 이름은 AGENT_LLM_MODEL, 키는 AGENT_LLM_KEY 만 쓴다 (OpenAI 키를 다른 서버에 보내지 않음)
 * - 응답에 확인용 extraction (후보 수·통과 수·버린 이유) 이 붙는다
 */
const assert = require("assert");
const path = require("path");

const ENV_KEYS = ["AGENT_LLM_BASE_URL", "AGENT_LLM_MODEL", "AGENT_LLM_KEY", "OPENAI_MODEL", "OPENAI_API_KEY", "AGENT_MOCK", "AGENT_MOCK_SCRIPT", "VERCEL"];
ENV_KEYS.forEach((k) => delete process.env[k]);
process.env.DATA_DIR = path.join(__dirname, "..", "..", "web", "data");

const handler = require("../api/agent");
const { llmConfig, OPENAI_URL } = handler._test;

let ip = 0;
function call(body) {
  return new Promise((resolve) => {
    const req = { method: "POST", body, headers: { origin: "http://localhost:8000", "x-forwarded-for": "10.7.0." + (++ip) } };
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(j) { resolve({ code: this.code, body: j }); }, end() { resolve({ code: this.code }); } };
    handler(req, res);
  });
}

// 가짜 모델 서버: 첫 호출은 도구 없이 "끝", 기준 뽑기(JSON) 호출에는 정해진 후보를 돌려준다
const calls = [];
const realFetch = global.fetch;
function fakeFetch(url, opts) {
  const body = JSON.parse(opts.body);
  calls.push({ url, headers: opts.headers, body });
  let message = { role: "assistant", content: "끝" };
  if (body.response_format && body.response_format.type === "json_object") {
    message.content = JSON.stringify({ items: [{ attr: "층수", bound: "min", value: 2, quote: "요약에 없는 지어낸 문구" }] });
  } else if (body.tools && !body.messages.some((m) => m.role === "tool")) {
    const no = (body.messages[1].content.match(/\d{7}/) || [""])[0];
    message = { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "extract_criteria", arguments: JSON.stringify({ reason: "기준을 뽑습니다.", no }) } }] };
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message }], usage: { total_tokens: 10 } }) });
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("환경변수가 없으면 OpenAI 기본값 (주소·모델·키)", async () => {
  const c = llmConfig({ OPENAI_API_KEY: "sk-test" });
  assert.strictEqual(c.provider, "openai");
  assert.strictEqual(c.url, "https://api.openai.com/v1/chat/completions");
  assert.strictEqual(c.url, OPENAI_URL);
  assert.strictEqual(c.model, "gpt-4o-mini");
  assert.strictEqual(c.key, "sk-test");
  assert.strictEqual(c.ready, true);
  assert.strictEqual(llmConfig({}).ready, false, "키도 주소도 없으면 준비 안 됨 (지금처럼 503)");
  assert.strictEqual(llmConfig({ OPENAI_MODEL: "gpt-4o" }).model, "gpt-4o", "OPENAI_MODEL 은 지금처럼 동작");
});

test("AGENT_LLM_BASE_URL 을 주면 그 주소로, OpenAI 키는 보내지 않음", async () => {
  const c = llmConfig({ AGENT_LLM_BASE_URL: "http://localhost:11434/v1/", AGENT_LLM_MODEL: "qwen2.5:1.5b-instruct", OPENAI_API_KEY: "sk-secret" });
  assert.strictEqual(c.provider, "custom");
  assert.strictEqual(c.url, "http://localhost:11434/v1/chat/completions");
  assert.strictEqual(c.model, "qwen2.5:1.5b-instruct");
  assert.strictEqual(c.key, "");
  assert.strictEqual(c.ready, true);
  assert.strictEqual(llmConfig({ AGENT_LLM_BASE_URL: "http://h:8000/v1/chat/completions" }).url, "http://h:8000/v1/chat/completions");
});

test("env 없음: 에이전트 호출이 api.openai.com 으로 감 (가짜 fetch)", async () => {
  process.env.OPENAI_API_KEY = "sk-test";
  calls.length = 0;
  global.fetch = fakeFetch;
  try {
    const r = await call({ bill: "2206436", note: "기본 서버" });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.ok(calls.length > 0, "모델 호출 없음");
    calls.forEach((c) => {
      assert.strictEqual(c.url, OPENAI_URL);
      assert.strictEqual(c.body.model, "gpt-4o-mini");
      assert.strictEqual(c.headers.Authorization, "Bearer sk-test");
    });
    assert.strictEqual(r.body.model, "gpt-4o-mini");
  } finally { global.fetch = realFetch; delete process.env.OPENAI_API_KEY; }
});

test("env 있음: 에이전트 호출이 로컬 주소로 가고, 확인용 extraction 이 붙음", async () => {
  process.env.AGENT_LLM_BASE_URL = "http://127.0.0.1:11434/v1";
  process.env.AGENT_LLM_MODEL = "qwen2.5:1.5b-instruct";
  process.env.OPENAI_API_KEY = "sk-secret";
  calls.length = 0;
  global.fetch = fakeFetch;
  try {
    const r = await call({ bill: "2206436", note: "로컬 서버" });
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    assert.ok(calls.length > 0, "모델 호출 없음");
    calls.forEach((c) => {
      assert.strictEqual(c.url, "http://127.0.0.1:11434/v1/chat/completions");
      assert.strictEqual(c.body.model, "qwen2.5:1.5b-instruct");
      assert.ok(!c.headers.Authorization, "다른 서버에 키를 보내면 안 됨");
    });
    assert.strictEqual(r.body.model, "qwen2.5:1.5b-instruct");
    // 기준 뽑기 JSON 호출도 로컬 서버로 갔고, 지어낸 근거 문구는 원문 대조에서 버려짐
    assert.ok(calls.some((c) => c.body.response_format && c.body.response_format.type === "json_object"), "기준 뽑기 호출 없음");
    const ex = r.body.extraction;
    assert.ok(ex, "extraction 없음");
    assert.strictEqual(ex.method, "AI");
    assert.strictEqual(ex.model, "qwen2.5:1.5b-instruct");
    assert.strictEqual(ex.candidates_n, 1);
    assert.strictEqual(ex.passed, 0);
    assert.deepStrictEqual(ex.dropped, [{ attr: "층수", why: "근거 문구가 요약 원문에 그대로 없음" }]);
  } finally {
    global.fetch = realFetch;
    ["AGENT_LLM_BASE_URL", "AGENT_LLM_MODEL", "OPENAI_API_KEY"].forEach((k) => delete process.env[k]);
  }
});

test("extraction: 후보 수·통과 수·버린 이유 (가짜 모델로 extract_criteria 실행)", async () => {
  process.env.AGENT_MOCK = "1";
  try {
    const r = await call({ bill: "2206436", note: "추출 확인" });
    const ex = r.body.extraction;
    assert.ok(ex, "extraction 없음");
    assert.strictEqual(ex.method, "정규식");
    assert.strictEqual(ex.passed, r.body.evidence.length);
    assert.strictEqual(ex.candidates_n >= ex.passed, true);
    assert.ok(Array.isArray(ex.dropped) && ex.dropped.every((d) => d.attr && d.why));
    assert.ok(ex.rule && typeof ex.rule === "object");
  } finally { delete process.env.AGENT_MOCK; }
});

(async () => {
  let fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("통과  " + n); } catch (e) { fail++; console.log("실패  " + n + "\n      " + e.message); }
  }
  console.log(fail ? "실패 " + fail + "개" : "모두 통과 (" + tests.length + "개)");
  process.exit(fail ? 1 : 0);
})();
