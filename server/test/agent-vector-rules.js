// Agentic RAG similar_rules: pgvector 결과가 있으면 그것을, 없으면 TF-IDF 그대로 (공용 D 는 고치지 않음)
const assert = require("assert");
const agent = require("../api/agent");
const { withVectorRules } = agent._test;

(async () => {
  let n = 0;
  const D = { demos: { "2200001": { title: "가", rule: { 용도: ["02000"] } }, "2200002": { title: "나", rule: { 층수: { min: 3 } } } }, byNo: {} };

  // 1) 키 없음 → 같은 D
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_ANON_KEY;
  assert.strictEqual(await withVectorRules(D, "2200009"), D); n++;
  console.log("통과  키 없음: TF-IDF 그대로 (D 그대로)");

  // 2) 가짜 pgvector 응답 → 시범 규칙 있는 법안만, 후보 표시, 공용 D 는 그대로
  process.env.SUPABASE_URL = "https://example.supabase.co"; process.env.SUPABASE_SERVICE_ROLE_KEY = "test-not-a-key";
  const real = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([
    { bill_no: "2299999", law: "x", similarity: 0.9 }, { bill_no: "2200002", law: "y", similarity: 0.8 }, { bill_no: "2200001", law: "z", similarity: 0.7 },
  ]) });
  const DD = await withVectorRules(D, "2200009");
  global.fetch = real;
  assert.notStrictEqual(DD, D);
  const r = DD.similarRules("2200009", 3);
  assert.deepStrictEqual(r.map((x) => x.no), ["2200002", "2200001"]);
  assert.ok(r.every((x) => x.label === "후보 규칙, 사람 확인 필요" && x.method === "pgvector"));
  assert.strictEqual(D.similarRules, undefined); n++;
  console.log("통과  pgvector: 시범 규칙 법안만 후보로, 공용 D 는 고치지 않음");
  console.log("모두 통과 (" + n + "개)");
})().catch((e) => { console.error(e); process.exit(1); });
