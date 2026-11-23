/*
 * 빼곡 — 비슷한 법안 (Vercel 서버리스 함수)
 *
 *   GET /api/similar?no=2206436&k=5[&judged=1]
 *   → { no, method: "hybrid" | "tfidf", label, primary, items: [{ no, name, law, score, judged, same_law, rrf? }] }
 *
 * 측정으로 정한 방법(web/data/similar_method.json, collect/compare_similar.py 가 씀)을 쓴다.
 *   tfidf  공개 요약문 전문의 단어 유사도(TF-IDF)
 *   hybrid TF-IDF 상위 20 과 의미 검색(Supabase pgvector, rpc similar_bills) 상위 20 을 RRF 로 합침.
 *          키가 없거나 실패하면 TF-IDF 로 대신한다. 어느 쪽을 썼는지 method 로 알려 준다.
 * 공개 법안 데이터만 다루며 AI 모델을 부르지 않는다.
 */
const { cors, createLimiter, clientIp } = require("../lib/common");
const { findSimilar } = require("../lib/similar");

const limited = createLimiter({ windowMs: 60000, max: 60 });

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ error: "GET만 받습니다" }); return; }
  if (limited(clientIp(req))) { res.status(429).json({ error: "요청이 너무 잦습니다. 1분 뒤에 다시 해 주세요." }); return; }

  const u = new URL(req.url || "/", "http://x");
  const no = String((req.query && req.query.no) || u.searchParams.get("no") || "");
  const k = Math.max(1, Math.min(10, Number((req.query && req.query.k) || u.searchParams.get("k")) || 5));
  const judged = String((req.query && req.query.judged) || u.searchParams.get("judged") || "") === "1";
  if (!/^\d{7}$/.test(no)) { res.status(400).json({ error: "의안번호(7자리)가 필요합니다" }); return; }

  try {
    const r = await findSimilar(no, k, { judged });
    if (!r) { res.status(404).json({ error: "의안번호 " + no + " 를 찾지 못했습니다" }); return; }
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).json(Object.assign({ no }, r));
  } catch (e) {
    res.status(502).json({ error: "비슷한 법안을 찾지 못했습니다: " + String((e && e.message) || e).slice(0, 120) });
  }
};
