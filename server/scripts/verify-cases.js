/*
 * 원문 대조(lib/criteria.js 의 verify) 시험 사례를 data/verify_cases.json 으로 내보낸다.
 * notebooks/local_llm_extraction.ipynb 가 파이썬으로 옮긴 verify 를 이 사례로 맞춰 본다 (같은 입력 → 같은 결과).
 * 에이전트의 기준 뽑기 지시문(extract_prompt)도 함께 넣어, 노트북이 서버와 똑같은 지시문을 쓰게 한다.
 *   node scripts/verify-cases.js          다시 만들기
 *   node scripts/verify-cases.js --check  파일이 지금 verify 결과와 같은지 확인 (npm test)
 */
const fs = require("fs");
const path = require("path");
const Criteria = require("../lib/criteria");
const { EXTRACT_PROMPT } = require("../api/agent")._test;

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(ROOT, "data", "verify_cases.json");
const demos = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "data", "demo_rules.json"), "utf8")).demos;
const full = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "data", "summaries.json"), "utf8")).summaries;

const cases = [];
function add(name, text, candidates) {
  // 노트북의 파이썬 verify 는 기본 대조(문구·수치·단위)만 옮겼다. 현행·개정 문장 나누기(sentences)는 서버에서만 더 거른다
  const { rule, evidence, dropped } = Criteria.verify(candidates, text, { sentences: false });
  cases.push({ name, text, candidates, expected: { rule, evidence, dropped } });
}

// test/*.js 에 있는 사례
const S1 = "현행법은 연면적 300제곱미터 이상인 건축물에 적용함.";
add("수치·문구 불일치", S1, [
  { attr: "연면적", bound: "min", value: 300, quote: "연면적 300제곱미터 이상" },
  { attr: "연면적", bound: "max", value: 500, quote: "연면적 300제곱미터 이상" },
  { attr: "층수", bound: "min", value: 3, quote: "3층 이상인 건축물" },
]);
const S2 = "연면적이 10만제곱미터 이상인 물류터미널에도 강화된 소방시설 기준을 적용함.";
add("하위 시설 이름(물류터미널) → 창고시설", S2, [{ attr: "용도", value: ["18000"], quote: S2 }, { attr: "용도", value: ["08000"], quote: S2 },
  { attr: "연면적", bound: "min", value: "100,000", quote: S2 }, { attr: "연면적", bound: "min", value: 100000, quote: S2 }]);
