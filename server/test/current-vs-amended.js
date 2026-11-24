/*
 * 현행·개정 문장 나누기 시험 (lib/criteria.js classifySentences, verify 의 sentences)
 *   node test/current-vs-amended.js
 *
 * 제안이유의 "현행법은 …300세대 이상…" 같은 지금 법 설명과 통계·배경 문장의 수치는 판정 기준이 아니다.
 *   - 현행 문장 수치 → current (참고, 판정에 쓰지 않음)
 *   - 통계·배경 문장 수치 → 버림
 *   - 판정 규칙(rule)은 개정 문장(없으면 기타 문장)의 수치만
 * 세대수 법안 5건은 web/data/summaries.json 의 실제 제안이유 전문으로 본다.
 * 정규식 길(모델 없음)과, 현행 문장을 근거로 내는 가짜 모델 길 둘 다 본다.
 */
const assert = require("assert");
const path = require("path");

["AGENT_LLM_BASE_URL", "AGENT_LLM_MODEL", "AGENT_LLM_KEY", "OPENAI_MODEL", "OPENAI_API_KEY", "AGENT_MOCK", "AGENT_MOCK_SCRIPT", "VERCEL", "AGENT_COMPARE_TOKEN"].forEach((k) => delete process.env[k]);
process.env.DATA_DIR = path.join(__dirname, "..", "..", "web", "data");

const Criteria = require("../lib/criteria");
const S = require("../lib/sources");
const Agentic = require("../lib/agentic");
const handler = require("../api/agent");
const full = require(path.join(process.env.DATA_DIR, "summaries.json")).summaries;

const tests = [];
const test = (n, f) => tests.push([n, f]);
const sentenceOf = (no, re) => Criteria.classifySentences(full[no]).find((s) => re.test(s.text));

// ---------------------------------------------------------------- 문장 종류
test("classifySentences: 현행·개정·통계·배경·기타 규칙", () => {
  const k = (t) => Criteria.classifySentences(t).map((s) => s.kind);
  assert.deepStrictEqual(k("현행법은 300세대 이상 공동주택에 적용함."), [Criteria.KIND_CURRENT]);
  assert.deepStrictEqual(k("전체의 65.7%를 차지하고 있음."), [Criteria.KIND_STAT]);
  assert.deepStrictEqual(k("점검대상을 30세대 이상으로 확대하려는 것임."), [Criteria.KIND_AMEND]);
  assert.deepStrictEqual(k("공동주택에 적용함."), [Criteria.KIND_OTHER]);
  // 한 문장 안에서도 "…으나, " 뒤를 따로 본다
  assert.deepStrictEqual(k("현행법은 300세대 이상으로 하고 있으나, 이를 30세대 이상으로 확대하려는 것임."), [Criteria.KIND_CURRENT, Criteria.KIND_AMEND]);
  // 개정(강) 표지가 현행 낱말보다 먼저: "현행 제도의 미비점을 보완하려는 것임" 은 개정
  assert.deepStrictEqual(k("현행 제도의 미비점을 보완하려는 것임."), [Criteria.KIND_AMEND]);
  // 한 문장 안 현행 → 개정: 300 은 current, 30 은 rule
  const v = Criteria.extract("현행법은 300세대 이상으로 하고 있으나, 이를 30세대 이상으로 확대하려는 것임.");
  assert.deepStrictEqual(v.rule.세대수, { min: 30 });
  assert.deepStrictEqual(v.current.세대수, { min: 300 });
});

// ---------------------------------------------------------------- 세대수 법안 5건 (정규식 길)
test("2207658 주택법: 개정 30세대 이상, 현행 300세대는 current, rule 에 max 300 없음", () => {
  const r = Criteria.extract(full["2207658"]);
  assert.deepStrictEqual(r.rule.세대수, { min: 30 });
  assert.strictEqual(r.current.세대수.min, 300);
  assert.ok(r.dropped.some((d) => d.attr === "세대수" && d.why === Criteria.WHY_CURRENT));
  // "지자체별로 30세대 이상부터 300세대 이상까지 다양한데 … 지적" 은 배경 문장
  assert.ok(r.dropped.some((d) => d.attr === "세대수" && d.why === Criteria.WHY_STAT));
  const ev = r.evidence.find((e) => e.attr === "세대수");
  assert.ok(/30세대 이상 공동주택으로 확대/.test(ev.quote), ev.quote); // 개정 문장 (160자로 잘린 근거)
  assert.strictEqual(S.currentLine({ 세대수: { value: r.current.세대수 } }, r.rule), "세대수 현행 300세대 이상, 300세대 이하 → 개정 30세대 이상");
});

