/*
 * 빼곡 — 법안 상세의 "비슷한 법안" · "비슷한 판정 법안"
 *
 * 서버(/api/similar)가 단어 유사도(TF-IDF, 요약문 전문) 또는 단어 + 의미 결합(TF-IDF 와 pgvector 순위의 RRF)으로 찾아 준다.
 * 어느 방법을 쓸지는 collect/compare_similar.py 의 측정 결과(web/data/similar_method.json)로 서버가 정한다.
 * 질의 도우미(AI)를 꺼서 외부 서버에 연결하지 않거나 서버가 답하지 않으면,
 * 화면이 이미 가진 법안 요약(앞부분)으로 같은 TF-IDF 계산(web/tfidf.js)을 해서 보여 준다.
 * 어느 방법으로 찾았는지 늘 함께 표시한다.
 */
(function () {
  "use strict";

  var LABEL = { hybrid: "단어 + 의미 결합(RRF)", pgvector: "의미 검색(pgvector)", tfidf: "단어 유사도(TF-IDF)" };
  var TIP = {
    hybrid: "단어 유사도(TF-IDF) 순위와 법안 요약문 임베딩(paraphrase-multilingual-MiniLM-L12-v2) 순위를 RRF 로 합침. 유사도 숫자는 TF-IDF 코사인",
    pgvector: "법안 요약문 임베딩(paraphrase-multilingual-MiniLM-L12-v2)의 코사인 유사도",
  };
  var local = null; // 화면 안 TF-IDF 색인 (처음 쓸 때 한 번 만든다)
  var apiDown = false; // 서버가 한 번 답하지 않으면 이 화면에서는 다시 묻지 않는다

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fromApi(api, no, k, judged) {
    var ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 5000) : null;
    return fetch(api + "/api/similar?no=" + encodeURIComponent(no) + "&k=" + k + (judged ? "&judged=1" : ""), { signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) { if (!j || !Array.isArray(j.items)) throw new Error("응답 형식"); return j; })
      .then(function (j) { if (timer) clearTimeout(timer); return j; }, function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  function fromLocal(D, no, k, judged) {
    if (!local) local = Tfidf.buildIndex(D.bills.map(function (b) { return { no: b.no, text: b.summary || "" }; }));
    var law = Tfidf.lawOf((D.byNo[no] || {}).name);
    var items = Tfidf.neighbors(local, no, k, judged ? function (x) { return !!D.demos[x]; } : null).map(function (x) {
      var b = D.byNo[x.no], l = Tfidf.lawOf(b.name);
      return { no: x.no, name: b.name, law: l, score: x.score, judged: !!D.demos[x.no], same_law: l === law };
    });
    return { method: "tfidf", label: LABEL.tfidf, items: items, local: true };
  }

  function list(r) {
    if (!r.items.length) return '<p class="muted small">찾지 못했습니다.</p>';
    return '<ul class="sim-list">' + r.items.map(function (x) {
      return '<li><a href="#/bill/' + esc(x.no) + '">' + esc(x.name) + "</a>" +
        '<div class="muted small">' + esc(x.no) + " · 유사도 " + Math.round(x.score * 100) + "%" +
        (x.same_law ? ' · <span class="tag">같은 법률</span>' : "") + (x.judged ? ' · <span class="tag done">판정함</span>' : "") + "</div></li>";
    }).join("") + "</ul>";
  }
  function methodTag(r) {
    return '<span class="tag' + (TIP[r.method] ? " done" : "") + '" title="' +
      (TIP[r.method] ? TIP[r.method] :
        r.local ? "서버에 연결하지 않아 화면이 가진 요약 앞부분으로 계산" : "요약문 전문의 글자 2~3개 묶음 TF-IDF 코사인 유사도") + '">' +
      esc(r.label || LABEL[r.method] || r.method) + (r.local ? " · 요약 앞부분" : "") + "</span>";
  }

  /** opts: { api: 서버 주소 또는 null(연결 안 함), D: { bills, byNo, demos } } */
  function fill(no, opts) {
    var box = document.getElementById("similar-box");
    if (!box || typeof Tfidf === "undefined") return;
    var get = function (k, judged) {
      return opts.api && !apiDown ? fromApi(opts.api, no, k, judged).catch(function () { apiDown = true; return fromLocal(opts.D, no, k, judged); })
        : Promise.resolve(fromLocal(opts.D, no, k, judged));
    };
    Promise.all([get(5, false), get(3, true)]).then(function (rs) {
      var el = document.getElementById("similar-box");
      if (!el || location.hash !== "#/bill/" + no) return; // 그사이 다른 화면으로 옮김
      el.innerHTML = '<div class="grid2 sim-grid">' +
        '<div class="card"><div class="near-head"><h3 style="margin:0">비슷한 법안</h3>' + methodTag(rs[0]) + "</div>" + list(rs[0]) + "</div>" +
        '<div class="card"><div class="near-head"><h3 style="margin:0">비슷한 판정 법안</h3>' + methodTag(rs[1]) + "</div>" +
        '<p class="muted small" style="margin:6px 0 0">적용 기준을 이미 뽑은 법안 중 가까운 것. 기준을 정할 때 참고만 합니다.</p>' + list(rs[1]) + "</div></div>";
    }).catch(function () { /* 비슷한 법안은 참고용이라 실패하면 그리지 않는다 */ });
  }

  window.Similar = { fill: fill, LABEL: LABEL };
})();
