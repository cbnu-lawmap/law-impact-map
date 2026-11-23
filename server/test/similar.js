/*
 * 비슷한 법안 시험 (lib/similar.js, api/similar.js, lib/tfidf.js)
 *   - Supabase 키가 없거나, 네트워크가 실패하거나, 응답이 이상하면 similarByVector 는 null
 *   - 그때 api/similar 는 TF-IDF 로 대신하고 method 로 알려 준다
 *   - 키가 있고 rpc 가 답하면 pgvector 결과를 쓴다 (fetch 를 가짜로 바꿔 확인, 실제 네트워크 없음)
 *   node test/similar.js
 */
const assert = require("assert");
const path = require("path");

process.env.DATA_DIR = path.join(__dirname, "..", "..", "web", "data");
const KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"];
const saved = {};
KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });

const Tfidf = require("../lib/tfidf");
const sim = require("../lib/similar");
const handler = require("../api/similar");
const realFetch = global.fetch;

let fail = 0;
async function test(name, fn) {
  try { await fn(); console.log("통과  " + name); } catch (e) { fail++; console.log("실패  " + name + "\n      " + (e && e.stack || e)); }
  global.fetch = realFetch;
  KEYS.forEach((k) => { delete process.env[k]; });
}
function call(url) {
  return new Promise((resolve) => {
    const req = { method: "GET", url, headers: { origin: "https://cbnu-lawmap.github.io", "x-forwarded-for": "127.0.0.1" } };
    const res = {
      headers: {}, statusCode: 200,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(j) { resolve({ status: this.statusCode, body: j, headers: this.headers }); },
      end() { resolve({ status: this.statusCode, body: null, headers: this.headers }); },
    };
    handler(req, res);
  });
}
const useKeys = () => { process.env.SUPABASE_URL = "https://example.supabase.co"; process.env.SUPABASE_SERVICE_ROLE_KEY = "test-not-a-key"; };

(async () => {
  const bills = require(path.join(process.env.DATA_DIR, "bills.json")).bills;
  const a = bills[0].no;

  await test("법률명 뽑기", () => {
    assert.strictEqual(Tfidf.lawOf("건축법 일부개정법률안"), "건축법");
    assert.strictEqual(Tfidf.lawOf("건축법 일부개정법률안(대안)"), "건축법");
    assert.strictEqual(Tfidf.lawOf("재건축초과이익 환수에 관한 법률폐지법률안"), "재건축초과이익 환수에 관한 법률");
    assert.strictEqual(Tfidf.lawOf("고령자돌봄주택 특별법안"), "고령자돌봄주택 특별법");
  });

  await test("TF-IDF: 같은 글은 유사도 1, 자기 자신은 이웃에서 빠짐", () => {
    const idx = Tfidf.buildIndex([{ no: "1", text: "건축물 화재 안전" }, { no: "2", text: "건축물 화재 안전" }, { no: "3", text: "주택 임대차 보호" }]);
    const nb = Tfidf.neighbors(idx, "1", 2);
    assert.strictEqual(nb[0].no, "2");
    assert.ok(Math.abs(nb[0].score - 1) < 1e-9, nb[0].score);
    assert.ok(nb.every((x) => x.no !== "1"));
  });

  await test("키 없음 → similarByVector 는 null (네트워크를 부르지 않음)", async () => {
    let called = 0;
    global.fetch = async () => { called++; throw new Error("불리면 안 됨"); };
    assert.strictEqual(await sim.similarByVector(a, 5), null);
    assert.strictEqual(called, 0);
  });

  await test("네트워크 실패 → null", async () => {
    useKeys();
    global.fetch = async () => { throw new Error("ECONNREFUSED"); };
    assert.strictEqual(await sim.similarByVector(a, 5), null);
  });

  await test("서버 오류(500)·빈 결과·이상한 응답 → null", async () => {
    useKeys();
    global.fetch = async () => ({ ok: false, status: 500, text: async () => "{}" });
    assert.strictEqual(await sim.similarByVector(a, 5), null);
    global.fetch = async () => ({ ok: true, status: 200, text: async () => "[]" });
    assert.strictEqual(await sim.similarByVector(a, 5), null);
    global.fetch = async () => ({ ok: true, status: 200, text: async () => "<html>" });
    assert.strictEqual(await sim.similarByVector(a, 5), null);
  });

  await test("rpc 응답 → pgvector 결과, 키는 헤더로만 보냄", async () => {
    useKeys();
    let seen = null;
    global.fetch = async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, text: async () => JSON.stringify([{ bill_no: bills[1].no, law: "건축법", similarity: 0.91 }]) };
    };
    const r = await sim.similarByVector(a, 3);
    assert.deepStrictEqual(r, [{ no: bills[1].no, law: "건축법", score: 0.91 }]);
    assert.strictEqual(seen.url, "https://example.supabase.co/rest/v1/rpc/similar_bills");
    assert.deepStrictEqual(JSON.parse(seen.init.body), { p_bill_no: a, k: 3 });
    assert.strictEqual(seen.init.headers.apikey, "test-not-a-key");
  });

  await test("API: 키 없음 → TF-IDF 로 대신하고 method 를 알려 줌", async () => {
    const r = await call("/api/similar?no=" + a + "&k=3");
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.method, "tfidf");
    assert.strictEqual(r.body.label, "단어 유사도(TF-IDF)");
    assert.strictEqual(r.body.items.length, 3);
    assert.ok(r.body.items.every((x) => x.no !== a && x.name && typeof x.score === "number"));
  });

  await test("API: pgvector 가 실패해도 TF-IDF 결과", async () => {
    useKeys();
    global.fetch = async () => { throw new Error("timeout"); };
    const r = await call("/api/similar?no=" + a);
    assert.strictEqual(r.body.method, "tfidf");
    assert.strictEqual(r.body.items.length, 5);
  });

  await test("API: pgvector 가 답하면 그 결과 (목록에 없는 번호는 뺌)", async () => {
    useKeys();
    global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([
      { bill_no: "9999999", law: "", similarity: 0.99 },
      { bill_no: bills[2].no, law: "", similarity: 0.8 },
    ]) });
    const r = await call("/api/similar?no=" + a + "&k=2");
    assert.strictEqual(r.body.method, "pgvector");
    assert.strictEqual(r.body.label, "의미 검색(pgvector)");
    assert.deepStrictEqual(r.body.items.map((x) => x.no), [bills[2].no]);
  });

  await test("API: judged=1 이면 판정한 법안만", async () => {
    const demos = require(path.join(process.env.DATA_DIR, "demo_rules.json")).demos.map((d) => d.bill_no);
    const r = await call("/api/similar?no=" + a + "&k=3&judged=1");
    assert.ok(r.body.items.length > 0 && r.body.items.every((x) => x.judged && demos.includes(x.no)), JSON.stringify(r.body.items));
  });

  await test("API: 잘못된 번호는 400, 없는 번호는 404", async () => {
    assert.strictEqual((await call("/api/similar?no=abc")).status, 400);
    assert.strictEqual((await call("/api/similar?no=0000000")).status, 404);
  });

  KEYS.forEach((k) => { if (saved[k] !== undefined) process.env[k] = saved[k]; });
  if (fail) { console.log(fail + "건 실패"); process.exit(1); }
  console.log("비슷한 법안 시험 모두 통과");
})();
