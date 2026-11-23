/*
 * 에이전트 실행 기록 시험 (lib/runs.js)
 *   - 키가 없으면 아무것도 하지 않고 false (네트워크를 부르지 않음)
 *   - 키가 있으면 agent_runs 에 숫자만 넣는다 (fetch 를 가짜로 바꿔 확인)
 *   - 실패해도 예외를 던지지 않는다
 *   node test/runs.js
 */
const assert = require("assert");
const KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"];
const saved = {};
KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
const { logRun } = require("../lib/runs");
const realFetch = global.fetch;

let fail = 0;
async function test(name, fn) {
  try { await fn(); console.log("통과  " + name); } catch (e) { fail++; console.log("실패  " + name + "\n      " + (e && e.stack || e)); }
  global.fetch = realFetch;
  KEYS.forEach((k) => { delete process.env[k]; });
}

(async () => {
  await test("키 없음 → false, 네트워크 안 부름", async () => {
    let called = 0;
    global.fetch = async () => { called++; return { ok: true, text: async () => "" }; };
    assert.strictEqual(await logRun({ bill_no: "2206436", mode: "agent", steps: 5, tokens: 1200 }), false);
    assert.strictEqual(called, 0);
  });

  await test("anon 키만 있으면 기록하지 않음 (agent_runs 는 서비스 키로만 넣음)", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-test";
    let called = 0;
    global.fetch = async () => { called++; return { ok: true, text: async () => "" }; };
    assert.strictEqual(await logRun({ bill_no: "2206436", steps: 1, tokens: 1 }), false);
    assert.strictEqual(called, 0);
  });

  await test("잘못된 의안번호 → false", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-test";
    assert.strictEqual(await logRun({ bill_no: "abc", steps: 1, tokens: 1 }), false);
    assert.strictEqual(await logRun(), false);
  });

  await test("키 있음 → agent_runs 에 숫자만 넣음", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co/";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-test";
    let seen = null;
    global.fetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 201, text: async () => "" }; };
    assert.strictEqual(await logRun({ bill_no: "2206436", mode: "agent", steps: 4.6, tokens: -3, email: "x@y.z" }), true);
    assert.strictEqual(seen.url, "https://example.supabase.co/rest/v1/agent_runs");
    assert.deepStrictEqual(JSON.parse(seen.init.body), { bill_no: "2206436", mode: "agent", steps: 5, tokens: 0 });
    assert.strictEqual(seen.init.headers.Prefer, "return=minimal");
  });

  await test("네트워크 실패·서버 오류 → false, 예외 없음", async () => {
    process.env.SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-test";
    global.fetch = async () => { throw new Error("ECONNRESET"); };
    assert.strictEqual(await logRun({ bill_no: "2206436", steps: 1, tokens: 1 }), false);
    global.fetch = async () => ({ ok: false, status: 401, text: async () => "{}" });
    assert.strictEqual(await logRun({ bill_no: "2206436", steps: 1, tokens: 1 }), false);
  });

  KEYS.forEach((k) => { if (saved[k] !== undefined) process.env[k] = saved[k]; });
  if (fail) { console.log(fail + "건 실패"); process.exit(1); }
  console.log("실행 기록 시험 모두 통과");
})();