test("2217163·2213393 건축물분양법: 30세대는 「주택법」(현행) 설명이라 rule 에 세대수 없음", () => {
  ["2217163", "2213393"].forEach((no) => {
    assert.strictEqual(sentenceOf(no, /30세대 이상/).kind, Criteria.KIND_CURRENT, no);
    const r = Criteria.extract(full[no]);
    assert.strictEqual(r.rule.세대수, undefined, no + " " + JSON.stringify(r.rule));
    assert.deepStrictEqual(r.current.세대수, { min: 30 }, no);
    assert.ok(r.rule.용도.includes("15000"), no + " 생활숙박시설(숙박시설)은 남음");
  });
});

test("2200958 소방기본법: 100세대·3층은 현행법령 설명이라 current, 개정 대상 노유자시설은 남음", () => {
  const r = Criteria.extract(full["2200958"]);
  assert.strictEqual(r.rule.세대수, undefined);
  assert.strictEqual(r.rule.층수, undefined);
  assert.deepStrictEqual(r.current, { 층수: { min: 3 }, 세대수: { min: 100 } });
  assert.ok(r.rule.용도.includes("11000"));
});

test("2213086 공동주택관리법: 150세대는 통계(65.7%) 문장이라 버리고 current 에도 넣지 않음", () => {
  assert.strictEqual(sentenceOf("2213086", /150세대/).kind, Criteria.KIND_STAT);
  const r = Criteria.extract(full["2213086"]);
  assert.strictEqual(r.rule.세대수, undefined);
  assert.strictEqual(r.current.세대수, undefined);
  assert.ok(r.dropped.some((d) => d.attr === "세대수" && d.value === 150 && d.why === Criteria.WHY_STAT));
});

// ---------------------------------------------------------------- 연면적·층수 (시범 법안)
test("2200032 건축법: 연면적 현행 60㎡ 이하 → 개정 85㎡ 이하 (시범 규칙과 같음)", () => {
  const r = Criteria.extract(full["2200032"]);
  assert.deepStrictEqual(r.rule.연면적, { max: 85 });
  assert.deepStrictEqual(r.current.연면적, { max: 60 });
  // 예전(문장 나누기 없이)에는 현행 60 이 먼저 잡혔다
  assert.deepStrictEqual(Criteria.extract(full["2200032"], { sentences: false }).rule.연면적, { max: 60 });
});

test("2204029 소방시설법: '층수가 6층 이상' 은 현행법령 설명이라 rule 에 층수 없음", () => {
  const r = Criteria.extract(full["2204029"]);
  assert.strictEqual(r.rule.층수, undefined);
  assert.deepStrictEqual(r.current.층수, { min: 6 });
});

test("기타 문장 값은 같은 기준이 개정 문장에 있으면 쓰지 않음, 없으면 씀", () => {
  const t = "대상은 50세대 이상 공동주택임. 이에 대상을 30세대 이상 공동주택으로 확대하려는 것임.";
  const v = Criteria.verify([
    { attr: "세대수", bound: "min", value: 50, quote: "대상은 50세대 이상 공동주택임." },
    { attr: "세대수", bound: "min", value: 30, quote: "이에 대상을 30세대 이상 공동주택으로 확대하려는 것임." },
  ], t);
  assert.deepStrictEqual(v.rule.세대수, { min: 30 });
  assert.ok(v.dropped.some((d) => d.value === 50 && d.why === Criteria.WHY_OTHER));
  const o = Criteria.extract("30세대 이상 공동주택에 적용함.");
  assert.deepStrictEqual(o.rule.세대수, { min: 30 });
});

