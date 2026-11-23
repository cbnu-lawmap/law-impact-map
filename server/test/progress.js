/*
 * 검토 진행 저장 시험 (api/progress.js). fetch 를 가짜로 바꿔 Supabase 에 보내는 rpc 본문을 확인한다.
 *   - 허용하지 않은 사이트 거절, IP당 호출 수 제한
 *   - 이름·메모·사유 길이, 의안번호 형식·존재, 개인정보 모양 거절
 *   - 담당자는 승인·반려 못 함, 결재자는 상태·메모 못 바꿈
 *   - 맞는 호출은 progress_set / progress_decide 에 맞는 본문을 보냄
 *   node test/progress.js
 */
const assert = require("assert");
const path = require("path");
const KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "DATA_DIR"];
const saved = {};
KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
process.env.DATA_DIR = path.join(__dirname, "..", "..", "web", "data");
const handler = require("../api/progress");
const realFetch = global.fetch;

const BILL = String(require(path.join(process.env.DATA_DIR, "bills.json")).bills[0].no);
const OK_ORIGIN = "https://cbnu-lawmap.github.io";
let ipN = 0;

function call(body, opts) {
  opts = opts || {};
  const req = {
    method: opts.method || "POST",
    headers: { origin: opts.origin === undefined ? OK_ORIGIN : opts.origin, "x-forwarded-for": opts.ip || "10.0.0." + (++ipN) },
    body,
  };
  return new Promise((resolve) => {
    const res = {
      headers: {}, code: 200,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(j) { resolve({ code: this.code, json: j, headers: this.headers }); },
      end() { resolve({ code: this.code, json: null, headers: this.headers }); },
    };
    handler(req, res);
  });
}

let calls = [];
function fakeDb(reply) {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc-test";
  calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = reply ? reply(url, JSON.parse(init.body)) : { status: 200, json: { bill_no: JSON.parse(init.body).p_bill_no } };
    return { ok: r.status < 300, status: r.status, text: async () => JSON.stringify(r.json) };
  };
}

let fail = 0;
async function test(name, fn) {
  try { await fn(); console.log("통과  " + name); } catch (e) { fail++; console.log("실패  " + name + "\n      " + (e && e.stack || e)); }
  global.fetch = realFetch;
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
}

const SET = (o) => Object.assign({ action: "set", role: "담당자", name: "김담당", bill: BILL, status: "doing", memo: "시행령 나오면 다시 확인" }, o);
const DECIDE = (o) => Object.assign({ action: "decide", role: "결재자", name: "박결재", bill: BILL, decision: "승인" }, o);

