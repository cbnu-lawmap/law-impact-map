/*
 * 빼곡 — 행정 화면 (1단계: 상황판 · 법안 검토 목록 · 법안별 집계와 건물 명부 · 검토서 인쇄)
 *
 * 빌드 도구 없는 정적 페이지. 주소의 # 뒤로 화면을 나눈다.
 *   #/              상황판
 *   #/bills         법안 검토 목록
 *   #/bill/번호      법안별 집계 · 건물 명부
 *   #/print/번호     검토서 (A4 인쇄)
 *   #/sources       데이터·한계
 * 로그인·서버 저장이 없다. 검토서의 부서·작성자 입력만 이 브라우저(localStorage)에 남는다.
 */
(function () {
  "use strict";

  var STATUSES = Judge.STATUSES; // 대상, 경계선, 비대상, 판정불가
  var PAGE = 50;
  // 건축물대장 주용도 코드(대분류). 데이터에는 코드만 있어 이름은 화면에서 붙인다.
  var USE_NAMES = {
    "01000": "단독주택", "02000": "공동주택", "03000": "제1종근린생활시설", "04000": "제2종근린생활시설",
    "05000": "문화및집회시설", "06000": "종교시설", "07000": "판매시설", "08000": "운수시설",
    "09000": "의료시설", "10000": "교육연구시설", "11000": "노유자시설", "12000": "수련시설",
    "13000": "운동시설", "14000": "업무시설", "15000": "숙박시설", "16000": "위락시설",
    "17000": "공장", "18000": "창고시설", "19000": "위험물저장및처리시설", "20000": "자동차관련시설",
    "21000": "동물및식물관련시설", "22000": "자원순환관련시설", "23000": "교정및군사시설",
    "24000": "방송통신시설", "25000": "발전시설", "26000": "묘지관련시설", "27000": "관광휴게시설",
    "28000": "장례시설",
  };

  var D = { fields: {}, bills: [], byNo: {}, demos: {}, region: "", props: null, judged: {} };
  var ui = {
    bills: { q: "", field: "", committee: "", status: "", sort: "date", dir: -1, page: 0 },
    roster: { tab: "", page: 0 },
  };
  var $view = document.getElementById("view");

  // ---------------------------------------------------------------- 도구
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmt(n) { return Number(n).toLocaleString("ko-KR"); }
  function pct(n, total) { return total ? (n / total * 100).toFixed(1) + "%" : "-"; }
  function ymd(s) {
    s = String(s || "").replace(/-/g, "");
    return s.length >= 8 ? s.slice(0, 4) + "." + s.slice(4, 6) + "." + s.slice(6, 8) : "";
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + String(d.getDate()).padStart(2, "0");
  }
  function useName(code) {
    if (!code) return "(없음)";
    return (USE_NAMES[code] || "코드") + " " + code;
  }
  function fieldName(f) { return f == null ? "미분류" : D.fields[f] || "미분류"; }
  function getJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + " " + r.status);
      return r.json();
    });
  }
  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem("ppaegok." + key) || "";
      localStorage.setItem("ppaegok." + key, val);
    } catch (e) { return ""; }
  }

  // CSV 내려받기 (엑셀에서 한글이 깨지지 않게 BOM을 붙인다)
  function downloadCSV(name, header, rows) {
    var cell = function (v) {
      v = v == null ? "" : String(v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    var text = "﻿" + [header].concat(rows).map(function (r) { return r.map(cell).join(","); }).join("\r\n");
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  function statusBar(counts, total) {
    return '<div class="sbar" title="' + STATUSES.map(function (s) { return s + " " + fmt(counts[s]); }).join(" · ") + '">' +
      STATUSES.map(function (s) {
        return counts[s] ? '<i class="s-' + s + '" style="width:' + (counts[s] / total * 100) + '%"></i>' : "";
      }).join("") + "</div>";
  }

  // 건물 데이터는 법안 상세·검토서에서만 필요하므로 그때 받는다
  var propsPromise = null;
  function loadProps() {
    if (!propsPromise) {
      propsPromise = getJSON("data/buildings.geojson").then(function (g) {
        D.props = g.features.map(function (f) { return f.properties; });
        return D.props;
      });
    }
    return propsPromise;
  }

  // 법안 1건 판정: 건물마다 결과를 계산해 둔다 (같은 법안은 한 번만)
  function judgeBill(no) {
    if (D.judged[no]) return D.judged[no];
    var demo = D.demos[no];
    var rows = D.props.map(function (p) {
      var r = Judge.judge(p, demo.rule);
      return { p: p, status: r.status, reason: r.reason };
    });
    var counts = {}, reasons = {};
    STATUSES.forEach(function (s) { counts[s] = 0; });
    rows.forEach(function (r) {
      counts[r.status]++;
      var k = r.status + "|" + r.reason;
      reasons[k] = (reasons[k] || 0) + 1;
    });
    // 미리 계산해 둔 동수(demo_rules.json)와 화면 계산이 같은지 대조
    var match = STATUSES.every(function (s) { return demo.counts[s] === counts[s]; });
    D.judged[no] = { rows: rows, counts: counts, reasons: reasons, match: match };
    return D.judged[no];
  }

  function ruleText(rule) {
    var out = [];
    if (rule.용도) out.push("주용도: " + rule.용도.map(useName).join(", "));
    ["연면적", "층수"].forEach(function (k) {
      var r = rule[k];
      if (!r) return;
      var unit = k === "연면적" ? "㎡" : "층";
      if (r.min !== undefined) out.push(k + " " + fmt(r.min) + unit + " 이상");
      if (r.max !== undefined) out.push(k + " " + fmt(r.max) + unit + " 이하");
    });
    if (rule.사용승인) out.push("사용승인 " + ymd(rule.사용승인.before) + " 이전");
    if (rule.위임 && rule.위임.length) out.push("시행령 위임: " + rule.위임.join("·") + " (확정 불가)");
    return out;
  }

  // ---------------------------------------------------------------- 화면: 상황판
  function viewHome() {
    var judgedNos = Object.keys(D.demos);
    var waiting = D.bills.length - judgedNos.length;
    var fieldCnt = {};
    D.bills.forEach(function (b) { fieldCnt[b.field] = (fieldCnt[b.field] || 0) + 1; });
    var maxField = Math.max.apply(null, Object.keys(fieldCnt).map(function (k) { return fieldCnt[k]; }));
    var recent = D.bills.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; }).slice(0, 6);

    var html = '<h2>상황판</h2><p class="lead">' + esc(D.region) + " 기준 · 국회 계류 법안이 우리 동네 건물에 미치는 영향</p>";
    html += '<div class="kpis">' +
      kpi("계류 법안", fmt(D.bills.length) + "건", "22대 국회 · 건축·주거·안전 분야") +
      kpi("판정한 법안", fmt(judgedNos.length) + "건", "적용 기준을 사람이 추출한 시범") +
      kpi("기준 추출 대기", fmt(waiting) + "건", "AI 기준 추출 단계에서 판정 예정", true) +
      kpi("사창동 건물", fmt(D.total) + "동", "브이월드 건물통합정보") +
      "</div>";

    html += "<h3>판정한 법안</h3>";
    html += '<div class="table-wrap"><table class="dt"><thead><tr><th>의안번호</th><th>법안</th>' +
      STATUSES.map(function (s) { return '<th class="num">' + s + "</th>"; }).join("") +
      "<th>분포</th><th></th></tr></thead><tbody>";
    judgedNos.forEach(function (no) {
      var d = D.demos[no], b = D.byNo[no];
      html += "<tr><td>" + esc(no) + '</td><td class="title"><a href="#/bill/' + no + '">' + esc(b ? b.name : no) +
        '</a><div class="muted small">' + esc(d.title) + "</div></td>" +
        STATUSES.map(function (s) { return '<td class="num">' + fmt(d.counts[s]) + "</td>"; }).join("") +
        "<td>" + statusBar(d.counts, D.total) + '</td><td><a class="btn ghost" href="#/print/' + no + '">검토서</a></td></tr>';
    });
    html += "</tbody></table></div>";

    html += '<div class="grid2" style="margin-top:16px">';
    html += '<div class="card"><h3 style="margin-top:0">분야별 계류 법안</h3><table class="dt"><tbody>' +
      Object.keys(fieldCnt).sort(function (a, b) { return fieldCnt[b] - fieldCnt[a]; }).map(function (k) {
        var f = k === "null" ? null : Number(k);
        return '<tr><td><a href="#/bills" data-field="' + esc(k) + '">' + esc(fieldName(f)) + '</a></td><td class="num">' +
          fmt(fieldCnt[k]) + '건</td><td style="width:45%"><div class="sbar"><i style="width:' +
          (fieldCnt[k] / maxField * 100) + '%;background:var(--accent)"></i></div></td></tr>';
      }).join("") + "</tbody></table></div>";
    html += '<div class="card"><h3 style="margin-top:0">최근 제안 법안</h3><table class="dt"><tbody>' +
      recent.map(function (b) {
        return '<tr><td class="title"><a href="#/bill/' + b.no + '">' + esc(b.name) + '</a><div class="muted small">' +
          esc(b.committee) + " · " + esc(fieldName(b.field)) + '</div></td><td class="num muted">' + esc(b.date) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    html += "</div>";
    $view.innerHTML = html;

    $view.querySelectorAll("a[data-field]").forEach(function (a) {
      a.addEventListener("click", function () {
        ui.bills.field = a.getAttribute("data-field");
        ui.bills.page = 0;
      });
    });
  }

  function kpi(label, value, sub, alert) {
    return '<div class="kpi' + (alert ? " alert" : "") + '"><div class="label">' + esc(label) + '</div><div class="value">' +
      esc(value) + '</div><div class="sub">' + esc(sub) + "</div></div>";
  }

  // ---------------------------------------------------------------- 화면: 법안 검토 목록
  function filteredBills() {
    var s = ui.bills, q = s.q.trim().toLowerCase();
    var list = D.bills.filter(function (b) {
      if (s.field !== "" && String(b.field) !== s.field) return false;
      if (s.committee && b.committee !== s.committee) return false;
      if (s.status === "done" && !D.demos[b.no]) return false;
      if (s.status === "wait" && D.demos[b.no]) return false;
      if (q && b._q.indexOf(q) < 0) return false;
      return true;
    });
    var key = s.sort, dir = s.dir;
    var val = function (b) {
      if (key === "impact") {
        var d = D.demos[b.no];
        return d ? d.counts.대상 + d.counts.경계선 + (d.counts.판정불가 / 1e6) : -1;
      }
      if (key === "field") return fieldName(b.field);
      return b[key] || "";
    };
    list.sort(function (a, b) {
      var x = val(a), y = val(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir || (a.no < b.no ? 1 : -1);
    });
    return list;
  }

  function viewBills() {
    var s = ui.bills;
    var committees = Array.from(new Set(D.bills.map(function (b) { return b.committee; }))).sort();
    var fieldKeys = Object.keys(D.fields);
    var html = '<h2>법안 검토 목록</h2><p class="lead">계류 법안 ' + fmt(D.bills.length) +
      "건. 판정한 법안은 사창동 건물 동수가 함께 나옵니다.</p>";
    html += '<div class="toolbar no-print">' +
      '<input type="search" id="f-q" placeholder="법안명·번호·제안이유 검색" value="' + esc(s.q) + '">' +
      '<select id="f-field"><option value="">분야 전체</option>' + fieldKeys.map(function (k) {
        return '<option value="' + k + '"' + (s.field === k ? " selected" : "") + ">" + esc(D.fields[k]) + "</option>";
      }).join("") + '<option value="null"' + (s.field === "null" ? " selected" : "") + ">미분류</option></select>" +
      '<select id="f-com"><option value="">위원회 전체</option>' + committees.map(function (c) {
        return '<option' + (s.committee === c ? " selected" : "") + ">" + esc(c) + "</option>";
      }).join("") + "</select>" +
      '<select id="f-status"><option value="">판정 전체</option><option value="done"' + (s.status === "done" ? " selected" : "") +
      '>판정한 법안</option><option value="wait"' + (s.status === "wait" ? " selected" : "") + ">기준 추출 대기</option></select>" +
      '<span class="spacer"></span><span class="muted small" id="f-count"></span>' +
      '<button type="button" class="btn ghost" id="f-csv">CSV 내려받기</button></div>';
    html += '<div class="table-wrap" id="bill-table"></div>';
    $view.innerHTML = html;

    var debounce = null;
    document.getElementById("f-q").addEventListener("input", function (e) {
      clearTimeout(debounce);
      debounce = setTimeout(function () { s.q = e.target.value; s.page = 0; drawBillTable(); }, 150);
    });
    [["f-field", "field"], ["f-com", "committee"], ["f-status", "status"]].forEach(function (p) {
      document.getElementById(p[0]).addEventListener("change", function (e) { s[p[1]] = e.target.value; s.page = 0; drawBillTable(); });
    });
    document.getElementById("f-csv").addEventListener("click", function () {
      downloadCSV("빼곡_법안검토목록_" + today().replace(/\./g, "") + ".csv",
        ["의안번호", "법안명", "소관위원회", "제안일", "분야(자동 분류)", "분류 확신도", "판정", "대상", "경계선", "비대상", "판정불가", "의안정보시스템"],
        filteredBills().map(function (b) {
          var d = D.demos[b.no];
          return [b.no, b.name, b.committee, b.date, fieldName(b.field), b.conf, d ? "판정함" : "기준 추출 대기"]
            .concat(d ? STATUSES.map(function (st) { return d.counts[st]; }) : ["", "", "", ""]).concat([b.link]);
        }));
    });
    drawBillTable();
  }

  function drawBillTable() {
    var s = ui.bills, list = filteredBills();
    var pages = Math.max(1, Math.ceil(list.length / PAGE));
    if (s.page >= pages) s.page = pages - 1;
    var rows = list.slice(s.page * PAGE, s.page * PAGE + PAGE);
    var th = function (key, label, cls) {
      var arrow = s.sort === key ? ' <span class="arrow">' + (s.dir > 0 ? "▲" : "▼") + "</span>" : "";
      return '<th data-sort="' + key + '"' + (cls ? ' class="' + cls + '"' : "") + ">" + label + arrow + "</th>";
    };
    var html = '<table class="dt"><thead><tr>' + th("no", "의안번호") + th("name", "법안명") + th("committee", "위원회") +
      th("date", "제안일") + th("field", "분야") + th("impact", "사창동 영향") + "</tr></thead><tbody>";
    html += rows.map(function (b) {
      var d = D.demos[b.no];
      var impact = d
        ? '<span class="tag done">판정함</span> <span class="small">대상 ' + fmt(d.counts.대상) + " · 경계선 " + fmt(d.counts.경계선) +
          " · 판정불가 " + fmt(d.counts.판정불가) + "</span>"
        : '<span class="tag wait">기준 추출 대기</span>';
      return "<tr><td>" + esc(b.no) + '</td><td class="title"><a href="#/bill/' + b.no + '">' + esc(b.name) + "</a></td><td>" +
        esc(b.committee) + '</td><td class="num">' + esc(b.date) + "</td><td>" + esc(fieldName(b.field)) + "</td><td>" + impact + "</td></tr>";
    }).join("") || '<tr><td colspan="6" class="muted">조건에 맞는 법안이 없습니다.</td></tr>';
    html += "</tbody></table>" + pager(s.page, pages, list.length);
    var box = document.getElementById("bill-table");
    box.innerHTML = html;
    document.getElementById("f-count").textContent = fmt(list.length) + "건";
    box.querySelectorAll("th[data-sort]").forEach(function (h) {
      h.addEventListener("click", function () {
        var k = h.getAttribute("data-sort");
        if (s.sort === k) s.dir = -s.dir; else { s.sort = k; s.dir = k === "date" || k === "impact" ? -1 : 1; }
        drawBillTable();
      });
    });
    bindPager(box, function (p) { s.page = p; drawBillTable(); });
  }

  function pager(page, pages, total) {
    if (pages <= 1) return "";
    return '<div class="pager no-print"><span class="muted">' + fmt(total) + "건 중 " + fmt(page * PAGE + 1) + "–" +
      fmt(Math.min(total, (page + 1) * PAGE)) + '</span><button type="button" class="btn ghost" data-page="' + (page - 1) + '"' +
      (page === 0 ? " disabled" : "") + '>이전</button><span>' + (page + 1) + " / " + pages +
      '</span><button type="button" class="btn ghost" data-page="' + (page + 1) + '"' + (page >= pages - 1 ? " disabled" : "") +
      ">다음</button></div>";
  }
  function bindPager(box, go) {
    box.querySelectorAll("button[data-page]").forEach(function (b) {
      b.addEventListener("click", function () { if (!b.disabled) go(Number(b.getAttribute("data-page"))); });
    });
  }

  // ---------------------------------------------------------------- 화면: 법안 상세 (집계 · 건물 명부)
  function billHead(b) {
    return '<div class="crumb no-print"><a href="#/bills">← 법안 검토 목록</a></div>' +
      "<h2>" + esc(b.name) + '</h2><p class="lead">의안번호 ' + esc(b.no) + " · " + esc(b.committee) + " · 제안 " + esc(b.date) +
      ' · <span class="tag">' + esc(fieldName(b.field)) + "</span></p>";
  }

  function viewBill(no) {
    var b = D.byNo[no];
    if (!b) { $view.innerHTML = '<p>의안번호 ' + esc(no) + '를 찾지 못했습니다. <a href="#/bills">목록으로</a></p>'; return; }
    var demo = D.demos[no];
    var links = '<div class="toolbar no-print"><a class="btn ghost" href="index.html?bill=' + no + '">지도에서 보기</a>' +
      '<a class="btn ghost" href="' + esc(b.link) + '" target="_blank" rel="noopener">의안정보시스템 원문</a>' +
      (demo ? '<a class="btn" href="#/print/' + no + '">검토서 인쇄</a>' : "") + "</div>";

    if (!demo) {
      $view.innerHTML = billHead(b) + links +
        '<div class="note-box">이 법안은 아직 적용 기준(용도·면적·층수·연도)을 추출하지 않아 건물 판정이 없습니다. ' +
        "AI 기준 추출 단계에서 판정할 예정입니다.</div>" +
        '<h3>제안이유·주요내용 (요약)</h3><div class="card">' + esc(b.summary) + "</div>";
      return;
    }

    $view.innerHTML = billHead(b) + links + '<p class="muted">건물 데이터를 불러오는 중…</p>';
    loadProps().then(function () {
      if (location.hash !== "#/bill/" + no) return; // 그사이 다른 화면으로 옮김
      var J = judgeBill(no);
      var html = billHead(b) + links;
      html += '<div class="counts">' + STATUSES.map(function (s) {
        return '<div class="c"><div class="k"><i class="s-' + s + '"></i>' + s + '</div><div class="v">' + fmt(J.counts[s]) +
          '동</div><div class="p">' + pct(J.counts[s], D.total) + "</div></div>";
      }).join("") + "</div>" + statusBar(J.counts, D.total);
      html += '<p class="small ' + (J.match ? "muted" : "") + '" style="margin-top:6px">' +
        (J.match ? "✓ 화면 계산과 미리 계산한 동수가 일치합니다." : "⚠ 화면 계산과 미리 계산한 동수가 다릅니다. 데이터를 다시 만들어야 합니다.") + "</p>";

      html += '<div class="grid2">';
      html += '<div class="card"><h3 style="margin-top:0">적용 기준과 근거</h3><div class="muted small">법안 원문</div>' +
        '<div class="quote">' + esc(demo.source_text) + '</div><div class="muted small">적용 규칙</div><ul style="margin:4px 0 10px;padding-left:18px">' +
        ruleText(demo.rule).map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul>" +
        '<div class="muted small">해석 메모</div><p style="margin:4px 0">' + esc(demo.rule_note) + "</p></div>";
      html += '<div class="card"><h3 style="margin-top:0">결론과 사유별 동수</h3><p style="margin:0 0 10px">' + esc(demo.conclusion) + "</p>" +
        reasonTable(J) + "</div>";
      html += "</div>";

      html += "<h3>건물 명부</h3>";
      html += '<div class="tabs no-print" id="r-tabs"></div><div class="toolbar no-print"><span class="muted small">' +
        "PNU·주용도·면적·층수·사용승인일만 표시합니다. 건물명·소유자는 수집하지 않습니다.</span>" +
        '<span class="spacer"></span><button type="button" class="btn ghost" id="r-csv">이 탭 CSV</button></div>' +
        '<div class="table-wrap" id="r-table"></div>';
      $view.innerHTML = html;

      if (!ui.roster.tab || ui.roster.no !== no) {
        // 대상·경계선이 있으면 그것부터, 없으면 판정불가부터 보여 준다
        ui.roster = { no: no, page: 0, tab: J.counts.대상 ? "대상" : J.counts.경계선 ? "경계선" : "판정불가" };
      }
      drawRoster(no);
      document.getElementById("r-csv").addEventListener("click", function () {
        var rows = J.rows.filter(function (r) { return r.status === ui.roster.tab; });
        downloadCSV("빼곡_" + no + "_" + ui.roster.tab + "_건물명부.csv",
          ["PNU", "주용도코드", "주용도", "연면적(㎡)", "지상층수", "사용승인일", "판정", "사유"],
          rows.map(function (r) {
            var p = r.p;
            return [p.pnu, p.usability || "", p.usability ? USE_NAMES[p.usability] || "" : "", p.totalarea, p.grnd_flr,
              ymd(p.useapr_day), r.status, r.reason];
          }));
      });
    }).catch(showError);
  }

  function reasonTable(J) {
    var keys = Object.keys(J.reasons).sort(function (a, b) {
      return STATUSES.indexOf(a.split("|")[0]) - STATUSES.indexOf(b.split("|")[0]) || J.reasons[b] - J.reasons[a];
    });
    return '<table class="dt"><thead><tr><th>판정</th><th>사유</th><th class="num">동수</th></tr></thead><tbody>' +
      keys.map(function (k) {
        var p = k.split("|");
        return '<tr><td><span class="sbar" style="display:inline-block;width:10px;min-width:0;height:10px;vertical-align:middle"><i class="s-' +
          p[0] + '" style="width:100%"></i></span> ' + esc(p[0]) + "</td><td>" + esc(p[1]) + '</td><td class="num">' + fmt(J.reasons[k]) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  function drawRoster(no) {
    var J = D.judged[no], r = ui.roster;
    var tabs = document.getElementById("r-tabs");
    tabs.innerHTML = STATUSES.map(function (s) {
      return '<button type="button" data-tab="' + s + '"' + (r.tab === s ? ' class="on"' : "") + ">" + s + " " + fmt(J.counts[s]) + "</button>";
    }).join("");
    tabs.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () { r.tab = b.getAttribute("data-tab"); r.page = 0; drawRoster(no); });
    });
    var list = J.rows.filter(function (x) { return x.status === r.tab; });
    var pages = Math.max(1, Math.ceil(list.length / PAGE));
    var rows = list.slice(r.page * PAGE, r.page * PAGE + PAGE);
    var box = document.getElementById("r-table");
    box.innerHTML = '<table class="dt"><thead><tr><th>PNU</th><th>주용도</th><th class="num">연면적(㎡)</th><th class="num">지상층수</th>' +
      "<th>사용승인일</th><th>사유</th></tr></thead><tbody>" +
      (rows.map(function (x) {
        var p = x.p;
        return "<tr><td>" + esc(p.pnu) + "</td><td>" + esc(useName(p.usability)) + '</td><td class="num">' +
          (p.totalarea ? fmt(p.totalarea) : "-") + '</td><td class="num">' + (p.grnd_flr ? fmt(p.grnd_flr) : "-") + "</td><td>" +
          (ymd(p.useapr_day) || "-") + "</td><td>" + esc(x.reason) + "</td></tr>";
      }).join("") || '<tr><td colspan="6" class="muted">해당 건물이 없습니다.</td></tr>') +
      "</tbody></table>" + pager(r.page, pages, list.length);
    bindPager(box, function (p) { r.page = p; drawRoster(no); });
  }

  // ---------------------------------------------------------------- 화면: 검토서 (A4 인쇄)
  function viewPrint(no) {
    var b = D.byNo[no], demo = D.demos[no];
    if (!b || !demo) {
      $view.innerHTML = '<p>판정한 법안만 검토서를 만들 수 있습니다. <a href="#/bill/' + esc(no) + '">법안으로 돌아가기</a></p>';
      return;
    }
    $view.innerHTML = '<p class="muted">검토서를 만드는 중…</p>';
    loadProps().then(function () {
      if (location.hash !== "#/print/" + no) return;
      var J = judgeBill(no);
      var dept = store("dept"), writer = store("writer");
      var blank = function (v) { return v ? esc(v) : "○○○"; };
      var hits = J.rows.filter(function (r) { return r.status === "대상" || r.status === "경계선"; });

      var html = '<div class="print-tools no-print"><a href="#/bill/' + no + '">← 법안으로</a><span class="spacer" style="flex:1"></span>' +
        '<label class="small">담당 부서 <input id="p-dept" value="' + esc(dept) + '" placeholder="예: 건축과" style="font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:6px"></label>' +
        '<label class="small">작성자 직위 <input id="p-writer" value="' + esc(writer) + '" placeholder="예: 주무관" style="font:inherit;padding:4px 8px;border:1px solid var(--line);border-radius:6px"></label>' +
        '<button type="button" class="btn" id="p-print">인쇄 · PDF로 저장</button></div>' +
        '<p class="no-print muted small">부서·직위만 이 브라우저에 저장됩니다. 이름 등 개인정보는 넣지 마세요. 비워 두면 ○○○로 인쇄되어 손으로 채울 수 있습니다.</p>';

      html += '<article class="doc">';
      html += "<h1>법안 영향 검토서</h1>";
      html += '<div class="doc-sub">' + esc(D.region) + " 건축물 대상 · 작성일 " + today() + " · 부서 " + blank(dept) + " · 작성 " + blank(writer) + "</div>";

      html += '<section class="doc-sec"><h2>1. 법안 개요</h2><table>' +
        "<tr><th>의안번호</th><td>" + esc(b.no) + "</td></tr>" +
        "<tr><th>법안명</th><td>" + esc(b.name) + "</td></tr>" +
        "<tr><th>소관위원회</th><td>" + esc(b.committee) + "</td></tr>" +
        "<tr><th>제안일</th><td>" + esc(b.date) + "</td></tr>" +
        "<tr><th>분야</th><td>" + esc(fieldName(b.field)) + " (자동 분류, 확신도 " + Math.round(b.conf * 100) + "%)</td></tr>" +
        "<tr><th>검토 쟁점</th><td>" + esc(demo.title) + "</td></tr>" +
        "</table></section>";

      html += '<section class="doc-sec"><h2>2. 적용 기준</h2><table>' +
        "<tr><th>법안 원문</th><td>" + esc(demo.source_text) + "</td></tr>" +
        "<tr><th>적용 규칙</th><td>" + ruleText(demo.rule).map(esc).join("<br>") + "</td></tr>" +
        "<tr><th>해석 메모</th><td>" + esc(demo.rule_note) + "</td></tr>" +
        "</table></section>";

      html += '<section class="doc-sec"><h2>3. 판정 결과 (' + esc(D.region) + " " + fmt(D.total) + "동)</h2><table>" +
        "<tr><th>구분</th><td><b>동수</b></td><td><b>비율</b></td><td><b>뜻</b></td></tr>" +
        STATUSES.map(function (s) {
          var mean = { 대상: "기준을 모두 충족", 경계선: "기준에 근소하게 못 미침 (수치 ±10%, 연도 ±1년)",
            비대상: "기준에 해당하지 않음", 판정불가: "속성이 비어 있거나 시행령 위임으로 확정 불가" }[s];
          return "<tr><th>" + s + "</th><td>" + fmt(J.counts[s]) + "동</td><td>" + pct(J.counts[s], D.total) + "</td><td>" + mean + "</td></tr>";
        }).join("") + "</table><p><b>결론</b> " + esc(demo.conclusion) + "</p></section>";

      html += '<section class="doc-sec"><h2>4. 사유별 동수</h2><table><tr><th>판정</th><td><b>사유</b></td><td><b>동수</b></td></tr>' +
        Object.keys(J.reasons).sort(function (a, c) {
          return STATUSES.indexOf(a.split("|")[0]) - STATUSES.indexOf(c.split("|")[0]) || J.reasons[c] - J.reasons[a];
        }).map(function (k) {
          var p = k.split("|");
          return "<tr><th>" + esc(p[0]) + "</th><td>" + esc(p[1]) + "</td><td>" + fmt(J.reasons[k]) + "동</td></tr>";
        }).join("") + "</table></section>";

      html += '<section class="doc-sec"><h2>5. 한계와 유의사항</h2><ul>' +
        "<li>판정 결과는 건축물 데이터(브이월드 건물통합정보) 기반 추정이며 법률 판단이 아닙니다.</li>" +
        "<li>건축물대장 속성이 비어 있는 건물은 판정불가로 둡니다 (사창동 전체 2,448동 중 약 13.4%).</li>" +
        "<li>법률이 용도·규모를 시행령에 위임한 경우, 나머지 기준을 충족해도 확정하지 않고 판정불가로 둡니다.</li>" +
        "<li>주용도 코드와 법안 용어(예: 물류터미널)의 대응은 아직 검증하지 않았습니다.</li>" +
        "<li>현장 확인 전 자료이므로, 대상 건물 통보 등 행정 조치에 바로 쓰지 마십시오.</li>" +
        "</ul></section>";

      html += '<div class="sign doc-sec"><table><tr><th>담당</th><th>검토</th><th>결재</th></tr><tr><td></td><td></td><td></td></tr></table></div>';
      html += '<p class="foot">출처: 열린국회정보 Open API(법안), 국토교통부 브이월드 건물통합정보(건물). ' +
        "빼곡 시제품으로 만든 초안이며 담당자 검토가 필요합니다.</p>";

      html += '<section class="attach"><h2>붙임. 대상·경계선 건물 목록</h2>';
      if (!hits.length) {
        html += "<p>해당 건물 없음 (대상 0동, 경계선 0동).</p>";
      } else {
        html += "<table><tr><th>PNU</th><td><b>주용도</b></td><td><b>연면적(㎡)</b></td><td><b>지상층수</b></td><td><b>사용승인일</b></td><td><b>판정</b></td></tr>" +
          hits.map(function (r) {
            var p = r.p;
            return "<tr><th>" + esc(p.pnu) + "</th><td>" + esc(useName(p.usability)) + "</td><td>" + (p.totalarea ? fmt(p.totalarea) : "-") +
              "</td><td>" + (p.grnd_flr || "-") + "</td><td>" + (ymd(p.useapr_day) || "-") + "</td><td>" + r.status + "</td></tr>";
          }).join("") + "</table>";
      }
      html += "</section></article>";
      $view.innerHTML = html;

      document.getElementById("p-print").addEventListener("click", function () { window.print(); });
      [["p-dept", "dept"], ["p-writer", "writer"]].forEach(function (p) {
        document.getElementById(p[0]).addEventListener("change", function (e) { store(p[1], e.target.value.trim()); viewPrint(no); });
      });
    }).catch(showError);
  }

  // ---------------------------------------------------------------- 화면: 데이터·한계
  function viewSources() {
    $view.innerHTML = '<h2>데이터·한계</h2><p class="lead">이 화면의 숫자가 어디서 왔고, 어디까지 믿을 수 있는지</p>' +
      '<div class="table-wrap"><table class="dt"><thead><tr><th>자료</th><th>출처</th><th>범위</th><th>쓰는 곳</th></tr></thead><tbody>' +
      "<tr><td>법안 목록·제안이유</td><td>열린국회정보 Open API</td><td>22대 국회 계류 " + fmt(D.bills.length) + "건 (건축·주거·안전 관련 위원회)</td><td>법안 검토 목록, 분야 분류</td></tr>" +
      "<tr><td>분야 분류</td><td>팀 자체 Keras 신경망</td><td>9개 분야, 법안마다 확신도</td><td>분야 필터 (자동 분류라 틀릴 수 있음)</td></tr>" +
      "<tr><td>건물 속성</td><td>국토교통부 브이월드 건물통합정보</td><td>" + esc(D.region) + " " + fmt(D.total) + "동 · PNU, 주용도, 연면적, 층수, 사용승인일</td><td>판정, 건물 명부</td></tr>" +
      "<tr><td>적용 기준</td><td>법안 원문에서 사람이 추출 (시범)</td><td>" + Object.keys(D.demos).length + "건</td><td>판정 (나머지는 AI 추출 예정)</td></tr>" +
      "</tbody></table></div>" +
      "<h3>판정 방법</h3><div class=\"card\"><ul style=\"margin:0;padding-left:18px\">" +
      "<li><b>대상</b>: 추출한 기준을 모두 충족</li>" +
      "<li><b>경계선</b>: 수치 기준의 90~100%, 또는 연도 기준 1년 이내. 입법 사각지대 후보</li>" +
      "<li><b>비대상</b>: 기준에 해당하지 않음</li>" +
      "<li><b>판정불가</b>: 판정에 필요한 속성이 비어 있거나, 법률이 시행령에 기준을 위임함</li>" +
      "</ul><p class=\"small muted\" style=\"margin:8px 0 0\">판정 코드는 지도 화면과 같은 judge.js를 씁니다.</p></div>" +
      "<h3>한계</h3><div class=\"note-box\"><ul style=\"margin:0;padding-left:18px\">" +
      "<li>판정 결과는 추정이며 법률 판단이 아닙니다. 현장 확인 전 자료입니다.</li>" +
      "<li>사창동 건물의 약 13.4%는 건축물대장 속성이 비어 판정불가입니다.</li>" +
      "<li>주용도 코드와 법안 용어의 대응은 검증 전입니다.</li>" +
      "<li>이 화면은 시연용으로 공개되어 있습니다. 도입 시에는 행정망 내부에서만 씁니다. 건물명·소유자 등 개인정보는 처음부터 수집하지 않습니다.</li>" +
      "</ul></div>";
  }

  // ---------------------------------------------------------------- 라우터
  function route() {
    var h = location.hash.replace(/^#/, "") || "/";
    var m;
    var key = "home";
    if (h === "/bills") { key = "bills"; viewBills(); }
    else if ((m = h.match(/^\/bill\/(\d+)$/))) { key = "bills"; viewBill(m[1]); }
    else if ((m = h.match(/^\/print\/(\d+)$/))) { key = "bills"; viewPrint(m[1]); }
    else if (h === "/sources") { key = "sources"; viewSources(); }
    else viewHome();
    document.querySelectorAll("#nav a").forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-route") === key);
    });
    window.scrollTo(0, 0);
  }

  function showError(err) {
    console.error(err);
    $view.innerHTML = '<p>데이터를 불러오지 못했습니다: ' + esc(err.message) + "</p>";
  }

  Promise.all([getJSON("data/bills.json"), getJSON("data/demo_rules.json")]).then(function (res) {
    D.fields = res[0].fields;
    D.bills = res[0].bills;
    D.bills.forEach(function (b) {
      D.byNo[b.no] = b;
      b._q = (b.name + " " + b.no + " " + b.summary + " " + b.committee).toLowerCase();
    });
    D.region = res[1].region;
    D.total = res[1].total;
    res[1].demos.forEach(function (d) { D.demos[d.bill_no] = d; });
    document.getElementById("bldg-total").textContent = fmt(D.total);
    window.addEventListener("hashchange", route);
    route();
  }).catch(showError);
})();