test("의안 원문 개정 부분(bill_text)은 문장 나누기를 하지 않음", () => {
  const doc = "주택법 일부를 다음과 같이 개정한다. 제48조의2제1항 중 “300세대 이상”을 “30세대 이상”으로 한다. 부 칙 이 법은 공포한 날부터 시행한다.";
  assert.deepStrictEqual(Criteria.extractFromDoc(doc).rule.세대수, { min: 30 });
});

// ---------------------------------------------------------------- 가짜 모델이 현행 문장을 근거로 낼 때
test("가짜 모델 후보: 현행 문장 quote 의 300세대는 판정 규칙에서 빠지고 current 로", () => {
  const text = Criteria.normText(full["2207658"]);
  const cur = sentenceOf("2207658", /^현행법은/).text;
  const amend = sentenceOf("2207658", /30세대 이상 공동주택으로 확대/).text;
  const wrong = [{ attr: "세대수", bound: "min", value: 300, quote: cur }, { attr: "세대수", bound: "max", value: "300", quote: cur }];
  const v = Criteria.verify(wrong, text);
  assert.strictEqual(v.rule.세대수, undefined);
  assert.deepStrictEqual(v.current.세대수, { min: 300, max: 300 });
  assert.deepStrictEqual(v.dropped.map((d) => d.why), [Criteria.WHY_CURRENT, Criteria.WHY_CURRENT]);
  // 짧은 quote ("300세대 이상") 도 원문에서 그 자리가 현행 문장이면 버림
  const short = Criteria.verify([{ attr: "세대수", bound: "min", value: 300, quote: "300세대 이상인 공동주택" }], text);
  assert.strictEqual(short.rule.세대수, undefined);
  // 개정 문장 quote 를 함께 내면 그것만 남음
  const both = Criteria.verify(wrong.concat([{ attr: "세대수", bound: "min", value: 30, quote: amend }]), text);
  assert.deepStrictEqual(both.rule.세대수, { min: 30 });
  // 근거 평가: 세대수는 개정 문장 값으로 판정에 충분
  const e = S.evaluateSource("summary", full["2207658"], wrong.concat([{ attr: "세대수", bound: "min", value: 30, quote: amend }]));
  assert.strictEqual(e.items.세대수.status, S.ST_OK);
  assert.deepStrictEqual(e.items.세대수.value, { min: 30 });
  assert.deepStrictEqual(e.current.세대수, { min: 300, max: 300 });
  // 통계 문장 quote 도 버림
  const st = sentenceOf("2213086", /150세대/).text;
  const s2 = Criteria.verify([{ attr: "세대수", bound: "min", value: 150, quote: st }], full["2213086"]);
  assert.strictEqual(s2.rule.세대수, undefined);
  assert.strictEqual(s2.dropped[0].why, Criteria.WHY_STAT);
});

// 기준 뽑기(JSON) 호출에 현행 문장 quote 를 돌려주는 가짜 모델 서버
const realFetch = global.fetch;
function wrongQuoteServer(no) {
  const cur = sentenceOf(no, /^현행법은/).text;
  return function (url, opts) {
    const body = JSON.parse(opts.body);
    let message;
    if (body.response_format && body.response_format.type === "json_object") {
      message = { role: "assistant", content: JSON.stringify({ items: [{ attr: "세대수", bound: "min", value: 300, quote: cur }, { attr: "세대수", bound: "max", value: 300, quote: cur }, { attr: "용도", value: ["02000"], quote: cur }] }) };
    } else if (body.tools) message = Agentic.followNext(body.messages, no);
    else message = { role: "assistant", content: "" };
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ choices: [{ message }], usage: { total_tokens: 100 } }) });
  };
}
let ip = 0;
function call(body) {
  return new Promise((resolve) => {
    const req = { method: "POST", body, url: "/api/agent", headers: { origin: "http://localhost:8000", "x-forwarded-for": "10.7.0." + (++ip) } };
    const res = { code: 200, setHeader() {}, status(c) { this.code = c; return this; }, json(j) { resolve({ code: this.code, body: j }); }, end() { resolve({ code: this.code }); } };
    handler(req, res);
  });
}
async function withWrongModel(no, fn) {
  process.env.OPENAI_API_KEY = "sk-test";
  global.fetch = wrongQuoteServer(no);
  handler._test.clearCache();
  try { return await fn(); } finally { global.fetch = realFetch; delete process.env.OPENAI_API_KEY; }
}

