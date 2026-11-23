// Agentic RAG similar_rules: 비슷한 법안 찾기와 같은 방법을 따른다 (공용 D 는 고치지 않음)
//   tfidf (측정 결과 또는 SIMILAR_METHOD) → D 그대로 (pgvector 를 부르지 않음)
//   hybrid → 시범 규칙 법안 중 TF-IDF 순위와 pgvector 순위를 RRF 로 합친 후보, pgvector 를 못 쓰면 D 그대로
const assert = require("assert");
const agent = require("../api/agent");
const { withVectorRules } = agent._test;

(async () => {
  let n = 0;
  const D0 = {
    demos: {
      "2200001": { title: "가", rule: { 용도: ["02000"] } },
      "2200002": { title: "나", rule: { 층수: { min: 3 } } },
      "2200003": { title: "다", rule: { 세대수: { min: 30 } } },
    },
    full: {
      "2200009": "공동주택 관리 기준을 강화하고 공동주택 관리비를 공개하도록 함",
      "2200001": "공동주택 관리 기준을 강화함",
      "2200002": "공동주택 층수 제한",
      "2200003": "건축물 해체 허가 절차 정비",
    },
    byNo: {},
  };
  const hybridD = () => Object.assign({}, D0, { similarMethod: "hybrid" });
  const real = global.fetch;
  let called = 0;
  const fakeVector = async () => { called++; return { ok: true, status: 200, text: async () => JSON.stringify([
    { bill_no: "2299999", law: "x", similarity: 0.9 }, { bill_no: "2200002", law: "y", similarity: 0.8 }, { bill_no: "2200003", law: "z", similarity: 0.7 },
  ]) }; };
  delete process.env.SIMILAR_METHOD;

  // 1) 키 없음 → 같은 D (hybrid 여도)
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_ANON_KEY;
  const H0 = hybridD();
  assert.strictEqual(await withVectorRules(H0, "2200009"), H0); n++;
  console.log("통과  키 없음: TF-IDF 그대로 (D 그대로)");

  // 2) tfidf 가 정해진 방법 (측정 파일 없음 → tfidf) → 키가 있어도 D 그대로, pgvector 를 부르지 않음
  process.env.SUPABASE_URL = "https://example.supabase.co"; process.env.SUPABASE_SERVICE_ROLE_KEY = "test-not-a-key";
  global.fetch = fakeVector;
  assert.strictEqual(await withVectorRules(D0, "2200009"), D0);
  const T = Object.assign({}, D0, { similarMethod: "tfidf" });
  assert.strictEqual(await withVectorRules(T, "2200009"), T);
  process.env.SIMILAR_METHOD = "tfidf";
  const H1 = hybridD();
  assert.strictEqual(await withVectorRules(H1, "2200009"), H1);
  delete process.env.SIMILAR_METHOD;
  assert.strictEqual(called, 0); n++;
  console.log("통과  tfidf: TF-IDF 시범 규칙 그대로, pgvector 를 부르지 않음 (환경변수가 측정 파일보다 먼저)");

  // 3) hybrid → TF-IDF 순위 [1, 2, 3] 과 pgvector 순위 [2, 3] 을 RRF: 2 (1/62+1/61) > 3 (1/63+1/62) > 1 (1/61)
  const H = hybridD();
  const DD = await withVectorRules(H, "2200009");
  global.fetch = real;
  assert.notStrictEqual(DD, H);
  const r = DD.similarRules("2200009", 3);
  assert.deepStrictEqual(r.map((x) => x.no), ["2200002", "2200003", "2200001"]);
  assert.ok(r.every((x) => x.label === "후보 규칙, 사람 확인 필요" && x.method === "hybrid" && typeof x.rrf === "number"));
  assert.ok(Math.abs(r[0].rrf - (1 / 62 + 1 / 61)) < 1e-4);
  assert.strictEqual(H.similarRules, undefined); n++;
  console.log("통과  hybrid: 시범 규칙 법안만 RRF 로 합친 후보, 공용 D 는 고치지 않음");
  console.log("모두 통과 (" + n + "개)");
})().catch((e) => { console.error(e); process.exit(1); });
