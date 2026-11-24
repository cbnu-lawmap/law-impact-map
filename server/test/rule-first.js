// 규칙 우선 합치기 시험: 정규식이 원문 대조를 통과한 속성은 AI 후보로 덮지 않고, 빈 속성만 AI 로 채운다
const assert = require("assert");
const C = require("../lib/criteria");
const text = "개정안은 연면적 200제곱미터 미만이고 2층 이하인 건축물의 해체를 신고로 간소화하려는 것임.";
const regex = C.extractCandidates(text);
const have = new Set(C.verify(regex, text).evidence.map((e) => e.attr));
assert.ok(have.has("연면적"), "정규식이 연면적을 찾아야 함");

// 1) AI 가 연면적을 다르게 내도 정규식 값을 유지
const ai1 = [{ attr: "연면적", bound: "max", value: 300, quote: "연면적 200제곱미터 미만" }];
const m1 = C.preferRule(regex, ai1, text);
assert.strictEqual(m1.added, 0);
assert.strictEqual(C.verify(m1.cands, text).rule.연면적.max, C.verify(regex, text).rule.연면적.max);

// 2) 정규식이 없는 속성은 AI 후보로 채움
const ai2 = [{ attr: "세대수", bound: "min", value: 30, quote: "30세대" }];
const m2 = C.preferRule(regex, ai2, text);
assert.strictEqual(m2.added, 1);

// 3) AI 결과가 비었거나 배열이 아니면 정규식 그대로
assert.strictEqual(C.preferRule(regex, null, text).cands, regex);
assert.strictEqual(C.preferRule(regex, [], text).added, 0);
console.log("규칙 우선 합치기 시험 모두 통과");