["rag1", "agentic"].forEach((mode) => {
  test(mode + ": 모델이 현행 문장 300세대를 내도 판정 규칙에 없고 extraction.current 로 보임", async () => {
    const r = await withWrongModel("2207658", () => call({ bill: "2207658", mode }));
    assert.strictEqual(r.code, 200, JSON.stringify(r.body));
    const j = r.body;
    const sum = j.extraction.by_source.find((x) => x.source === "summary");
    assert.ok(sum.method.startsWith("규칙"), sum.method); // 규칙 우선 (정규식 + 빈 속성만 AI)
    // 규칙 우선이라 정규식이 개정 문장의 30세대를 잡을 수 있음. 현행 300세대만 규칙에 들어가지 않으면 됨
    assert.ok(!sum.rule.세대수 || (sum.rule.세대수.min !== 300 && sum.rule.세대수.max !== 300), JSON.stringify(sum.rule));
    assert.ok(sum.dropped.some((d) => d.why === Criteria.WHY_CURRENT));
    assert.deepStrictEqual(j.extraction.current.세대수.value, { min: 300, max: 300 });
    assert.ok(/현행 300세대 이상/.test(j.extraction.current_line), j.extraction.current_line);
    // 판정에 쓴 규칙에 300 이 들어가지 않음 (시범 규칙 30세대 이상으로 판정)
    assert.ok(!(j.rule.세대수 && (j.rule.세대수.min === 300 || j.rule.세대수.max === 300)), JSON.stringify(j.rule));
    assert.ok(j.steps.some((s) => s.tool === "evaluate_evidence" && /현행 기준은 판정에 쓰지 않음/.test(s.summary)));
  });
});

test("2207658: 모델이 통계 문장(30세대 이상부터)을 근거로 골라도, 같은 수치·단위가 있는 개정 문장으로 바꿔 30세대 이상을 씀", () => {
  const stat = sentenceOf("2207658", /30세대 이상부터/);
  assert.strictEqual(stat.kind, "통계·배경");
  const quote = stat.text.match(/30세대 이상부터 300세대 이상까지/)[0];
  const r = Criteria.verify([
    { attr: "세대수", value: 30, bound: "min", quote },
    { attr: "세대수", value: 300, bound: "max", quote },
  ], full["2207658"]);
  assert.deepStrictEqual(r.rule.세대수, { min: 30 });
  assert.ok(/확대/.test(r.evidence[0].quote), r.evidence[0].quote);
  assert.ok(r.dropped.some((d) => d.value === 300 && d.why === "통계·배경 문장"), JSON.stringify(r.dropped));
});

test("현행·통계 문장의 수치가 개정 문장에 없으면 바꾸지 않음 (2213086 150세대, 2200958 100세대)", () => {
  for (const [no, v] of [["2213086", 150], ["2200958", 100]]) {
    const s = Criteria.classifySentences(full[no]).find((x) => new RegExp(v + "\\s*세대").test(x.text));
    const q = s.text.match(new RegExp("[^,]*" + v + "\\s*세대[^,]*"))[0].trim();
    const r = Criteria.verify([{ attr: "세대수", value: v, bound: "min", quote: q }], full[no]);
    assert.ok(!r.rule.세대수, no + " " + JSON.stringify(r.rule));
  }
});

(async () => {
  let fail = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("통과  " + n); } catch (e) { fail++; console.log("실패  " + n + "\n      " + (e.stack || e.message).split("\n").slice(0, 4).join("\n      ")); }
  }
  console.log(fail ? "실패 " + fail + "개" : "모두 통과 (" + tests.length + "개)");
  process.exit(fail ? 1 : 0);
})();