(async () => {
  await test("허용하지 않은 사이트 → 403, DB 안 부름", async () => {
    fakeDb();
    const r = await call(SET(), { origin: "https://evil.example" });
    assert.strictEqual(r.code, 403);
    const r2 = await call(SET(), { origin: "" });
    assert.strictEqual(r2.code, 403);
    assert.strictEqual(calls.length, 0);
  });

  await test("같은 IP 1분 30회 넘으면 429", async () => {
    fakeDb();
    let last = null;
    for (let i = 0; i < 31; i++) last = await call(SET(), { ip: "10.9.9.9" });
    assert.strictEqual(last.code, 429);
    assert.strictEqual(calls.length, 30);
  });

  await test("GET 은 서버 키 유무만", async () => {
    let r = await call(null, { method: "GET" });
    assert.deepStrictEqual(r.json, { ok: false });
    fakeDb();
    r = await call(null, { method: "GET" });
    assert.deepStrictEqual(r.json, { ok: true });
    assert.strictEqual(calls.length, 0);
  });

  await test("길이 제한: 이름 20자, 메모 300자, 반려 사유 100자, 의안번호 7자리·실재", async () => {
    fakeDb();
    assert.strictEqual((await call(SET({ name: "가".repeat(21) }))).code, 400);
    assert.strictEqual((await call(SET({ name: "   " }))).code, 400);
    assert.strictEqual((await call(SET({ memo: "가".repeat(301) }))).code, 400);
    assert.strictEqual((await call(DECIDE({ decision: "반려", reason: "가".repeat(101) }))).code, 400);
    assert.strictEqual((await call(SET({ bill: "12345" }))).code, 400);
    assert.strictEqual((await call(SET({ bill: "0000000" }))).code, 404);
    assert.strictEqual((await call(SET({ status: "approved" }))).code, 400);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual((await call(SET({ name: "가".repeat(20), memo: "가".repeat(300) }))).code, 200);
    assert.strictEqual(calls.length, 1);
  });

  await test("개인정보 모양(주민번호·전화번호·이메일) 거절", async () => {
    fakeDb();
    for (const memo of ["9001011234567 확인", "연락 010-1234-5678", "a.b@example.go.kr 로 보냄"]) {
      const r = await call(SET({ memo }));
      assert.strictEqual(r.code, 400, memo);
    }
    assert.strictEqual((await call(SET({ name: "010-1234-5678" }))).code, 400);
    assert.strictEqual((await call(DECIDE({ decision: "반려", reason: "x@y.kr 에 문의" }))).code, 400);
    assert.strictEqual(calls.length, 0);
  });

  await test("담당자는 승인·반려 못 함, 결재자는 상태·메모 못 바꿈", async () => {
    fakeDb();
    const a = await call(DECIDE({ role: "담당자" }));
    assert.strictEqual(a.code, 403);
    const b = await call(SET({ role: "결재자" }));
    assert.strictEqual(b.code, 403);
    const c = await call(SET({ role: "관리자" }));
    assert.strictEqual(c.code, 400);
    assert.strictEqual(calls.length, 0);
  });

  await test("담당자 저장 → rpc progress_set 본문", async () => {
    fakeDb();
    const r = await call(SET({ name: "  김담당 ", memo: " 메모 " }));
    assert.strictEqual(r.code, 200);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, "https://example.supabase.co/rest/v1/rpc/progress_set");
    assert.deepStrictEqual(calls[0].body, { p_bill_no: BILL, p_status: "doing", p_memo: "메모", p_actor: "김담당" });
    assert.strictEqual(calls[0].init.headers.Authorization, "Bearer svc-test");
    assert.deepStrictEqual(r.json, { ok: true, row: { bill_no: BILL } });
  });

  await test("결재자 승인·반려 → rpc progress_decide 본문 (승인은 사유를 보내지 않음)", async () => {
    fakeDb();
    assert.strictEqual((await call(DECIDE({ reason: "무시됨" }))).code, 200);
    assert.strictEqual(calls[0].url, "https://example.supabase.co/rest/v1/rpc/progress_decide");
    assert.deepStrictEqual(calls[0].body, { p_bill_no: BILL, p_decision: "승인", p_reason: null, p_actor: "박결재" });
    assert.strictEqual((await call(DECIDE({ decision: "반려", reason: "용도 기준 다시 확인" }))).code, 200);
    assert.deepStrictEqual(calls[1].body, { p_bill_no: BILL, p_decision: "반려", p_reason: "용도 기준 다시 확인", p_actor: "박결재" });
    assert.strictEqual((await call(DECIDE({ decision: "보류" }))).code, 400);
  });

  await test("여러 건 저장: 맞는 것만 저장, 틀린 것은 failed, 50건 넘으면 거절", async () => {
    fakeDb();
    const r = await call(SET({ bill: undefined, items: [{ bill: BILL, status: "done", memo: "" }, { bill: "12", status: "done" }, { bill: BILL, status: "done", memo: "010-1234-5678" }] }));
    assert.strictEqual(r.code, 200);
    assert.strictEqual(r.json.saved, 1);
    assert.strictEqual(r.json.failed.length, 2);
    assert.strictEqual(calls.length, 1);
    const many = Array.from({ length: 51 }, () => ({ bill: BILL, status: "done" }));
    assert.strictEqual((await call(SET({ items: many }))).code, 400);
  });

  await test("DB 가 거절하면 그 이유, 키 없으면 503, 연결 실패면 502", async () => {
    fakeDb(() => ({ status: 400, json: { code: "P0001", message: "검토 완료된 법안만 결재할 수 있습니다" } }));
    let r = await call(DECIDE());
    assert.strictEqual(r.code, 400);
    assert.strictEqual(r.json.error, "검토 완료된 법안만 결재할 수 있습니다");
    global.fetch = async () => { throw new Error("ECONNRESET"); };
    r = await call(SET());
    assert.strictEqual(r.code, 502);
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    r = await call(SET());
    assert.strictEqual(r.code, 503);
  });

  KEYS.forEach((k) => { delete process.env[k]; if (saved[k] !== undefined) process.env[k] = saved[k]; });
  if (fail) { console.log(fail + "건 실패"); process.exit(1); }
  console.log("진행 저장 시험 모두 통과");
})();
