/* 법안 영향 지도 — 화면 로직 (Leaflet, 빌드 도구 없음) */
(function () {
  "use strict";

  // ---------------------------------------------------------------- 색
  var AGE_BINS = [
    { label: "~1979년", test: function (y) { return y <= 1979; }, color: "#7f1d1d" },
    { label: "1980~1989년", test: function (y) { return y >= 1980 && y <= 1989; }, color: "#c2410c" },
    { label: "1990~1999년", test: function (y) { return y >= 1990 && y <= 1999; }, color: "#f59e0b" },
    { label: "2000~2009년", test: function (y) { return y >= 2000 && y <= 2009; }, color: "#84cc16" },
    { label: "2010년~", test: function (y) { return y >= 2010; }, color: "#0e7490" },
  ];
  var AGE_UNKNOWN = { label: "사용승인일 없음", color: "#cbd5e1" };
  var STATUS_COLOR = { 대상: "#dc2626", 경계선: "#f59e0b", 비대상: "#d1d5db", 판정불가: "#6366f1" };
  var STATUS_DESC = {
    대상: "기준을 모두 충족",
    경계선: "기준에 근소하게 못 미침 (±10%, ±1년)",
    비대상: "기준에 해당하지 않음",
    판정불가: "속성 없음 또는 시행령 위임",
  };
  var CONF_LOW = 0.5;

  // ---------------------------------------------------------------- 상태
  var state = {
    fields: {},        // {1: "소방·화재", ...}
    bills: [],
    demos: {},         // bill_no -> demo
    checked: new Set(),
    query: "",
    selected: null,
    buildings: null,   // L.geoJSON 레이어
    props: [],
  };

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var fmt = function (n) { return Number(n).toLocaleString("ko-KR"); };

  // ---------------------------------------------------------------- 지도
  var map = L.map("map", { preferCanvas: true, zoomControl: true }).setView([36.6345, 127.462], 15);
  // 바탕지도: 키가 필요 없는 OpenStreetMap 표준 타일
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 기여자 · 건물: 브이월드 건물통합정보',
  }).addTo(map);

  function yearOf(p) {
    if (Judge.isEmpty(p.useapr_day)) return null;
    var y = parseInt(String(p.useapr_day).slice(0, 4), 10);
    return isNaN(y) ? null : y;
  }
  function ageBin(p) {
    var y = yearOf(p);
    if (y === null) return AGE_UNKNOWN;
    for (var i = 0; i < AGE_BINS.length; i++) if (AGE_BINS[i].test(y)) return AGE_BINS[i];
    return AGE_UNKNOWN;
  }

  function currentDemo() {
    return state.selected && state.demos[state.selected] ? state.demos[state.selected] : null;
  }

  function styleFor(feature) {
    var p = feature.properties;
    var demo = currentDemo();
    var fill, alpha = 0.85;
    if (demo) {
      var r = Judge.judge(p, demo.rule);
      fill = STATUS_COLOR[r.status];
      if (r.reason.indexOf("속성 없음") === 0) alpha = 0.3; // 판정불가 중 속성 없음은 옅게
    } else {
      fill = ageBin(p).color;
    }
    return { color: "#334155", weight: 0.4, opacity: 0.6, fillColor: fill, fillOpacity: alpha };
  }

  function dateText(d) {
    if (Judge.isEmpty(d)) return "-";
    d = String(d);
    return d.length >= 8 ? d.slice(0, 4) + "." + d.slice(4, 6) + "." + d.slice(6, 8) : d;
  }
  function val(v, unit) {
    return Judge.isEmpty(v) ? '<span class="muted">정보 없음</span>' : esc(v) + (unit || "");
  }

  function buildingCard(p) {
    var demo = currentDemo();
    var rows = [
      ["주용도 코드", val(p.usability)],
      ["연면적", Judge.isEmpty(p.totalarea) ? val(null) : fmt(p.totalarea) + "㎡"],
      ["지상층수", val(p.grnd_flr, "층")],
      ["사용승인일", Judge.isEmpty(p.useapr_day) ? val(null) : dateText(p.useapr_day)],
      ["구조 코드", val(p.strct_cd)],
      ["PNU", val(p.pnu)],
    ];
    var html = '<div class="bcard"><h4>건물 속성</h4><table>' +
      rows.map(function (r) { return "<tr><th>" + r[0] + "</th><td>" + r[1] + "</td></tr>"; }).join("") +
      "</table>";
    if (demo) {
      var r = Judge.judge(p, demo.rule);
      html += '<div class="verdict"><b style="color:' + STATUS_COLOR[r.status] + '">' + r.status +
        "</b> · " + esc(r.reason) + "</div>";
    }
    return html + "</div>";
  }

  function renderLegend() {
    var demo = currentDemo();
    var html;
    if (demo) {
      var c = Judge.countAll(state.props, demo.rule).counts;
      html = "<h4>판정 결과</h4>" + Judge.STATUSES.map(function (s) {
        return '<div class="row" title="' + STATUS_DESC[s] + '"><span class="sw" style="background:' +
          STATUS_COLOR[s] + '"></span>' + s + '<span class="n">' + fmt(c[s]) + "동</span></div>";
      }).join("") + '<div class="row muted small"><span class="sw" style="background:' + STATUS_COLOR.판정불가 +
        ';opacity:.3"></span>옅은 색: 속성 없음</div>';
    } else {
      var counts = new Map();
      state.props.forEach(function (p) { var b = ageBin(p); counts.set(b, (counts.get(b) || 0) + 1); });
      html = "<h4>사용승인 연도 (노후도)</h4>" + AGE_BINS.concat([AGE_UNKNOWN]).map(function (b) {
        return '<div class="row"><span class="sw" style="background:' + b.color + '"></span>' + b.label +
          '<span class="n">' + fmt(counts.get(b) || 0) + "</span></div>";
      }).join("");
    }
    $("legend").innerHTML = html;
  }

  function restyle() {
    if (state.buildings) state.buildings.setStyle(styleFor);
    renderLegend();
  }

  // ---------------------------------------------------------------- 패널
  function renderFields() {
    var cnt = {};
    state.bills.forEach(function (b) { cnt[b.field] = (cnt[b.field] || 0) + 1; });
    var keys = Object.keys(state.fields);
    $("field-list").innerHTML = keys.map(function (k) {
      return '<label title="' + esc(state.fields[k]) + '"><input type="checkbox" value="' + k + '"' +
        (state.checked.has(Number(k)) ? " checked" : "") + '><span class="fname">' + k + ". " +
        esc(state.fields[k]) + '</span><span class="fcnt">' + (cnt[k] || 0) + "</span></label>";
    }).join("");
  }

  function filteredBills() {
    var q = state.query.trim().toLowerCase();
    return state.bills.filter(function (b) {
      if (!state.checked.has(b.field)) return false;
      if (!q) return true;
      return (b.name + " " + b.no + " " + b.summary + " " + b.committee).toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderBills() {
    var list = filteredBills();
    $("bill-count").textContent = "법안 " + fmt(list.length) + "건 / 전체 " + fmt(state.bills.length) + "건";
    // 판정 시범 법안을 맨 위로
    list.sort(function (a, b) { return (state.demos[b.no] ? 1 : 0) - (state.demos[a.no] ? 1 : 0); });
    $("bill-list").innerHTML = list.map(function (b) {
      var badges = "";
      if (state.demos[b.no]) badges += '<span class="badge demo">판정 시범</span>';
      if (b.conf !== null && b.conf < CONF_LOW) badges += '<span class="badge uncertain" title="분류 확신도 ' + b.conf + '">분야 불확실</span>';
      return '<li tabindex="0" data-no="' + b.no + '"' + (state.selected === b.no ? ' class="active"' : "") + ">" +
        '<div class="b-name">' + esc(b.name) + "</div>" +
        '<div class="b-meta"><span>' + esc(b.date) + "</span><span>" + esc(b.committee) + "</span>" +
        '<span class="badge">' + esc(state.fields[b.field] || "미분류") + "</span>" + badges + "</div></li>";
    }).join("") || '<li class="muted">조건에 맞는 법안이 없습니다.</li>';
  }

  function ruleText(rule) {
    return JSON.stringify(rule).replace(/,"/g, ', "').replace(/:/g, ": ");
  }

  function renderDetail() {
    var el = $("detail");
    var b = state.bills.find(function (x) { return x.no === state.selected; });
    if (!b) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    var demo = state.demos[b.no];
    var html = '<button class="close" type="button" aria-label="닫기">×</button>' +
      "<h3>" + esc(b.name) + "</h3>" +
      '<div class="b-meta"><span>의안번호 ' + esc(b.no) + "</span><span>" + esc(b.date) + "</span><span>" +
      esc(b.committee) + '</span><span class="badge">' + esc(state.fields[b.field] || "미분류") +
      (b.conf !== null ? " · 확신도 " + b.conf.toFixed(2) : "") + "</span>" +
      (b.conf !== null && b.conf < CONF_LOW ? '<span class="badge uncertain">분야 불확실</span>' : "") + "</div>";

    if (demo) {
      var res = Judge.countAll(state.props, demo.rule);
      var c = res.counts;
      var reasonLines = Object.keys(res.reasons).filter(function (k) { return k.indexOf("판정불가|") === 0; })
        .map(function (k) { return k.split("|")[1] + " " + fmt(res.reasons[k]) + "동"; }).join(" · ");
      html += '<div class="judge-box"><h4>판정 시범 (사창동 ' + fmt(state.props.length) + "동)</h4>" +
        '<div class="quote">' + esc(demo.source_text) + "</div>" +
        '<div class="rule">' + esc(ruleText(demo.rule)) + "</div>" +
        '<div class="counts">' + Judge.STATUSES.map(function (s) {
          return '<div><b>' + fmt(c[s]) + '</b><span><i style="background:' + STATUS_COLOR[s] + '"></i>' + s + "</span></div>";
        }).join("") + "</div>" +
        '<p class="conclusion">' + esc(demo.conclusion) + "</p>" +
        (reasonLines ? '<p class="note">판정불가 내역: ' + esc(reasonLines) + "</p>" : "") +
        '<p class="note">' + esc(demo.rule_note) + "</p></div>";
    } else {
      html += '<p class="pending">이 법안은 아직 적용 기준(용도·면적·층수·연도)을 추출하지 않았습니다. 지도는 노후도 색으로 표시합니다.</p>';
    }
    html += '<p class="summary">' + esc(b.summary) + "</p>" +
      '<a href="' + esc(b.link) + '" target="_blank" rel="noopener">의안정보시스템에서 원문 보기 ↗</a>';
    el.innerHTML = html;
    el.classList.remove("hidden");
    el.querySelector(".close").addEventListener("click", function () { select(null); });
  }

  function select(no) {
    state.selected = state.selected === no ? null : no;
    renderBills();
    renderDetail();
    restyle();
    if (state.selected && window.matchMedia("(max-width: 760px)").matches) {
      $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // ---------------------------------------------------------------- 이벤트
  $("field-list").addEventListener("change", function (e) {
    var v = Number(e.target.value);
    if (e.target.checked) state.checked.add(v); else state.checked.delete(v);
    renderBills();
  });
  $("f-all").addEventListener("click", function () {
    Object.keys(state.fields).forEach(function (k) { state.checked.add(Number(k)); });
    state.checked.add(null);
    renderFields(); renderBills();
  });
  $("f-none").addEventListener("click", function () {
    state.checked.clear();
    renderFields(); renderBills();
  });
  $("search").addEventListener("input", function (e) { state.query = e.target.value; renderBills(); });
  $("bill-list").addEventListener("click", function (e) {
    var li = e.target.closest("li[data-no]");
    if (li) select(li.getAttribute("data-no"));
  });
  $("bill-list").addEventListener("keydown", function (e) {
    var li = e.target.closest("li[data-no]");
    if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); select(li.getAttribute("data-no")); }
  });

  // ---------------------------------------------------------------- 시작
  function getJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + " " + r.status);
      return r.json();
    });
  }

  Promise.all([
    getJSON("data/buildings.geojson"),
    getJSON("data/boundary.geojson"),
    getJSON("data/bills.json"),
    getJSON("data/demo_rules.json"),
  ]).then(function (res) {
    var bldg = res[0], bnd = res[1], bills = res[2], demo = res[3];

    state.fields = bills.fields;
    state.bills = bills.bills;
    Object.keys(state.fields).forEach(function (k) { state.checked.add(Number(k)); });
    state.checked.add(null); // 분야 예측이 없는 법안
    demo.demos.forEach(function (d) { state.demos[d.bill_no] = d; });
    state.props = bldg.features.map(function (f) { return f.properties; });
    $("bldg-total").textContent = "· 건물 " + fmt(state.props.length) + "동";

    var boundary = L.geoJSON(bnd, {
      interactive: false,
      style: { color: "#1f4fa3", weight: 2.5, dashArray: "6 4", fill: false },
    }).addTo(map);
    state.buildings = L.geoJSON(bldg, {
      style: styleFor,
      onEachFeature: function (f, layer) {
        layer.on("click", function (e) {
          L.popup({ maxWidth: 260 }).setLatLng(e.latlng).setContent(buildingCard(f.properties)).openOn(map);
        });
      },
    }).addTo(map);
    map.fitBounds(boundary.getBounds(), { padding: [12, 12] });

    renderFields();
    renderBills();
    renderLegend();
    selfCheck();
  }).catch(function (err) {
    console.error(err);
    $("bill-list").innerHTML = '<li class="muted">데이터를 불러오지 못했습니다: ' + esc(err.message) + "</li>";
  });

  // 판정 시범 2건의 동수가 중간보고 숫자(build_web_data.py 결과)와 같은지 콘솔에서 확인
  function selfCheck() {
    console.group("[법안 영향 지도] 판정 시범 동수 확인");
    Object.keys(state.demos).forEach(function (no) {
      var d = state.demos[no];
      var got = Judge.countAll(state.props, d.rule).counts;
      var ok = Judge.STATUSES.every(function (s) { return got[s] === d.counts[s]; });
      console.log((ok ? "✅ 일치" : "❌ 불일치") + " " + no + " " + d.title, { judge_js: got, expected: d.counts });
      if (no === "2220631") {
        var maxArea = Math.max.apply(null, state.props.map(function (p) { return Number(p.totalarea) || 0; }));
        console.log("   사창동 최대 연면적 " + fmt(Math.round(maxArea)) + "㎡ (기대 34,703㎡) · 대상 " + got.대상 + "동 · 경계선 " + got.경계선 + "동");
      }
      if (no === "2220895") {
        var n2 = state.props.filter(function (p) { return !Judge.isEmpty(p.grnd_flr) && p.grnd_flr >= 2; }).length;
        console.log("   2층 이상 후보 " + fmt(n2) + "동 (기대 1,836동) → 시행령 위임으로 판정불가");
      }
    });
    console.groupEnd();
  }
})();
