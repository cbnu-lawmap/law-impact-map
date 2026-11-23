/*
 * 비슷한 법안: 단어 유사도(TF-IDF) 또는 단어 + 의미 결합(RRF)
 *
 *   similarByVector(no, k)  Supabase rpc similar_bills 호출. 키 없음·네트워크 오류·임베딩 없음이면 null
 *   similarByTfidf(D, no, k, keep)  공개 데이터(요약문 전문)로 TF-IDF 이웃
 *   rrf(lists, k)  순위 목록 여럿을 reciprocal rank fusion 으로 합친다 (점수 = Σ 1/(60 + 순위))
 *   findSimilar(no, k, opts)  { method, label, items } 를 돌려준다 (api/similar.js, api/agent.js 가 씀)
 *
 * 어느 방법을 먼저 쓸지는 측정으로 정한다.
 *   collect/compare_similar.py (GitHub Actions embed-bills.yml) 가 691건에서 "같은 법률 법안 top-3 적중률" 을
 *   TF-IDF·임베딩·RRF 결합으로 재고, 결합 top-3 ≥ TF-IDF top-3 이면 hybrid, 아니면 tfidf 를 web/data/similar_method.json 에 쓴다.
 *   서버는 그 파일을 읽는다 (없으면 tfidf). 환경변수 SIMILAR_METHOD=tfidf|hybrid 가 있으면 그것이 먼저다.
 *   hybrid 에서 pgvector 를 못 쓰면(키 없음·실패·임베딩 없음) TF-IDF 로 대신한다.
 *
 * 임베딩은 collect/embed_bills.py 가 paraphrase-multilingual-MiniLM-L12-v2 (384차원) 로 만들어 bill_embeddings 표에 넣는다.
 */
const { sbPost } = require("./supabase");
const { loadJson } = require("./common");
const Tfidf = require("./tfidf");

const METHOD_LABEL = { hybrid: "단어 + 의미 결합(RRF)", pgvector: "의미 검색(pgvector)", tfidf: "단어 유사도(TF-IDF)" };
const METHODS = ["tfidf", "hybrid"];
const RRF_K = 60; // collect/compare_similar.py 의 RRF_K 와 같게
const POOL = 20; // 결합할 때 두 방법에서 각각 가져오는 후보 수

/** [{ no, law, score }] 또는 null */
async function similarByVector(no, k) {
  if (!/^\d{7}$/.test(String(no))) return null;
  const n = Math.max(1, Math.min(20, Number(k) || 5));
  const r = await sbPost("rpc/similar_bills", { p_bill_no: String(no), k: n }, { allowAnon: true });
  if (!r || !Array.isArray(r.json) || !r.json.length) return null; // 임베딩이 아직 없는 법안도 null
  const out = r.json
    .filter((x) => x && /^\d+$/.test(String(x.bill_no)) && typeof x.similarity === "number")
    .map((x) => ({ no: String(x.bill_no), law: x.law || "", score: x.similarity }));
  return out.length ? out : null;
}

/**
 * 순위 목록(앞이 1위) 여럿을 합친다. 점수 = Σ 1/(k + 순위). 점수가 같으면 의안번호 순.
 * 돌려줌: [{ no, rrf, ranks: [목록별 순위 또는 null] }]
 */
function rrf(lists, k = RRF_K) {
  const acc = new Map();
  lists.forEach((list, li) => {
    list.forEach((no, i) => {
      const e = acc.get(no) || { no, rrf: 0, ranks: lists.map(() => null) };
      if (e.ranks[li] !== null) return; // 한 목록 안의 중복은 첫 순위만
      e.rrf += 1 / (k + i + 1);
      e.ranks[li] = i + 1;
      acc.set(no, e);
    });
  });
  return Array.from(acc.values()).sort((a, b) => b.rrf - a.rrf || (a.no < b.no ? -1 : a.no > b.no ? 1 : 0));
}

let cache = null; // { at, D }

/** 공개 데이터: 법안 목록·요약문 전문·판정한 법안·측정으로 정한 방법 (10분 보관) */
async function loadData() {
  if (cache && Date.now() - cache.at < 10 * 60000) return cache.D;
  const [b, s, d, m] = await Promise.all([
    loadJson("bills.json"),
    loadJson("summaries.json").catch(() => ({ summaries: {} })),
    loadJson("demo_rules.json").catch(() => ({ demos: [] })),
    loadJson("similar_method.json").catch(() => null),
  ]);
  const byNo = {};
  b.bills.forEach((x) => { byNo[x.no] = x; });
  const full = (s && s.summaries) || {};
  const index = Tfidf.buildIndex(b.bills.map((x) => ({ no: x.no, text: full[x.no] || x.summary || "" })));
  const judged = new Set((d.demos || []).map((x) => x.bill_no));
  const measured = m && METHODS.includes(m.method) ? m.method : null;
  const D = { bills: b.bills, byNo, index, judged, measured };
  cache = { at: Date.now(), D };
  return D;
}

