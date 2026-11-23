/*
 * 세대수 기준 뽑기와 원문 대조 (lib/criteria.js, lib/sources.js)
 *   - "30세대 이상 공동주택" → 세대수 min 30 (+ 용도 공동주택)
 *   - 근거 문구에 없는 수치, 단위가 "세대" 가 아닌 수치는 버림
 *   - 개정문(의안 원문)에서는 고친 뒤 글만, 같은 기준 수치가 여럿이면 버림
 *   - 위임 문구로 세대수를 넘긴 것은 "위임 확인"
 *   node test/household.js
 */
const assert = require("assert");
const Criteria = require("../lib/criteria");
const S = require("../lib/sources");

let n = 0;
function test(name, fn) { fn(); n++; console.log("통과  " + name); }

const T = "품질점검단의 점검대상을 30세대 이상 공동주택으로 확대하는 한편, 점검 결과를 공개하도록 함.";

test("30세대 이상 공동주택: 정규식이 세대수 min 30 과 용도 공동주택을 뽑고 대조 통과", () => {
  const r = Criteria.extract(T);
  assert.deepStrictEqual(r.rule.세대수, { min: 30 });
  assert.deepStrictEqual(r.rule.용도, ["02000"]);
  assert.ok(r.evidence.some((e) => e.attr === "세대수" && T.includes(e.quote)));
  assert.strictEqual(Criteria.ruleTexts(r.rule).세대수, "30세대 이상");
});

test("AI 후보: 문자열 수치·1천세대 표기도 받음", () => {
  const v = Criteria.verify([{ attr: "세대수", bound: "min", value: "30", quote: "30세대 이상 공동주택" }], T);
  assert.deepStrictEqual(v.rule.세대수, { min: 30 });
  const s = "1천세대 이상의 정비계획의 경우 녹지를 더 확보함.";
  const w = Criteria.verify([{ attr: "세대수", bound: "min", value: 1000, quote: s }], s);
  assert.deepStrictEqual(w.rule.세대수, { min: 1000 });
});

test("근거 문구에 없는 수치는 버림", () => {
  const v = Criteria.verify([{ attr: "세대수", bound: "min", value: 50, quote: "30세대 이상 공동주택" }], T);
  assert.strictEqual(v.rule.세대수, undefined);
  assert.ok(/수치 50 가 근거 문구에 없음/.test(v.dropped[0].why), JSON.stringify(v.dropped));
});

test("단위가 세대가 아니면 버림 (30층, 30명)", () => {
  const s = "30층 이상인 공동주택에는 관리인 30명 이상을 두도록 함.";
  const v = Criteria.verify([{ attr: "세대수", bound: "min", value: 30, quote: s }], s);
  assert.strictEqual(v.rule.세대수, undefined);
  assert.strictEqual(v.dropped[0].why, Criteria.NOT_IN_QUOTE + " (30세대)");
  // 세대 앞 숫자가 다른 수의 일부(130세대)여도 버림
  const s2 = "130세대 이상 공동주택에 적용함.";
  const w = Criteria.verify([{ attr: "세대수", bound: "min", value: 30, quote: s2 }], s2);
  assert.strictEqual(w.rule.세대수, undefined);
});

test("경계 낱말이 바로 붙지 않은 1세대 1주택·1세대당 은 뽑지 않음", () => {
  const s = "양도소득세 1세대 1주택 비과세 판단과 1세대당 2제곱미터 이상의 녹지 확보 기준을 정비함.";
  assert.ok(!Criteria.extractCandidates(s).some((c) => c.attr === "세대수"));
});

test("개정문: 고친 뒤 글(B)의 세대수만, 같은 기준 수치가 여럿이면 버림", () => {
  const doc = "주택법 일부개정법률안 주택법 일부를 다음과 같이 개정한다. 제48조의2제1항 중 “300세대 이상”을 “30세대 이상”으로 한다. 부 칙 이 법은 공포한 날부터 시행한다.";
  const r = Criteria.extractFromDoc(doc);
  assert.deepStrictEqual(r.rule.세대수, { min: 30 });
  const amb = "주택법 일부를 다음과 같이 개정한다. 제48조의2제1항을 다음과 같이 한다. ① 다음 각 호의 어느 하나에 해당하는 공동주택: 1. 30세대 이상 공동주택 2. 100세대 이상 공동주택. 부 칙 이 법은 공포한 날부터 시행한다.";
  const a = Criteria.extractFromDoc(amb);
  assert.strictEqual(a.rule.세대수, undefined);
  assert.ok(a.dropped.some((d) => d.attr === "세대수"), JSON.stringify(a.dropped));
});

test("근거 평가: 세대수 통과는 판정에 충분, 위임 문구로 넘긴 세대수는 위임 확인", () => {
  const e = S.evaluateSource("summary", T, Criteria.extractCandidates(T));
  assert.strictEqual(e.items.세대수.status, S.ST_OK);
  const d = "의무관리 대상은 대통령령으로 정하는 세대수 이상의 공동주택으로 함.";
  const f = S.evaluateSource("summary", d, Criteria.extractCandidates(d));
  assert.strictEqual(f.items.세대수.status, S.ST_DELEG, JSON.stringify(f.items));
});

console.log("모두 통과 (" + n + "개)");