const S3 = "건축물 3개 동 이상과 연면적 500 이상인 경우 적용함.";
add("숫자·단위가 근거에 없음", S3, [{ attr: "층수", bound: "min", value: 3, quote: S3 }, { attr: "연면적", bound: "min", value: 500, quote: S3 }]);
const S4 = "현행법은 해체 신고 대상 건축물 전부에 대해 전문가가 해체계획서를 검토하여 서명 날인하도록 함. 이에 대통령령으로 정하는 규모 이하의 건축물은 검토를 생략함.";
const noPhrase = "현행법은 해체 신고 대상 건축물 전부에 대해 전문가가 해체계획서를 검토하여 서명 날인하도록 함.";
const withPhrase = "이에 대통령령으로 정하는 규모 이하의 건축물은 검토를 생략함.";
add("위임 문구·값 길이", S4, [
  { attr: "위임", value: "해체 신고 대상 건축물 전부에 대해 전문가가 해체계획서를 검토하여 서명 날인하도록 함", quote: noPhrase },
  { attr: "위임", value: "해체 신고", quote: noPhrase },
  { attr: "위임", value: "대통령령으로 정하는 규모 이하의 건축물은 검토를 생략함", quote: withPhrase },
  { attr: "위임", value: "규모", quote: withPhrase },
]);
add("모양이 다른 값 (문자열 숫자, 용도 한 개, 모르는 기준·코드, 경계 없음, 사용승인)",
  "준공 후 30년 이상 지난 공동주택과 5층 이상인 건축물. 연면적 1천 제곱미터 이하인 근린생활시설.", [
    { attr: "층수", bound: "min", value: "5", quote: "준공 후 30년 이상 지난 공동주택과 5층 이상인 건축물." },
    { attr: "층수", bound: "min", value: 5, quote: "5층 이상인  건축물" },
    { attr: "층수", value: 5, quote: "5층 이상인 건축물" },
    { attr: "층수", bound: "max", value: "다섯", quote: "5층 이상인 건축물" },
    { attr: "용도", value: "02000", quote: "준공 후 30년 이상 지난 공동주택" },
    { attr: "용도", value: ["99999"], quote: "준공 후 30년 이상 지난 공동주택" },
    { attr: "높이", value: 10, quote: "5층 이상" },
    { attr: "사용승인", value: "1996-11-01", quote: "준공 후 30년 이상 지난 공동주택" },
    { attr: "사용승인", value: "1990-11-01", quote: "준공 후 30년 이상 지난 공동주택" },
    { attr: "사용승인", value: "1996-01-01", quote: "준공 후 30년 이상 지난 공동주택" },
    { attr: "연면적", bound: "max", value: 1000, quote: "연면적 1천 제곱미터 이하인 근린생활시설." },
    { attr: "연면적", bound: "max", value: 1000, quote: "연면적 1천 제곱미터 이하인" },
    { attr: "용도", value: ["03000", "04000", "07000"], quote: "연면적 1천 제곱미터 이하인 근린생활시설." },
    { attr: "연면적", bound: "min", value: 0, quote: "연면적 1천 제곱미터 이하인 근린생활시설." },
    { attr: "용도", value: ["02000"], quote: "" },
  ]);

// 시범 법안 26건의 제안이유 전문: 정규식 후보 + 흔한 AI 실수(수치 바꿈, 문구 고침, 경계 뒤집음)
demos.forEach((d) => {
  const text = full[d.bill_no];
  if (!text) return;
  const cands = Criteria.extractCandidates(text);
  const noisy = [];
  cands.forEach((c) => {
    if (c.attr === "연면적" || c.attr === "층수") {
      noisy.push(Object.assign({}, c, { value: c.value * 10 }));
      noisy.push(Object.assign({}, c, { bound: c.bound === "min" ? "max" : "min" }));
      noisy.push(Object.assign({}, c, { value: String(c.value) }));
    }
    noisy.push(Object.assign({}, c, { quote: c.quote.replace(/\.$/, "") + " 등" }));
    noisy.push(Object.assign({}, c, { quote: c.quote.slice(0, 40) }));
  });
  add("시범 " + d.bill_no + " 정규식 후보", text, cands);
  add("시범 " + d.bill_no + " 고친 후보", text, noisy.concat([{ attr: "용도", value: ["18000", "02000", "17000"], quote: Criteria.normText(text).slice(0, 120) }]));
});

const json = JSON.stringify({ note: "server/scripts/verify-cases.js 로 만든 원문 대조 시험 사례 (expected 는 server/lib/criteria.js verify 결과)", ref_date: Criteria.REF_DATE,
  extract_prompt: EXTRACT_PROMPT, extract_user_prefix: "[요약]\n", extract_max_tokens: 500, cases }, null, 1) + "\n";
if (process.argv.includes("--check")) {
  const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") : "";
  if (now !== json) { console.error("data/verify_cases.json 이 지금 verify 결과와 다릅니다. node scripts/verify-cases.js 로 다시 만드세요."); process.exit(1); }
  console.log("verify_cases.json 최신 (" + cases.length + "개 사례)");
} else {
  fs.writeFileSync(OUT, json);
  console.log("data/verify_cases.json 저장 (" + cases.length + "개 사례, 후보 " + cases.reduce((a, c) => a + c.candidates.length, 0) + "개)");
}
