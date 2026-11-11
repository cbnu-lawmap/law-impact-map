/* 빼곡 — 화면 로직 (브이월드 3D 지도, 실패 시 MapLibre GL JS 3D, 빌드 도구 없음) */
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
    buildings: null,   // 지도용 FeatureCollection (_i, _h, _color)
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
  // 브이월드 API 키가 들어 있으면 브이월드 3D 지도, 없거나 실패하면 기본 3D 지도(MapLibre)
  var FLOOR_M = 3;        // 층당 높이 가정 (m), 기본 지도와 브이월드 덧칠 미지원 시 사용
  var NO_FLOOR_M = 1.5;   // 층수 정보가 없는 건물은 낮게
  var VIEW_3D = { pitch: 55, bearing: -20 };
  var engine = null;      // "vworld" | "basic"
  var map = null;         // MapLibre 지도 (기본 지도일 때)
  var vmap = null;        // 브이월드 지도

  // 스크립트·스타일을 필요할 때만 불러온다 (브이월드 지도일 때는 MapLibre 를 받지 않음)
  function loadAsset(tag, attrs) {
    return new Promise(function (resolve, reject) {
      var el = document.createElement(tag);
      Object.keys(attrs).forEach(function (k) { el[k] = attrs[k]; });
      el.onload = resolve;
      el.onerror = function () { reject(new Error((attrs.src || attrs.href) + " 불러오기 실패")); };
      document.head.appendChild(el);
    });
  }
  var MAPLIBRE = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl";
  function loadMapLibre() {
    if (window.maplibregl) return Promise.resolve();
    return Promise.all([
      loadAsset("link", { rel: "stylesheet", href: MAPLIBRE + ".css" }),
      loadAsset("script", { src: MAPLIBRE + ".js" }),
    ]);
  }

  // 지도 종류 (브이월드 키가 있을 때)
  //   기본        브이월드 항공사진 + 층수 높이 상자 건물 (가벼움)
  //   ?map=real  브이월드 실제 3D 건물 모델 + 바닥면 색 덧칠 (무거움)
  //   ?map=basic MapLibre 흑백 지도 + 상자 건물 (브이월드를 받지 않음)
  var wantBasic = /[?&]map=basic(&|$)/.test(location.search);
  var wantReal = /[?&]map=real(&|$)/.test(location.search);
  if (window.vw && window.vw.Map && window.VWorldMap && !wantBasic) {
    // 데이터를 받는 동안 브이월드 지도를 먼저 띄운다
    engine = "vworld";
    vmap = VWorldMap.create({
      mapId: "map",
      realModels: wantReal,
      onPick: showVWorldPopup,
      onMove: function () { var p = document.querySelector(".lm-popup"); if (p) p.remove(); },
    });
  }

  function createBasicMap() {
    map = new maplibregl.Map({
      container: "map",
      // 바탕지도: 키가 필요 없는 OpenStreetMap 표준 타일 (흑백 처리)
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            maxzoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 기여자 · 건물: 브이월드 건물통합정보',
          },
        },
        layers: [{
          id: "osm", type: "raster", source: "osm",
          paint: { "raster-saturation": -1, "raster-contrast": -0.15, "raster-brightness-min": 0.08 },
        }],
      },
      center: [127.462, 36.6345],
      zoom: 15,
      pitch: VIEW_3D.pitch,
      bearing: VIEW_3D.bearing,
      maxPitch: 75,
      attributionControl: { compact: false },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
    map.addControl(new ViewToggle(), "top-left");

    // 바탕지도 타일을 다 받기(load) 전에 건물부터 올린다.
    // 스타일을 객체로 넘기면 style.load 가 생성자 안에서 이미 끝날 수 있어 내부 플래그도 확인한다.
    // (isStyleLoaded()는 타일 로딩 중이면 false 라서 쓸 수 없음)
    return new Promise(function (resolve) {
      if (map.style && map.style._loaded) resolve(); else map.once("style.load", resolve);
    });
  }

  // 2D / 3D 전환 버튼 (기본 지도)
  function ViewToggle() {}
  ViewToggle.prototype.onAdd = function () {
    var div = document.createElement("div");
    div.className = "maplibregl-ctrl maplibregl-ctrl-group view-toggle";
    div.innerHTML = '<button type="button" title="2D/3D 전환" aria-label="2D/3D 전환">2D</button>';
    var btn = div.firstChild;
    btn.addEventListener("click", function () {
      var flat = map.getPitch() > 5;
      map.easeTo(flat ? { pitch: 0, bearing: 0 } : VIEW_3D);
    });
    map.on("pitchend", function () { btn.textContent = map.getPitch() > 5 ? "2D" : "3D"; });
    return div;
  };
  ViewToggle.prototype.onRemove = function () {};

  function startMap(bnd) {
    renderEngineToggle();
    if (vmap) {
      renderLegend();
      return vmap.ready.then(function () {
        vmap.add(state.buildings, bnd,
          function (i) { return state.buildings.features[i].properties._color; },
          function (i) { return state.buildings.features[i].properties._h; });
        renderLegend();
      }).catch(function (err) {
        console.warn("브이월드 3D 지도를 쓰지 못해 기본 3D 지도로 표시합니다:", err.message);
        vmap = null;
        $("map").innerHTML = "";
        return startBasic(bnd);
      });
    }
    return startBasic(bnd);
  }

  function startBasic(bnd) {
    engine = "basic";
    renderLegend();
    renderEngineToggle();
    return loadMapLibre().then(createBasicMap).then(function () { addLayers(bnd); });
  }

  // 지도 종류 전환 링크. 브이월드 키가 있을 때만 보인다
  function renderEngineToggle() {
    if (!window.VWORLD_ON) return;
    var old = document.querySelector(".engine-toggle");
    if (old) old.remove();
    var here = engine !== "vworld" ? "basic" : wantReal ? "real" : "box";
    var links = {
      box: ["", "항공사진 지도로 보기", "브이월드 항공사진 위에 층수 높이로 세운 건물 (기본)"],
      real: ["?map=real", "실제 건물 모델 보기", "브이월드 실제 3D 건물 모델 (무거움, 컴퓨터 사양이 필요)"],
      basic: ["?map=basic", "가벼운 지도로 보기", "느릴 때: 흑백 지도 위 층수 높이 건물"],
    };
    var div = document.createElement("div");
    div.className = "engine-toggle";
    ["box", "real", "basic"].forEach(function (k) {
      if (k === here) return;
      var a = document.createElement("a");
      a.href = location.pathname + links[k][0];
      a.textContent = links[k][1];
      a.title = links[k][2];
      div.appendChild(a);
    });
    $("map").parentNode.appendChild(div);
  }

  // 브이월드 지도의 건물 속성 카드
  function showVWorldPopup(i, pos) {
    var old = document.querySelector(".lm-popup");
    if (old) old.remove();
    if (i === null) return;
    var div = document.createElement("div");
    div.className = "lm-popup";
    div.innerHTML = '<button type="button" class="close" aria-label="닫기">×</button>' + buildingCard(state.props[i]);
    $("map").parentNode.appendChild(div);
    var wrap = $("map").getBoundingClientRect();
    var w = div.offsetWidth, h = div.offsetHeight;
    div.style.left = Math.max(8, Math.min(pos.x + 12, wrap.width - w - 8)) + "px";
    div.style.top = Math.max(8, Math.min(pos.y - h / 2, wrap.height - h - 8)) + "px";
    div.querySelector(".close").addEventListener("click", function () { div.remove(); });
  }

  function heightOf(p) {
    return Judge.isEmpty(p.grnd_flr) ? NO_FLOOR_M : Number(p.grnd_flr) * FLOOR_M;
  }
  // 색을 흰색 쪽으로 섞어 옅게 (fill-extrusion 은 건물별 투명도를 줄 수 없어서)
  function fade(hex, t) {
    var n = parseInt(hex.slice(1), 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var mix = function (c) { return Math.round(c + (255 - c) * t); };
    return "rgb(" + mix(r) + "," + mix(g) + "," + mix(b) + ")";
  }

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

  function colorFor(p) {
    var demo = currentDemo();
    if (!demo) return ageBin(p).color;
    var r = Judge.judge(p, demo.rule);
    // 판정불가 중 속성 없음은 옅게
    return r.reason.indexOf("속성 없음") === 0 ? fade(STATUS_COLOR[r.status], 0.65) : STATUS_COLOR[r.status];
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
    if (engine === "vworld") {
      html += '<div class="row muted small legend-note">' +
        (vmap && vmap.classify() ? "건물: 브이월드 3D 모델 · 색: 바닥면 기준" : "높이: 지상층수 × " + FLOOR_M + "m (추정)") + "</div>";
    } else {
      html += '<div class="row muted small legend-note">높이: 지상층수 × ' + FLOOR_M + "m (추정)</div>";
    }
    $("legend").innerHTML = html;
  }

  var colorKey = null;   // 지금 칠한 색 기준 (노후도 / 판정 시범 번호)
  function restyle() {
    var key = currentDemo() ? state.selected : "age";
    if (key === colorKey) { renderLegend(); return; }
    colorKey = key;
    if (state.buildings) {
      state.buildings.features.forEach(function (f) {
        f.properties._color = colorFor(state.props[f.properties._i]);
      });
      if (engine === "vworld" && vmap) {
        vmap.recolor(function (i) { return state.buildings.features[i].properties._color; });
      } else if (map) {
        var src = map.getSource("bldg");
        if (src) src.setData(state.buildings);
      }
    }
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
      return b._q.indexOf(q) >= 0;
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
  var searchTimer = null;
  $("search").addEventListener("input", function (e) {
    state.query = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderBills, 120);
  });
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
    state.bills.forEach(function (b) { b._q = (b.name + " " + b.no + " " + b.summary + " " + b.committee).toLowerCase(); });
    Object.keys(state.fields).forEach(function (k) { state.checked.add(Number(k)); });
    state.checked.add(null); // 분야 예측이 없는 법안
    demo.demos.forEach(function (d) { state.demos[d.bill_no] = d; });
    state.props = bldg.features.map(function (f) { return f.properties; });
    $("bldg-total").textContent = "· 건물 " + fmt(state.props.length) + "동";

    // 지도용 사본: 원래 속성은 state.props 에 두고, 지도에는 번호·높이·색만 싣는다
    state.buildings = {
      type: "FeatureCollection",
      features: bldg.features.map(function (f, i) {
        return { type: "Feature", geometry: f.geometry,
          properties: { _i: i, _h: heightOf(f.properties), _color: colorFor(f.properties) } };
      }),
    };

    colorKey = "age";
    renderFields();
    renderBills();
    renderLegend();
    selfCheck();

    return startMap(bnd);
  }).catch(function (err) {
    console.error(err);
    $("bill-list").innerHTML = '<li class="muted">데이터를 불러오지 못했습니다: ' + esc(err.message) + "</li>";
  });

  function addLayers(bnd) {
    map.addSource("bldg", { type: "geojson", data: state.buildings });
    map.addSource("boundary", { type: "geojson", data: bnd });
    map.addLayer({
      id: "bldg", type: "fill-extrusion", source: "bldg",
      paint: {
        "fill-extrusion-color": ["get", "_color"],
        "fill-extrusion-height": ["get", "_h"],
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0.9,
        "fill-extrusion-vertical-gradient": true,
      },
    });
    map.addLayer({
      id: "boundary", type: "line", source: "boundary",
      paint: { "line-color": "#1f4fa3", "line-width": 2.5, "line-dasharray": [3, 2] },
    });

    // 경계에 맞춰 보기
    var b = new maplibregl.LngLatBounds();
    (function walk(c) { if (typeof c[0] === "number") b.extend(c); else c.forEach(walk); })(
      bnd.features[0].geometry.coordinates);
    map.fitBounds(b, { padding: 30, pitch: VIEW_3D.pitch, bearing: VIEW_3D.bearing, duration: 0 });

    map.on("click", "bldg", function (e) {
      var p = state.props[e.features[0].properties._i];
      new maplibregl.Popup({ maxWidth: "260px" }).setLngLat(e.lngLat).setHTML(buildingCard(p)).addTo(map);
    });
    map.on("mouseenter", "bldg", function () { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "bldg", function () { map.getCanvas().style.cursor = ""; });
  }

  // 판정 시범 2건의 동수가 중간보고 숫자(build_web_data.py 결과)와 같은지 콘솔에서 확인
  function selfCheck() {
    console.group("[빼곡] 판정 시범 동수 확인");
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
