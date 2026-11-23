// 자동 생성 파일: web/tfidf.js 의 복사본이다. 여기를 고치지 말고 web/tfidf.js 를 고친 뒤 node server/scripts/sync-tfidf.js 를 실행할 것.
/*
 * 빼곡 — 비슷한 법안 찾기 (단어 유사도, TF-IDF)
 *
 * 화면(web/admin.html)과 서버(server/lib/tfidf.js, 자동 복사본)가 같은 계산을 쓴다.
 * 의미 검색(pgvector, Supabase)이 안 될 때의 대체 방법이다.
 *
 *   글자 2~3개 묶음(char_wb n-gram) → TF-IDF (sublinear tf, smooth idf, l2 정규화) → 코사인 유사도
 *   sklearn TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 3), sublinear_tf=True) 와 같은 방식이라
 *   collect/compare_similar.py 가 sklearn 으로 같은 결과를 낸다.
 *
 * 원본은 이 파일이다. 고친 뒤 node server/scripts/sync-tfidf.js 로 서버 복사본을 다시 만든다.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Tfidf = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var NGRAM = [2, 3];

  /**
   * 법안명 → 법률명. 개정·폐지안은 고치는 법률 이름, 제정안은 끝의 "안"만 뗀다.
   *   "건축법 일부개정법률안" → "건축법", "재건축초과이익 환수에 관한 법률폐지법률안" → "재건축초과이익 환수에 관한 법률",
   *   "고령자돌봄주택 특별법안" → "고령자돌봄주택 특별법"
   */
  function lawOf(name) {
    var s = String(name || "").trim().replace(/\s*\([^)]*\)\s*$/, ""); // 끝의 (대안) 같은 괄호
    var m = s.match(/^(.*?)\s*(일부개정|전부개정|폐지)법률안$/);
    if (m) return m[1].trim();
    return s.replace(/안$/, "").trim();
  }

  function grams(text) {
    var counts = new Map();
    String(text || "").toLowerCase().split(/\s+/).filter(Boolean).forEach(function (w) {
      var pw = " " + w + " ";
      for (var n = NGRAM[0]; n <= NGRAM[1]; n++) {
        if (pw.length < n) break;
        for (var i = 0; i + n <= pw.length; i++) {
          var g = pw.slice(i, i + n);
          counts.set(g, (counts.get(g) || 0) + 1);
        }
        if (n >= pw.length) break;
      }
    });
    return counts;
  }

  /** docs: [{ no, text }] → 색인 */
  function buildIndex(docs) {
    var df = new Map(), raw = [];
    docs.forEach(function (d) {
      var c = grams(d.text);
      raw.push([d.no, c]);
      c.forEach(function (_, g) { df.set(g, (df.get(g) || 0) + 1); });
    });
    var n = docs.length, vecs = new Map();
    raw.forEach(function (r) {
      var v = new Map(), ss = 0;
      r[1].forEach(function (c, g) {
        var x = (1 + Math.log(c)) * (Math.log((1 + n) / (1 + df.get(g))) + 1);
        v.set(g, x);
        ss += x * x;
      });
      if (ss > 0) { var norm = Math.sqrt(ss); v.forEach(function (x, g) { v.set(g, x / norm); }); }
      vecs.set(r[0], v);
    });
    return { nos: raw.map(function (r) { return r[0]; }), vecs: vecs };
  }

  function dot(a, b) {
    if (a.size > b.size) { var t = a; a = b; b = t; }
    var s = 0;
    a.forEach(function (x, g) { var y = b.get(g); if (y !== undefined) s += x * y; });
    return s;
  }

  /** no 와 비슷한 법안 k개 [{ no, score }]. keep(no) 가 false 인 법안은 뺀다 */
  function neighbors(index, no, k, keep) {
    var q = index.vecs.get(no);
    if (!q) return [];
    var out = [];
    index.nos.forEach(function (o) {
      if (o === no || (keep && !keep(o))) return;
      out.push({ no: o, score: dot(q, index.vecs.get(o)) });
    });
    out.sort(function (a, b) { return b.score - a.score || (a.no < b.no ? -1 : a.no > b.no ? 1 : 0); });
    return out.slice(0, k);
  }

  return { lawOf: lawOf, grams: grams, buildIndex: buildIndex, neighbors: neighbors };
});
