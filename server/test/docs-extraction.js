/*
 * 의안 원문에서 기준 뽑기 시험: 개정 부분(amendedText)만 근거로 쓰는지
 *   node test/docs-extraction.js
 *
 * 1. 실제 원문(data/bill_docs): 예전에 원문에서 잘못 뽑힌 층수 2건이 더는 나오지 않음
 *    - 2218807 "50층 이상" (각 호 중 하나인 초고층 아파트 조건)
 *    - 2217767 "3층 이상" (신·구조문대비표의 현행 칸)
 * 2. 짧은 만든 글: "A"를 "B"로 한다 → B 만 / 정의 조문 수치 빠짐 / 신설 글 들어감 / 대비표 수치 빠짐 / 개정문 없으면 ""
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { amendedText, extractFromDoc, extract, prepDocText } = require("../lib/criteria");

const DOCS = path.join(__dirname, "..", "..", "data", "bill_docs");
let n = 0;
function ok(name, fn) { fn(); n++; console.log("  ok  " + name); }

// ---------------------------------------------------------------- 실제 원문
const raw = (no) => fs.readFileSync(path.join(DOCS, no + "_원문.txt"), "utf8");

ok("2218807: 원문에서 층수가 나오지 않음 (예전에는 50층 이상)", () => {
  assert.ok(extract(prepDocText(raw("2218807"))).rule.층수, "예전 방식(원문 전체)에서는 층수가 나왔어야 함");
  const r = extractFromDoc(raw("2218807"));
  assert.strictEqual(r.rule.층수, undefined, "층수: " + JSON.stringify(r.rule.층수));
  assert.ok(r.dropped.some((d) => d.attr === "층수"), "층수는 버린 후보로 남아야 함");
  assert.deepStrictEqual(r.rule.연면적, { min: 10000 }, "물류창고 1만㎡ 기준은 남아야 함");
  assert.ok(r.rule.용도.includes("18000"), "창고시설은 남아야 함");
});

ok("2217767: 원문에서 층수가 나오지 않음 (예전에는 대비표 현행 칸의 3층 이상)", () => {
  assert.ok(extract(prepDocText(raw("2217767"))).rule.층수, "예전 방식(원문 전체)에서는 층수가 나왔어야 함");
  const r = extractFromDoc(raw("2217767"));
  assert.strictEqual(r.rule.층수, undefined, "층수: " + JSON.stringify(r.rule.층수));
  assert.ok(!/3층/.test(r.text), "개정 부분 글에 3층이 없어야 함");
  assert.deepStrictEqual(r.rule.용도, ["17000"], "개정으로 들어가는 공장은 남아야 함");
  assert.ok(r.text.includes("다중이용 건축물, 공장 등"), "“…”으로 한다의 새 글이 있어야 함");
  assert.ok(!r.text.includes("다중이용 건축물 등”"), "고치기 전 글이 없어야 함");
});

ok("실제 원문 36건: 근거 문구는 모두 개정 부분 글 안에 있고, 제안이유·부칙·대비표가 섞이지 않음", () => {
  const files = fs.readdirSync(DOCS).filter((f) => /^\d+_원문\.txt$/.test(f));
  assert.ok(files.length >= 36);
  files.forEach((f) => {
    const r = extractFromDoc(fs.readFileSync(path.join(DOCS, f), "utf8"));
    r.evidence.forEach((e) => assert.ok(r.text.includes(e.quote), f + " 근거가 개정 부분 밖: " + e.quote));
    assert.ok(!/신\s*[ㆍ·]\s*구\s*조\s*문|제안이유|부\s*칙/.test(r.text), f + " 개정 부분에 제안이유·부칙·대비표가 섞임");
  });
});

// ---------------------------------------------------------------- 만든 글
const wrap = (body, tail = "") =>
  "제안이유 및 주요내용\n현행법은 연면적 3천제곱미터 이상인 공장에 적용함.\n" +
  "법률 제 호\n시험법 일부개정법률안\n시험법 일부를 다음과 같이 개정한다.\n" + body + "\n부 칙\n이 법은 공포한 날부터 시행한다.\n" + tail;

ok("“A”를 “B”로 한다: B 만 남음", () => {
  const t = wrap("제10조제1항 중 “5층 이상인 창고”를 “3층 이상인 창고”로 한다.");
  const a = amendedText(t);
  assert.ok(a.includes("3층 이상인 창고"), a);
  assert.ok(!a.includes("5층"), a);
  const r = extractFromDoc(t);
  assert.deepStrictEqual(r.rule.층수, { min: 3 });
  assert.deepStrictEqual(r.rule.용도, ["18000"]);
  assert.strictEqual(r.rule.연면적, undefined, "제안이유의 3천㎡ 는 빠져야 함");
});

ok("“A”을 “B”으로 한다, 한 지시문에 여러 쌍: B 들만", () => {
  const a = amendedText(wrap("제7조 중 “공장”을 “공장 및 창고”로, “연면적 500제곱미터”를 “연면적 1천제곱미터”으로 한다."));
  assert.ok(a.includes("공장 및 창고") && a.includes("연면적 1천제곱미터"), a);
  assert.ok(!a.includes("500"), a);
});

ok("정의 조문(제2조, 제목에 정의가 든 조)의 수치는 빠짐", () => {
  const t = wrap(
    "제2조제1항에 제6호의2를 다음과 같이 신설한다.\n6의2. “초고층 건축물”이란 50층 이상인 건축물을 말한다.\n" +
    "제3조의2제1호 중 “30층”을 “40층”으로 한다.\n" +
    "제9조제2항 중 “공장”을 “공장 및 창고”로 한다.",
    "신ㆍ구조문대비표\n현 행 개 정 안\n제3조의2(용어의 정의) 1. 30층 이상\n");
  const a = amendedText(t);
  assert.ok(!a.includes("50층"), "제2조 신설 정의가 들어감: " + a);
  assert.ok(!a.includes("40층"), "제목에 정의가 든 제3조의2 가 들어감: " + a);
  assert.ok(a.includes("공장 및 창고"), a);
  assert.strictEqual(extractFromDoc(t).rule.층수, undefined);
});

ok("신설 조문·신설 호의 글은 들어감", () => {
  const t = wrap(
    "제12조의2를 다음과 같이 신설한다.\n제12조의2(물류창고의 소방시설) ① 연면적 1만제곱미터 이상인 물류창고의 관계인은 스프링클\n러설비를 설치하여야 한다.\n" +
    "제13조제1항에 제5호를 다음과 같이 신설한다.\n5. 6층 이상인 숙박시설");
  const a = amendedText(t);
  assert.ok(a.includes("연면적 1만제곱미터 이상인 물류창고") && a.includes("스프링클러설비"), a);
  assert.ok(a.includes("6층 이상인 숙박시설"), a);
  const r = extractFromDoc(t);
  assert.deepStrictEqual(r.rule.연면적, { min: 10000 });
  assert.deepStrictEqual(r.rule.층수, { min: 6 });
  r.evidence.forEach((e) => assert.ok(a.includes(e.quote)));
});

ok("…를 다음과 같이 한다: 바꾸는 글이 들어감", () => {
  const a = amendedText(wrap("제5조제2항을 다음과 같이 한다.\n② 연면적 2천제곱미터 이상인 공장은 점검을 받아야 한다."));
  assert.ok(a.includes("연면적 2천제곱미터 이상인 공장"), a);
  assert.deepStrictEqual(extractFromDoc(wrap("제5조제2항을 다음과 같이 한다.\n② 연면적 2천제곱미터 이상인 공장은 점검을 받아야 한다.")).rule.연면적, { min: 2000 });
});

ok("신·구조문대비표(현행 칸)의 수치는 빠짐", () => {
  const t = wrap("제27조제2항에 제8호를 다음과 같이 신설한다.\n8. 공장",
    "- 5 -\n신ㆍ구조문대비표\n현 행 개 정 안\n② 다음 각 호의 어느 하나에\n해당하는 건축물 중 3층 이상\n으로 연면적 5천제곱미터 이상\n② ----------------------\n<신 설> 8. 공장\n");
  const a = amendedText(t);
  assert.ok(!/3층|5천/.test(a), a);
  const r = extractFromDoc(t);
  assert.strictEqual(r.rule.층수, undefined);
  assert.strictEqual(r.rule.연면적, undefined);
  assert.deepStrictEqual(r.rule.용도, ["17000"]);
});

ok("다른 법 조문을 가리키는 말(제45조에 따른)은 지시문으로 보지 않음", () => {
  const a = amendedText(wrap("제18조제1항에 제4호의2를 다음과 같이 신설한다.\n4의2. 「다른법」 제45조의17에\n따른 한국산업단지공단제27조제2항에 제8호를 다음과 같이 신설한다.\n8. 공장"));
  assert.ok(a.includes("한국산업단지공단") && /공장\.?$/.test(a), a);
});

ok("개정문이 없으면 빈 글 (원문 전체로 대신하지 않음)", () => {
  const t = "제안이유 및 주요내용\n연면적 1만제곱미터 이상인 공장과 3층 이상인 창고.";
  assert.strictEqual(amendedText(t), "");
  const r = extractFromDoc(t);
  assert.deepStrictEqual(r.rule, {});
  assert.deepStrictEqual(r.evidence, []);
});

ok("각 호에 같은 기준 수치가 여럿이면 그 기준은 버림", () => {
  const r = extractFromDoc(wrap("제24조제2항에 각 호를 다음과 같이 신설한다.\n1. 50층 이상인 아파트\n2. 30층 이상인 특정소방대상물\n3. 연면적 1만제곱미터 이상의 창고"));
  assert.strictEqual(r.rule.층수, undefined);
  assert.deepStrictEqual(r.rule.연면적, { min: 10000 });
});

console.log(`docs-extraction: ${n}개 통과`);
