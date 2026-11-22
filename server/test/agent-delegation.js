/*
 * 위임만 남는 경우의 에이전트 판정 시험 (가짜 모델, 네트워크 없음)
 *   node test/agent-delegation.js
 *
 * 2220302 는 요약에서 원문 대조를 통과하는 기준이 "위임" 하나뿐인 법안이다.
 *   - 시범 규칙이 없으면: 판정 보류로 끝나고 judge_buildings 를 부르지 않음, 초안에 "시행령 입법예고 확인"
 *   - 시범 규칙이 있으면(시험용으로 하나 붙임): 시범 규칙으로 판정, 단계 기록에 "추출 기준이 위임뿐이라 시범 규칙 사용"
 *   - 어느 경우든 2,448동 전부 판정불가 같은 결과가 나오지 않음
 * 모델이 위임만 든 규칙으로 judge_buildings 를 부르면 도구가 판정하지 않고 "판정할 기준이 없음"을 돌려줌.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "web", "data");
const NO = "2220302";
const NO_DEMO = "2211980";

// 시험용 데이터 폴더: 원본을 복사하고 2220302 에만 시범 규칙을 하나 붙인다
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppaegok-deleg-"));
["bills.json", "crosscheck.json", "buildings.geojson"].forEach((f) => fs.copyFileSync(path.join(SRC, f), path.join(dir, f)));
const demoData = JSON.parse(fs.readFileSync(path.join(SRC, "demo_rules.json"), "utf8"));
assert.ok(!demoData.demos.some((d) => d.bill_no === NO || d.bill_no === NO_DEMO), "시험 법안은 원래 시범 규칙이 없어야 함");
demoData.demos.push({
  bill_no: NO, title: "시험용 시범 규칙", source_text: "(시험)", rule: { 층수: { min: 3 } }, rule_note: "", conclusion: "",
  method: "시험", counts: { 대상: 0, 경계선: 0, 비대상: 0, 판정불가: 0 },
});
fs.writeFileSync(path.join(dir, "demo_rules.json"), JSON.stringify(demoData));

process.env.AGENT_MOCK = "1";
process.env.DATA_DIR = dir;
delete process.env.VERCEL;
delete process.env.AGENT_MOCK_SCRIPT;

const Criteria = require("../lib/criteria");
const Judge = require("../lib/judge");
const handler = require("../api/agent");
const bills = require(path.join(dir, "bills.json")).bills;
const props = JSON.parse(fs.readFileSync(path.join(dir, "buildings.geojson"), "utf8")).features.map((f) => f.properties);

let ip = 0;
function call(body) {
  return new Promise((resolve) => {
    const req = { method: "POST", body, headers: { origin: "http://localhost:8000", "x-forwarded-for": "10.9.0." + (++ip) } };
    const res = {
      code: 200, setHeader() {}, status(c) { this.code = c; return this; },
      json(j) { resolve({ code: this.code, body: j }); }, end() { resolve({ code: this.code, body: null }); },
    };
    handler(req, res);
  });
}
const allUndecided = (c) => c && c["판정불가"] === props.length;

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("시험 법안은 원문 대조 통과 기준이 위임뿐", async () => {
  [NO, NO_DEMO].forEach((no) => {
    const r = Criteria.extract(bills.find((b) => b.no === no).summary).rule;
    assert.deepStrictEqual(Object.keys(r), ["위임"], no + " " + JSON.stringify(r));
  });
});

test("시범 규칙 없음 + 위임뿐: 판정 보류, judge_buildings 안 부름, 초안에 시행령 입법예고 확인", async () => {
  const r = await call({ bill: NO_DEMO });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  const j = r.body;
  assert.ok(!j.steps.some((s) => s.tool === "judge_buildings"), j.steps.map((s) => s.tool).join(","));
  assert.strictEqual(j.counts, null);
  assert.ok(/판정 보류: 시행령\(대통령령 등\)에 위임돼 기준 확정 전/.test(j.hold), j.hold);
  const ex = j.steps.find((s) => s.tool === "extract_criteria");
  assert.ok(/판정 보류/.test(ex.summary), ex.summary);
  assert.ok(/시행령 입법예고 확인/.test(j.draft), j.draft);
});

test("시범 규칙 있음 + 위임뿐: 시범 규칙으로 판정, 단계 기록에 사유, 화면 판정과 같음", async () => {
  const r = await call({ bill: NO });
  assert.strictEqual(r.code, 200, JSON.stringify(r.body));
  const j = r.body;
  const ex = j.steps.find((s) => s.tool === "extract_criteria");
  assert.ok(/추출 기준이 위임뿐이라 시범 규칙 사용/.test(ex.summary), ex.summary);
  assert.strictEqual(j.rule_source, "판정 시범 규칙");
  assert.deepStrictEqual(j.rule, { 층수: { min: 3 } });
  assert.deepStrictEqual(j.counts, Judge.countAll(props, { 층수: { min: 3 } }).counts);
  assert.ok(!allUndecided(j.counts));
  assert.strictEqual(j.hold, null);
});

test("모델이 위임만 든 규칙으로 judge_buildings 를 부르면 판정하지 않고 '판정할 기준이 없음'", async () => {
  process.env.AGENT_MOCK_SCRIPT = "nosplit";
  const r = await call({ bill: NO_DEMO, note: "위임 규칙 시험" }); // note 를 바꿔 캐시를 피함
  delete process.env.AGENT_MOCK_SCRIPT;
  const j = r.body;
  const js = j.steps.filter((s) => s.tool === "judge_buildings");
  assert.ok(js.length >= 1, j.steps.map((s) => s.tool).join(","));
  assert.ok(/판정할 기준이 없음/.test(js[0].summary), js[0].summary);
  assert.strictEqual(js[0].ok, false);
  assert.strictEqual(j.counts, null);
  assert.ok(j.hold);
});

test("위임만 든 규칙 호출 뒤 시범 규칙이 있으면 다음 호출에서 시범 규칙으로 판정 (2,448동 판정불가 없음)", async () => {
  process.env.AGENT_MOCK_SCRIPT = "nosplit";
  const r = await call({ bill: NO, note: "다시" }); // note 를 바꿔 캐시를 피함
  delete process.env.AGENT_MOCK_SCRIPT;
  const j = r.body;
  const js = j.steps.filter((s) => s.tool === "judge_buildings");
  assert.ok(/판정할 기준이 없음/.test(js[0].summary), js[0].summary);
  assert.ok(j.counts && !allUndecided(j.counts), JSON.stringify(j.counts));
  assert.strictEqual(j.rule_source, "판정 시범 규칙");
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("통과  " + name); } catch (e) { fail++; console.log("실패  " + name + "\n      " + e.message); }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fail ? "실패 " + fail + "개" : "모두 통과 (" + tests.length + "개)");
  process.exit(fail ? 1 : 0);
})();
