/*
 * 비슷한 법안: 의미 검색(pgvector) 먼저, 안 되면 단어 유사도(TF-IDF)
 *
 *   similarByVector(no, k)  Supabase rpc similar_bills 호출. 키 없음·네트워크 오류·임베딩 없음이면 null
 *   similarByTfidf(D, no, k, keep)  공개 데이터(요약문 전문)로 TF-IDF 이웃
 *   findSimilar(no, k, opts)  둘을 묶어 { method, items } 를 돌려준다 (api/similar.js, 나중에 agent.js 가 씀)
 *
 * 임베딩은 collect/embed_bills.py (GitHub Actions embed-bills.yml) 가
 * paraphrase-multilingual-MiniLM-L12-v2 (384차원) 로 만들어 bill_embeddings 표에 넣는다.
 */
const { sbPost } = require("./supabase");
const { loadJson } = require("./common");
const Tfidf = require("./tfidf");

const METHOD_LABEL = { pgvector: "의미 검색(pgvector)", tfidf: "단어 유사도(TF-IDF)" };

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

let cache = null; // { at, D }

/** 공개 데이터: 법안 목록·요약문 전문·판정한 법안 (10분 보관) */
async function loadData() {
  if (cache && Date.now() - cache.at < 10 * 60000) return cache.D;
  const [b, s, d] = await Promise.all([
    loadJson("bills.json"),
    loadJson("summaries.json").catch(() => ({ summaries: {} })),
    loadJson("demo_rules.json").catch(() => ({ demos: [] })),
  ]);
  const byNo = {};
  b.bills.forEach((x) => { byNo[x.no] = x; });
  const full = (s && s.summaries) || {};
  const index = Tfidf.buildIndex(b.bills.map((x) => ({ no: x.no, text: full[x.no] || x.summary || "" })));
  const judged = new Set((d.demos || []).map((x) => x.bill_no));
  const D = { bills: b.bills, byNo, index, judged };
  cache = { at: Date.now(), D };
  return D;
}

function similarByTfidf(D, no, k, keep) {
  return Tfidf.neighbors(D.index, String(no), k, keep).map((x) => ({
    no: x.no, law: D.byNo[x.no] ? Tfidf.lawOf(D.byNo[x.no].name) : "", score: x.score,
  }));
}

/**
 * opts.judged: 판정한 법안(적용 기준이 있는 법안)만
 * 돌려주는 값: { method: "pgvector" | "tfidf", label, items: [{ no, name, law, score, judged, same_law }] }
 */
async function findSimilar(no, k, opts) {
  opts = opts || {};
  const D = await loadData();
  if (!D.byNo[no]) return null;
  const keep = opts.judged ? (x) => D.judged.has(x) : null;
  let method = "pgvector";
  let items = await similarByVector(no, opts.judged ? 20 : k);
  if (items) {
    items = items.filter((x) => D.byNo[x.no] && (!keep || keep(x.no))).slice(0, k);
    if (!items.length) items = null; // 판정한 법안이 상위 20개 안에 없으면 TF-IDF 로
  }
  if (!items) { method = "tfidf"; items = similarByTfidf(D, no, k, keep); }
  const law = Tfidf.lawOf(D.byNo[no].name);
  return {
    method,
    label: METHOD_LABEL[method],
    items: items.map((x) => {
      const b = D.byNo[x.no];
      const l = Tfidf.lawOf(b.name);
      return { no: x.no, name: b.name, law: l, score: Math.round(x.score * 1000) / 1000, judged: D.judged.has(x.no), same_law: l === law };
    }),
  };
}

function _resetCache() { cache = null; }

module.exports = { similarByVector, similarByTfidf, findSimilar, loadData, METHOD_LABEL, _resetCache };
