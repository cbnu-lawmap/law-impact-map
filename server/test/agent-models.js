/*
 * 직접 학습한 모델 도구 시험 (가짜 모델로 에이전트 흐름, 분류 모델은 실제 내보낸 가중치)
 *   node test/agent-models.js
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.AGENT_MOCK = "1";
process.env.DATA_DIR = path.join(__dirname, "..", "..", "web", "data");
process.env.AGENT_MOCK_SCRIPT = "models";
delete process.env.VERCEL;

const handler = require("../api/agent");
const { loadModel } = require("../lib/nn");
const bills = require(path.join(process.env.DATA_DIR, "bills.json")).bills;

let ip = 0;
function call(body) {
  return new Promise((resolve) => {
    const req = { method: "POST", body, headers: { origin: "http://localhost:8000", "x-forwarded-for": "10.8.0." + (++ip) } };
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(j) { resolve({ code: this.code, body: j }); }, end() { resolve({ code: this.code }); } };
    handler(req, res);
  });
}

const tests = [];
const test = (n, f) => tests.push([n, f]);
const fieldPath = path.join(process.env.DATA_DIR, "models", "field_classifier.json");
const passPath = path.join(process.env.DATA_DIR, "models", "pass_prediction.json");

test("classify_field: 내보낸 분야 모델(검증 성적이 높은 쪽)로 분야 확률 상위 3개, 목록 분야와 비교", async () => {
  assert.ok(fs.existsSync(fieldPath), "models/field_classifier.json 없음");
  const r = await call({ bill: "2206436" });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  const st = r.body.steps.find((s) => s.tool === "classify_field");
  assert.ok(st && st.ok, JSON.stringify(st));
  const fm = r.body.field_model;
  assert.strictEqual(fm.top.length, 3);
  assert.ok(fm.top[0].p >= fm.top[1].p && fm.top[1].p >= fm.top[2].p);
  // 서버가 계산한 1위가 같은 가중치로 직접 계산한 1위와 같음
  const M = loadModel(JSON.parse(fs.readFileSync(fieldPath, "utf8")));
  const b = bills.find((x) => x.no === "2206436");
  const p = M.predict(String(b.summary).replace(/^\s*제안이유\s*(및\s*주요내용)?/, "").replace(/\s+/g, " ").trim());
  assert.strictEqual(fm.top[0].field, M.labels[p.indexOf(Math.max(...p))]);
  assert.ok(/모델 시험 정확도/.test(st.summary), st.summary);
});

test("predict_pass: 모델 결과가 있으면 확률과 성능, 없으면 '모델 없음'으로 다음 단계 진행", async () => {
  const r = await call({ bill: "2206436", note: "통과 예측" });
  const st = r.body.steps.find((s) => s.tool === "predict_pass");
  assert.ok(st, "predict_pass 단계 없음");
  const b = bills.find((x) => x.no === "2206436");
  if (fs.existsSync(passPath) && b.pass_prob != null) {
    assert.ok(st.ok && /모델 추정/.test(st.summary), st.summary);
    assert.strictEqual(r.body.pass_model.p, b.pass_prob);
    // 3단계 구간이 있으면 구간 이름과 그 구간의 실제 반영률을 함께 보여 준다 (경계는 [min, max))
    const tiers = JSON.parse(fs.readFileSync(passPath, "utf8")).tiers || [];
    if (tiers.length) {
      const want = tiers.find((t) => b.pass_prob < t.max) || tiers[tiers.length - 1];
      // 화면과 같은 이름 (가장 높은 구간은 "상대적으로 높음")과 "비슷한 과거 법안 반영률"
      const label = { 낮음: "낮음", 보통: "보통", 높음: "상대적으로 높음" }[want.name] || want.name;
      assert.strictEqual(r.body.pass_model.tier.name, label);
      assert.ok(st.summary.indexOf("통과 가능성 " + label) === 0 && /비슷한 과거 법안 반영률 \d+%/.test(st.summary), st.summary);
      assert.ok(st.auto && /자동 계산/.test(st.why), "predict_pass 는 자동 계산 단계여야 함");
    }
  } else {
    assert.strictEqual(st.ok, false);
    assert.ok(/아직 없습니다|예측이 없습니다/.test(st.summary), st.summary);
  }
  // 모델 도구 결과와 상관없이 판정은 그대로 (같은 법안 판정 시범 동수와 같음. 건물 자료를 다시 만들면 동수도 바뀌므로 파일에서 읽는다)
  const demo = require(path.join(process.env.DATA_DIR, "demo_rules.json")).demos.find((d) => d.bill_no === "2206436");
  assert.deepStrictEqual(r.body.counts, demo.counts);
});

(async () => {
  let fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("통과  " + n); } catch (e) { fail++; console.log("실패  " + n + "\n      " + e.message); }
  }
  console.log(fail ? "실패 " + fail + "개" : "모두 통과 (" + tests.length + "개)");
  process.exit(fail ? 1 : 0);
})();