/** 쓸 방법: 환경변수 SIMILAR_METHOD → 측정 파일(similar_method.json) → tfidf */
function primaryMethod(D, env = process.env) {
  const want = String(env.SIMILAR_METHOD || "").trim();
  if (METHODS.includes(want)) return want;
  return (D && D.measured) || "tfidf";
}

function similarByTfidf(D, no, k, keep) {
  return Tfidf.neighbors(D.index, String(no), k, keep).map((x) => ({
    no: x.no, law: D.byNo[x.no] ? Tfidf.lawOf(D.byNo[x.no].name) : "", score: x.score,
  }));
}

/** 두 법안의 TF-IDF 코사인 (결합 결과에도 화면이 보여 줄 유사도가 있게) */
function tfidfScore(D, a, b) {
  const x = D.index.vecs.get(String(a)), y = D.index.vecs.get(String(b));
  if (!x || !y) return 0;
  let s = 0;
  const [p, q] = x.size <= y.size ? [x, y] : [y, x];
  p.forEach((v, g) => { const w = q.get(g); if (w !== undefined) s += v * w; });
  return s;
}

/**
 * 결합: pgvector 상위 POOL + TF-IDF 상위 POOL 을 RRF 로 합친다. pgvector 를 못 쓰면 null.
 * keep 으로 거른 뒤의 순위로 합친다 (판정한 법안만 볼 때).
 */
async function similarByHybrid(D, no, k, keep) {
  const vec = await similarByVector(no, POOL);
  if (!vec) return null;
  const vNos = vec.map((x) => x.no).filter((x) => x !== no && D.byNo[x] && (!keep || keep(x)));
  if (!vNos.length) return null;
  const tNos = similarByTfidf(D, no, POOL, keep).map((x) => x.no);
  const vScore = new Map(vec.map((x) => [x.no, x.score]));
  return rrf([tNos, vNos]).slice(0, k).map((x) => ({
    no: x.no, law: Tfidf.lawOf(D.byNo[x.no].name), score: tfidfScore(D, no, x.no),
    rrf: x.rrf, rank_tfidf: x.ranks[0], rank_vector: x.ranks[1], vector_score: vScore.has(x.no) ? vScore.get(x.no) : null,
  }));
}

/**
 * opts.judged: 판정한 법안(적용 기준이 있는 법안)만
 * opts.method: "tfidf" | "hybrid" (시험용. 없으면 primaryMethod)
 * 돌려주는 값: { method: "hybrid" | "tfidf", label, primary, items: [{ no, name, law, score, judged, same_law, rrf? }] }
 *   score 는 늘 TF-IDF 코사인 (화면의 "유사도 N%"), 결합이면 rrf 점수와 두 방법의 순위도 붙인다.
 */
async function findSimilar(no, k, opts) {
  opts = opts || {};
  const D = await loadData();
  if (!D.byNo[no]) return null;
  const keep = opts.judged ? (x) => D.judged.has(x) : null;
  const primary = METHODS.includes(opts.method) ? opts.method : primaryMethod(D);
  let method = "tfidf";
  let items = null;
  if (primary === "hybrid") {
    items = await similarByHybrid(D, no, k, keep);
    if (items) method = "hybrid";
  }
  if (!items) items = similarByTfidf(D, no, k, keep);
  const law = Tfidf.lawOf(D.byNo[no].name);
  return {
    method,
    label: METHOD_LABEL[method],
    primary,
    items: items.map((x) => {
      const b = D.byNo[x.no];
      const l = Tfidf.lawOf(b.name);
      const out = { no: x.no, name: b.name, law: l, score: Math.round(x.score * 1000) / 1000, judged: D.judged.has(x.no), same_law: l === law };
      if (x.rrf !== undefined) Object.assign(out, { rrf: Math.round(x.rrf * 10000) / 10000, rank_tfidf: x.rank_tfidf, rank_vector: x.rank_vector });
      return out;
    }),
  };
}

function _resetCache() { cache = null; }

module.exports = { similarByVector, similarByTfidf, similarByHybrid, rrf, findSimilar, loadData, primaryMethod, METHOD_LABEL, METHODS, RRF_K, POOL, _resetCache };
