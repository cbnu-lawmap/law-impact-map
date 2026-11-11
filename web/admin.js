/*
 * 빼곡 — 행정 화면
 *
 * 사각119·온지붕·필지 블랙박스의 행정 화면 구성을 법안 검토 업무에 맞게 옮겼다.
 *   - 역할(법안 검토 담당 / 결재·관리 / 관내 총괄): 첫 화면과 상황판 카드만 바꿈. 권한 차이 없음
 *   - 모드(실무 / 심사·검증): 심사 모드에서 판정 규칙·검증과 원본 규칙을 함께 보임 ("숨기되 지우지 않는다")
 *   - 진행 현황(미검토 / 검토 중 / 보류 / 검토 완료, 모양·색·글자 배지), 메모, 처리 이력, 일괄 변경, CSV 내보내기·가져오기
 *   - 건물 확인 기록(맞음 / 아님 / 확인 불가)과 적중률
 *   - 검토서 인쇄(A4)·한글(HWPX) 내려받기, 하단 상태 바, 둘러보기, 질의 도우미(AI)
 *
 * 화면 (주소의 # 뒤)
 *   #/  상황판      #/bills  법안 검토 목록     #/bill/번호  법안별 집계·건물 명부
 *   #/print/번호  검토서   #/progress  진행 현황   #/rules  판정 규칙·검증   #/sources  데이터·한계
 *
 * 로그인·서버 저장이 없다. 진행 기록은 이 브라우저(localStorage)에만 남고, 담당자끼리는 CSV로 주고받는다.
 * 질의 도우미만 별도 서버(server/api/ask.js, Vercel)에 묻는다. OpenAI 키는 그 서버 환경변수에만 있다.
 * 설정에서 질의 도우미를 끄면 그 서버에 아예 연결하지 않는다 (행정망용).
 *
 * 화면 찍기용: 주소에 ?shot=1 을 붙이면 역할 고르기 창·둘러보기를 띄우지 않고, 아무것도 저장하지 않는다.
 */
(function () {
  "use strict";

  var ASK_URL = "https://ppaegok-api.vercel.app/api/ask";
  var STATUSES = Judge.STATUSES; // 대상, 경계선, 비대상, 판정불가
  var PAGE = 50;
  // 진행 상태. 화면에서는 모양(빈 원·반쪽 원·마름모·꽉 찬 원)+색+글자 배지로 보인다 (admin.css .pg-*)
  var PG = {
    todo: { label: "미검토" },
    doing: { label: "검토 중" },
    hold: { label: "보류" },
    done: { label: "검토 완료" },
  };
  var PG_KEYS = ["todo", "doing", "hold", "done"];
  var CHECK = { yes: "맞음", no: "아님", unk: "확인 불가" };
  var ROLES = {
    review: { label: "법안 검토 담당", start: "#/", desc: "법안별 영향 건물을 보고 검토서를 씁니다" },
    approve: { label: "결재·관리", start: "#/progress", desc: "검토가 어디까지 됐는지 보고 결재합니다" },
    chief: { label: "관내 총괄", start: "#/", desc: "분야별·전체 영향을 한눈에 봅니다" },
  };
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
  // 메모에 넣으면 안 되는 개인정보 (전화번호·주민등록번호·이메일)
  var CONF_LOW = 0.6;   // 자동 분야 분류 확신도가 이보다 낮으면 "분류 확인 필요"
  var SHOT = /[?&]shot=1(&|$)/.test(location.search);
  var PII = /(01[016789][-\s]?\d{3,4}[-\s]?\d{4})|(\d{6}[-\s]?[1-4]\d{6})|([\w.+-]+@[\w-]+\.[\w.]+)/;

  var D = { fields: {}, bills: [], byNo: {}, demos: {}, region: "", total: 0, props: null, judged: {} };
  var ui = {
    bills: { q: "", field: "", committee: "", status: "", pg: "", sort: "date", dir: -1, page: 0, sel: {} },
    roster: { tab: "", page: 0, no: null },
  };
  var $view = document.getElementById("view");

  // ---------------------------------------------------------------- 저장 (이 브라우저)
  function load(key, def) {
    try { var v = localStorage.getItem("ppaegok." + key); return v ? JSON.parse(v) : def; } catch (e) { return def; }
  }
  function save(key, val) {
    if (SHOT) return; // 화면 찍기용: 저장하지 않음
    try { localStorage.setItem("ppaegok." + key, JSON.stringify(val)); } catch (e) { /* 저장 불가(사생활 보호 모드 등) */ }
  }
  var progress = load("progress", {});   // { 번호: { s, memo, t, log: [[시각, 내용]] } }
  var checks = load("checks", {});       // { 번호: { pnu: yes|no|unk } }
  var prefs = load("prefs", { role: "", mode: "work", toured: false, dept: "", writer: "", ai: true });
  if (prefs.ai === undefined) prefs.ai = true; // 예전 저장값: 질의 도우미 켜짐

  function pgOf(no) { return (progress[no] && progress[no].s) || "todo"; }
  function setPg(no, s, note) {
    var p = progress[no] || { s: "todo", memo: "", log: [] };
    if (p.s === s && !note) return;
    var t = new Date().toISOString();
    p.log = (p.log || []).concat([[t, note || PG[p.s].label + " → " + PG[s].label]]).slice(-30);
    p.s = s;
    p.t = t;
    progress[no] = p;
    save("progress", progress);
    drawSideProgress();
  }
  function pgBadge(s) { return '<span class="pg pg-' + s + '">' + PG[s].label + "</span>"; }
  function pgMark(no) { return pgBadge(pgOf(no)); }

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
  function when(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return (d.getMonth() + 1) + "." + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function useName(code) {
    if (!code) return "(없음)";
    return (USE_NAMES[code] || "코드") + " " + code;
  }
  function fieldName(f) { return f == null ? "미분류" : D.fields[f] || "미분류"; }
  // 자동 분류는 숫자(확신도)를 보이지 않고, 낮을 때만 "분류 확인 필요"를 붙인다
  function lowConf(b) { return b.conf != null && b.conf < CONF_LOW; }
  function fieldTag(b) {
    return '<span class="tag" title="법안 내용으로 자동 분류한 분야">' + esc(fieldName(b.field)) + ' <span class="sub">자동 분류</span></span>' +
      (lowConf(b) ? ' <span class="tag check" title="자동 분류가 불확실합니다. 분야를 직접 확인하세요">분류 확인 필요</span>' : "");
  }
  function fieldText(b) { return fieldName(b.field) + " (자동 분류" + (lowConf(b) ? " · 분류 확인 필요" : "") + ")"; }
  function getJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + " " + r.status);
      return r.json();
    });
  }
  function download(name, blob) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  // CSV (엑셀에서 한글이 깨지지 않게 BOM을 붙인다)
  function downloadCSV(name, header, rows) {
    var cell = function (v) {
      v = v == null ? "" : String(v);
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    var text = "﻿" + [header].concat(rows).map(function (r) { return r.map(cell).join(","); }).join("\r\n");
    download(name, new Blob([text], { type: "text/csv;charset=utf-8" }));
  }
  function parseCSV(text) {
    var rows = [], row = [], cur = "", q = false;
    text = text.replace(/^﻿/, "");
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cur); rows.push(row); row = []; cur = "";
      } else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  function stamp() { return today().replace(/\./g, ""); }

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
  function sortedReasons(J) {
    return Object.keys(J.reasons).sort(function (a, b) {
      return STATUSES.indexOf(a.split("|")[0]) - STATUSES.indexOf(b.split("|")[0]) || J.reasons[b] - J.reasons[a];
    });
  }

  // 건물 확인 적중률: 대상·경계선·판정불가 후보 가운데 사람이 "맞음"이라 한 비율
  function checkStats(no) {
    var c = checks[no] || {}, n = { yes: 0, no: 0, unk: 0 };
    Object.keys(c).forEach(function (k) { if (n[c[k]] !== undefined) n[c[k]]++; });
    n.total = n.yes + n.no + n.unk;
    n.rate = n.yes + n.no ? Math.round(n.yes / (n.yes + n.no) * 100) + "%" : "기록 없음";
    return n;
  }

  // ---------------------------------------------------------------- 지금 할 일 (상황판 카드)
  // 판정한 법안 중 대상·경계선이 있는 것 → 위임 후보가 많은 것 → 판정 전 최근 법안(건축 안전·소방 우선) 순
  function todoList() {
    var out = [];
    Object.keys(D.demos).forEach(function (no) {
      if (pgOf(no) === "done") return;
      var d = D.demos[no], b = D.byNo[no];
      var hit = d.counts.대상 + d.counts.경계선;
      var deleg = d.rule.위임 && d.rule.위임.length;
      var why = "대상 " + fmt(d.counts.대상) + "동 · 경계선 " + fmt(d.counts.경계선) + "동 · 판정불가 " + fmt(d.counts.판정불가) + "동";
      var act, from;
      if (hit) { act = "대상·경계선 " + fmt(hit) + "동 명부 확인 → 검토서 작성"; from = "건물 명부의 대상 탭"; }
      else if (deleg) {
        act = "시행령 위임 기준(" + d.rule.위임.join("·") + ") 확인 후 후보 재판정";
        from = d.candidates_2f_plus ? "판정불가 후보 " + fmt(d.candidates_2f_plus) + "동" : "판정불가 탭";
      } else { act = "대상 0동 확인 → 검토서로 종결"; from = d.conclusion; }
      out.push({ no: no, name: d.title || (b ? b.name : no), score: hit * 1000 + (deleg ? 500 : 0) + 100, act: act, why: why, from: from,
        basis: d.source_text, judged: true });
    });
    var pri = { 3: 3, 1: 3, 5: 2, 7: 2, 2: 1 };
    D.bills.filter(function (b) { return !D.demos[b.no] && pgOf(b.no) !== "done" && pri[b.field]; })
      .sort(function (a, b) { return (pri[b.field] - pri[a.field]) || (a.date < b.date ? 1 : -1); })
      .slice(0, 3).forEach(function (b) {
        out.push({ no: b.no, name: b.name, score: pri[b.field], act: "적용 기준(용도·면적·층수·연도) 추출 요청",
          why: fieldName(b.field) + " 분야 · " + b.date + " 제안 · 아직 판정 전", from: "제안이유에서 대상 건물 조건 찾기",
          basis: "의안정보시스템 원문", judged: false });
      });
    return out.sort(function (a, b) { return b.score - a.score; }).slice(0, 3);
  }
  // ---------------------------------------------------------------- 화면: 상황판
  function viewHome() {
    var judgedNos = Object.keys(D.demos);
    var cnt = { todo: 0, doing: 0, hold: 0, done: 0 };
    D.bills.forEach(function (b) { cnt[pgOf(b.no)]++; });
    // 법안마다 대상·경계선 동수를 따로 본다 (법안끼리 더하면 같은 건물이 여러 번 세어짐)
    var hitBills = 0, hitMax = 0;
    judgedNos.forEach(function (no) {
      var h = D.demos[no].counts.대상 + D.demos[no].counts.경계선;
      if (h) hitBills++;
      if (h > hitMax) hitMax = h;
    });
    var judgedDone = judgedNos.filter(function (no) { return pgOf(no) === "done"; }).length;
    var role = prefs.role || "review";
    var cards = {
      review: [
        kpi("지금 검토할 법안", fmt(judgedNos.length - judgedDone) + "건", "판정했고 아직 검토 완료 전"),
        kpi("검토 중", fmt(cnt.doing) + "건", "보류 " + fmt(cnt.hold) + "건"),
        kpi("사창동에 영향 있는 법안", fmt(hitBills) + "건", "대상·경계선 1동 이상 · 최대 " + fmt(hitMax) + "동"),
        kpi("기준 추출 대기", fmt(D.bills.length - judgedNos.length) + "건", "AI 기준 추출 단계에서 판정 예정", true),
      ],
      approve: [
        kpi("결재 대기 (검토 완료)", fmt(cnt.done) + "건", "검토서 인쇄·한글 내려받기 가능", cnt.done > 0),
        kpi("검토 중", fmt(cnt.doing) + "건", "담당자가 검토하고 있음"),
        kpi("보류", fmt(cnt.hold) + "건", "시행령 확정 등을 기다림"),
        kpi("미검토", fmt(cnt.todo) + "건", "계류 법안 " + fmt(D.bills.length) + "건 중"),
      ],
      chief: [
        kpi("계류 법안", fmt(D.bills.length) + "건", "22대 국회 · 건축·주거·안전 분야"),
        kpi("판정한 법안", fmt(judgedNos.length) + "건", methodSummary()),
        kpi("사창동에 영향 있는 법안", fmt(hitBills) + "건", "판정한 " + fmt(judgedNos.length) + "건 중 · 최대 " + fmt(hitMax) + "동"),
        kpi("검토 진척률", judgedNos.length ? Math.round(judgedDone / judgedNos.length * 100) + "%" : "-", "판정한 법안 중 검토 완료", true),
      ],
    }[role];

    var html = '<p class="eyebrow">' + esc(ROLES[role].label) + ' 화면</p><h2>상황판</h2><p class="lead">' + esc(D.region) +
      " 기준 · 국회 계류 법안이 우리 동네 건물에 미치는 영향</p>";
    html += headline(judgedNos, judgedDone);
    html += '<div class="kpis" id="kpis">' + cards.join("") + "</div>";

    html += '<h3 id="todo-h">지금 할 일<span class="aside">순서는 검토 순서에만 씁니다. 법 적용 여부를 정하지 않습니다.</span></h3><div class="todo-cards" id="todo-cards">' +
      todoList().map(function (t, i) {
        return '<article class="todo"><div class="top-line"><span class="rank">' + (i + 1) + "순위</span>" + pgMark(t.no) + "</div>" +
          '<p class="act">' + esc(t.act) + "</p>" +
          '<ul class="facts"><li><span>법안</span><b>' + esc(t.name) + "</b></li><li><span>사창동</span>" + esc(t.why) + "</li></ul>" +
          "<details><summary>근거 보기</summary><p><b>어디부터</b> " + esc(t.from) + "</p><p><b>근거</b> " + esc(t.basis) + "</p></details>" +
          '<div class="foot"><span>의안 ' + esc(t.no) + '</span><a class="btn ghost" href="#/bill/' + t.no + '">법안 열기</a></div></article>';
      }).join("") + "</div>";

    html += "<h3>판정한 법안</h3>";
    html += '<div class="table-wrap"><table class="dt"><thead><tr><th>의안번호</th><th>법안</th>' +
      STATUSES.map(function (s) { return '<th class="num">' + s + "</th>"; }).join("") +
      "<th>분포</th><th>진행</th><th></th></tr></thead><tbody>";
    judgedNos.forEach(function (no) {
      var d = D.demos[no], b = D.byNo[no];
      html += "<tr><td>" + esc(no) + '</td><td class="title"><a href="#/bill/' + no + '">' + esc(b ? b.name : no) +
        '</a><div class="muted small">' + esc(d.title) + "</div></td>" +
        STATUSES.map(function (s) { return '<td class="num">' + fmt(d.counts[s]) + "</td>"; }).join("") +
        "<td>" + statusBar(d.counts, D.total) + "</td><td>" + pgMark(no) + '</td><td><a class="btn ghost" href="#/print/' + no + '">검토서</a></td></tr>';
    });
    html += "</tbody></table></div>";

    var fieldCnt = {};
    D.bills.forEach(function (b) { fieldCnt[b.field] = (fieldCnt[b.field] || 0) + 1; });
    var maxField = Math.max.apply(null, Object.keys(fieldCnt).map(function (k) { return fieldCnt[k]; }));
    var recent = D.bills.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; }).slice(0, 6);
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
          esc(b.committee) + " · " + esc(fieldName(b.field)) + '</div></td><td class="num muted">' + esc(b.date) + "<br>" + pgMark(b.no) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    html += "</div>";
    $view.innerHTML = html;

    $view.querySelectorAll("a[data-field]").forEach(function (a) {
      a.addEventListener("click", function () { ui.bills.field = a.getAttribute("data-field"); ui.bills.page = 0; });
    });
  }

  // 상황판 맨 위 한 문장: 판정한 법안 가운데 대상+경계선이 가장 많은 법안 (모두 0이면 그대로 말한다)
  function headline(judgedNos, judgedDone) {
    var todo = judgedNos.length - judgedDone;
    var best = null, most = null;
    judgedNos.forEach(function (no) {
      var c = D.demos[no].counts, hit = c.대상 + c.경계선;
      if (!best || hit > best.hit) best = { no: no, hit: hit };
      if (!most || c.판정불가 > most.n) most = { no: no, n: c.판정불가 };
    });
    var name = function (no) { return D.demos[no].title || (D.byNo[no] ? D.byNo[no].name : no); };
    var main, sub;
    if (!judgedNos.length) {
      main = "아직 판정한 법안이 없습니다";
      sub = "계류 법안 " + fmt(D.bills.length) + "건은 적용 기준 추출을 기다리고 있습니다.";
    } else if (best.hit > 0) {
      main = "검토할 법안 <em>" + fmt(todo) + "건</em> · " + esc(D.region) + "에서 가장 큰 영향은 " + esc(name(best.no)) +
        " <em>" + fmt(best.hit) + "동</em>";
      sub = "대상·경계선 합계 기준 · 판정한 법안 " + fmt(judgedNos.length) + "건 중";
    } else {
      main = "검토할 법안 <em>" + fmt(todo) + "건</em> · 판정한 " + fmt(judgedNos.length) + "건 모두 " + esc(D.region) + " 대상·경계선 <em>0동</em>";
      sub = most && most.n
        ? "다만 「" + esc(name(most.no)) + "」은 판정불가 후보가 " + fmt(most.n) + "동이라 시행령·속성 확인이 필요합니다."
        : "영향 건물이 없다는 결론을 검토서로 남기면 됩니다.";
    }
    return '<div class="headline" role="status"><div><p>' + main + "</p><small>" + sub + "</small></div></div>";
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
      if (s.pg && pgOf(b.no) !== s.pg) return false;
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
      if (key === "pg") return PG_KEYS.indexOf(pgOf(b.no));
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
    var html = '<h2>법안 검토 목록</h2><p class="lead">계류 법안 ' + fmt(D.bills.length) +
      "건. 판정한 법안은 사창동 건물 동수가 함께 나옵니다. 체크한 법안은 진행 상태를 한꺼번에 바꿀 수 있습니다.</p>";
    html += '<div class="toolbar no-print">' +
      '<input type="search" id="f-q" placeholder="법안명·번호·제안이유 검색" value="' + esc(s.q) + '">' +
      '<select id="f-field"><option value="">분야 전체</option>' + Object.keys(D.fields).map(function (k) {
        return '<option value="' + k + '"' + (s.field === k ? " selected" : "") + ">" + esc(D.fields[k]) + "</option>";
      }).join("") + '<option value="null"' + (s.field === "null" ? " selected" : "") + ">미분류</option></select>" +
      '<select id="f-com"><option value="">위원회 전체</option>' + committees.map(function (c) {
        return "<option" + (s.committee === c ? " selected" : "") + ">" + esc(c) + "</option>";
      }).join("") + "</select>" +
      '<select id="f-status"><option value="">판정 전체</option><option value="done"' + (s.status === "done" ? " selected" : "") +
      '>판정한 법안</option><option value="wait"' + (s.status === "wait" ? " selected" : "") + ">기준 추출 대기</option></select>" +
      '<select id="f-pg"><option value="">진행 전체</option>' + PG_KEYS.map(function (k) {
        return '<option value="' + k + '"' + (s.pg === k ? " selected" : "") + ">" + PG[k].label + "</option>";
      }).join("") + "</select>" +
      '<span class="spacer"></span><span class="muted small" id="f-count"></span>' +
      '<button type="button" class="btn ghost" id="f-csv">CSV 내려받기</button></div>' +
      '<div class="toolbar no-print bulk" id="bulk"></div>' +
      '<div class="table-wrap" id="bill-table"></div>';
    $view.innerHTML = html;

    var debounce = null;
    document.getElementById("f-q").addEventListener("input", function (e) {
      clearTimeout(debounce);
      debounce = setTimeout(function () { s.q = e.target.value; s.page = 0; drawBillTable(); }, 150);
    });
    [["f-field", "field"], ["f-com", "committee"], ["f-status", "status"], ["f-pg", "pg"]].forEach(function (p) {
      document.getElementById(p[0]).addEventListener("change", function (e) { s[p[1]] = e.target.value; s.page = 0; drawBillTable(); });
    });
    document.getElementById("f-csv").addEventListener("click", function () {
      downloadCSV("빼곡_법안검토목록_" + stamp() + ".csv",
        ["의안번호", "법안명", "소관위원회", "제안일", "분야(자동 분류)", "분류 확인", "판정", "대상", "경계선", "비대상", "판정불가", "진행", "의안정보시스템"],
        filteredBills().map(function (b) {
          var d = D.demos[b.no];
          return [b.no, b.name, b.committee, b.date, fieldName(b.field), lowConf(b) ? "확인 필요" : "", d ? "판정함" : "기준 추출 대기"]
            .concat(d ? STATUSES.map(function (st) { return d.counts[st]; }) : ["", "", "", ""])
            .concat([PG[pgOf(b.no)].label, b.link]);
        }));
    });
    drawBillTable();
  }

  function drawBulk() {
    var s = ui.bills, n = Object.keys(s.sel).length;
    var box = document.getElementById("bulk");
    if (!box) return;
    box.innerHTML = n
      ? "<b>" + fmt(n) + "건 선택</b> → " + PG_KEYS.map(function (k) {
        return '<button type="button" class="btn ghost" data-bulk="' + k + '">' + pgBadge(k) + "</button>";
      }).join("") + '<button type="button" class="linkish" data-bulk="clear">선택 해제</button>'
      : '<span class="muted small">왼쪽 칸을 체크하면 진행 상태를 한꺼번에 바꿀 수 있습니다.</span>';
    box.querySelectorAll("[data-bulk]").forEach(function (b) {
      b.addEventListener("click", function () {
        var k = b.getAttribute("data-bulk");
        if (k !== "clear") Object.keys(s.sel).forEach(function (no) { setPg(no, k); });
        s.sel = {};
        drawBillTable();
      });
    });
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
    var allOn = rows.length && rows.every(function (b) { return s.sel[b.no]; });
    var html = '<table class="dt"><thead><tr><th class="chk no-print"><input type="checkbox" id="sel-all"' + (allOn ? " checked" : "") +
      ' aria-label="이 쪽 모두 선택"></th>' + th("no", "의안번호") + th("name", "법안명") + th("committee", "위원회") +
      th("date", "제안일") + th("field", "분야") + th("impact", "사창동 영향") + th("pg", "진행") + "</tr></thead><tbody>";
    html += rows.map(function (b) {
      var d = D.demos[b.no];
      var impact = d
        ? '<span class="tag done">판정함</span> <span class="small">대상 ' + fmt(d.counts.대상) + " · 경계선 " + fmt(d.counts.경계선) +
          " · 판정불가 " + fmt(d.counts.판정불가) + "</span>"
        : '<span class="tag wait">기준 추출 대기</span>';
      return '<tr><td class="chk no-print"><input type="checkbox" data-sel="' + b.no + '"' + (s.sel[b.no] ? " checked" : "") + "></td><td>" +
        esc(b.no) + '</td><td class="title"><a href="#/bill/' + b.no + '">' + esc(b.name) + "</a></td><td>" + esc(b.committee) +
        '</td><td class="num">' + esc(b.date) + "</td><td>" + esc(fieldName(b.field)) +
        (lowConf(b) ? ' <span class="tag check" title="자동 분류가 불확실합니다">분류 확인 필요</span>' : "") + "</td><td>" + impact + "</td><td>" + pgMark(b.no) + "</td></tr>";
    }).join("") || '<tr><td colspan="8" class="muted">조건에 맞는 법안이 없습니다.</td></tr>';
    html += "</tbody></table>" + pager(s.page, pages, list.length);
    var box = document.getElementById("bill-table");
    box.innerHTML = html;
    document.getElementById("f-count").textContent = fmt(list.length) + "건";
    box.querySelectorAll("th[data-sort]").forEach(function (h) {
      h.addEventListener("click", function () {
        var k = h.getAttribute("data-sort");
        if (s.sort === k) s.dir = -s.dir; else { s.sort = k; s.dir = k === "date" || k === "impact" || k === "pg" ? -1 : 1; }
        drawBillTable();
      });
    });
    box.querySelectorAll("input[data-sel]").forEach(function (c) {
      c.addEventListener("change", function () {
        var no = c.getAttribute("data-sel");
        if (c.checked) s.sel[no] = 1; else delete s.sel[no];
        drawBulk();
      });
    });
    document.getElementById("sel-all").addEventListener("change", function (e) {
      rows.forEach(function (b) { if (e.target.checked) s.sel[b.no] = 1; else delete s.sel[b.no]; });
      drawBillTable();
    });
    bindPager(box, function (p) { s.page = p; drawBillTable(); });
    drawBulk();
  }

  function pager(page, pages, total) {
    if (pages <= 1) return "";
    return '<div class="pager no-print"><span class="muted">' + fmt(total) + "건 중 " + fmt(page * PAGE + 1) + "–" +
      fmt(Math.min(total, (page + 1) * PAGE)) + '</span><button type="button" class="btn ghost" data-page="' + (page - 1) + '"' +
      (page === 0 ? " disabled" : "") + ">이전</button><span>" + (page + 1) + " / " + pages +
      '</span><button type="button" class="btn ghost" data-page="' + (page + 1) + '"' + (page >= pages - 1 ? " disabled" : "") +
      ">다음</button></div>";
  }
  function bindPager(box, go) {
    box.querySelectorAll("button[data-page]").forEach(function (b) {
      b.addEventListener("click", function () { if (!b.disabled) go(Number(b.getAttribute("data-page"))); });
    });
  }

  // ---------------------------------------------------------------- 화면: 법안 상세 (진행 · 집계 · 건물 명부)
  function billHead(b) {
    return '<div class="crumb no-print"><a href="#/bills">← 법안 검토 목록</a></div>' +
      "<h2>" + esc(b.name) + '</h2><p class="lead">의안번호 ' + esc(b.no) + " · " + esc(b.committee) + " · 제안 " + esc(b.date) +
      " · " + fieldTag(b) + " · " + pgMark(b.no) +
      (D.demos[b.no] ? ' · <span class="tag' + (isAI(b.no) ? " wait" : " done") + '">기준 ' + esc(isAI(b.no) ? "AI 추출 · 담당자 검토 전" : "사람 추출") + "</span>" : "") + "</p>";
  }
  function isAI(no) { return /^AI/.test((D.demos[no] && D.demos[no].method) || ""); }
  // 판정한 법안의 기준 추출 방법 요약 (예: "사람 추출 2건 · AI 추출 24건(검토 전)")
  function methodSummary() {
    var ai = Object.keys(D.demos).filter(isAI).length, human = Object.keys(D.demos).length - ai;
    return "사람 추출 " + human + "건" + (ai ? " · AI 추출 " + ai + "건(검토 전)" : "");
  }

  // 진행 상태 · 메모 · 처리 이력 (필지 블랙박스 사건 이력, 사각119 인계 메모)
  function progressBox(no) {
    var p = progress[no] || { s: "todo", memo: "", log: [] };
    return '<div class="card no-print" id="pg-card" style="margin-bottom:16px"><div class="pg-box"><div>' +
      '<div class="field-label">진행 상태</div><div class="pg-pick">' +
      PG_KEYS.map(function (k) {
        return '<button type="button" data-pg="' + k + '"' + (p.s === k ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + ">" + pgBadge(k) + "</button>";
      }).join("") + "</div>" +
      (p.t ? '<div class="muted small" style="margin-top:6px">마지막 변경 ' + when(p.t) + "</div>" : "") +
      '</div><div><div class="field-label">인계 메모 (300자) — <b>이름·연락처·주소 등 개인정보를 넣지 마세요</b></div>' +
      '<textarea class="memo" id="pg-memo" maxlength="300" placeholder="예: 시행령 입법예고 나오면 용도 기준 다시 확인">' + esc(p.memo || "") + "</textarea>" +
      '<div class="pii-warn" id="pg-warn"></div>' +
      ((p.log && p.log.length) ? '<ul class="log">' + p.log.slice().reverse().map(function (l) {
        return "<li>" + when(l[0]) + " · " + esc(l[1]) + "</li>";
      }).join("") + "</ul>" : "") + "</div></div></div>";
  }
  function bindProgressBox(no, rerender) {
    document.querySelectorAll("#pg-card [data-pg]").forEach(function (b) {
      b.addEventListener("click", function () { setPg(no, b.getAttribute("data-pg")); rerender(); });
    });
    var memo = document.getElementById("pg-memo");
    memo.addEventListener("change", function () {
      var v = memo.value.trim();
      if (PII.test(v)) {
        document.getElementById("pg-warn").textContent = "전화번호·주민등록번호·이메일로 보이는 내용이 있어 저장하지 않았습니다.";
        return;
      }
      document.getElementById("pg-warn").textContent = "";
      var p = progress[no] || { s: "todo", memo: "", log: [] };
      if ((p.memo || "") === v) return;
      p.memo = v;
      progress[no] = p;
      setPg(no, p.s, "메모 수정");
      rerender();
    });
  }

  function viewBill(no) {
    var b = D.byNo[no];
    if (!b) { $view.innerHTML = "<p>의안번호 " + esc(no) + '를 찾지 못했습니다. <a href="#/bills">목록으로</a></p>'; return; }
    var demo = D.demos[no];
    var rerender = function () { viewBill(no); };
    var links = '<div class="toolbar no-print"><a class="btn ghost" href="index.html?bill=' + no + '">지도에서 보기</a>' +
      '<a class="btn ghost" href="' + esc(b.link) + '" target="_blank" rel="noopener">의안정보시스템 원문</a>' +
      '<button type="button" class="btn ghost ai-only" id="ask-this">이 법안 질문하기</button>' +
      (demo ? '<a class="btn" href="#/print/' + no + '">검토서 인쇄·한글</a>' : "") + "</div>";

    if (!demo) {
      $view.innerHTML = billHead(b) + links + progressBox(no) +
        '<div class="note-box">이 법안은 아직 적용 기준(용도·면적·층수·연도)을 추출하지 않아 건물 판정이 없습니다. ' +
        "AI 기준 추출 단계에서 판정할 예정입니다.</div>" +
        '<h3>제안이유·주요내용 (요약)</h3><div class="card">' + esc(b.summary) + "</div>";
      bindProgressBox(no, rerender);
      bindAskThis(no);
      return;
    }

    $view.innerHTML = billHead(b) + links + '<p class="muted">건물 데이터를 불러오는 중…</p>';
    loadProps().then(function () {
      if (location.hash !== "#/bill/" + no) return; // 그사이 다른 화면으로 옮김
      var J = judgeBill(no);
      var cs = checkStats(no);
      var html = billHead(b) + links + progressBox(no);
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
        '<div class="muted small">해석 메모</div><p style="margin:4px 0">' + esc(demo.rule_note) + "</p>" +
        '<div class="audit-only"><div class="muted small" style="margin-top:8px">원본 규칙 (judge.js 입력)</div><pre class="small" style="background:var(--bg);padding:8px;border-radius:6px;overflow:auto;margin:4px 0 0">' +
        esc(JSON.stringify(demo.rule, null, 1)) + "</pre></div></div>";
      html += '<div class="card"><h3 style="margin-top:0">결론과 사유별 동수</h3><p style="margin:0 0 10px">' + esc(demo.conclusion) + "</p>" +
        reasonTable(J) + "</div>";
      html += "</div>";

      html += "<h3>건물 명부</h3>";
      html += '<p class="small muted" style="margin:-4px 0 8px">확인 결과를 기록하면 적중률이 나옵니다 (온지붕 현장 확인 방식). ' +
        "현재 확인 " + fmt(cs.total) + "동 · 맞음 " + fmt(cs.yes) + " · 아님 " + fmt(cs.no) + " · 확인 불가 " + fmt(cs.unk) +
        " · <b>적중률 " + esc(cs.rate) + "</b></p>";
      html += '<div class="tabs no-print" id="r-tabs"></div><div class="toolbar no-print"><span class="muted small">' +
        "PNU·주용도·면적·층수·사용승인일만 표시합니다. 건물명·소유자는 수집하지 않습니다.</span>" +
        '<span class="spacer"></span><button type="button" class="btn ghost" id="r-csv">이 탭 CSV</button></div>' +
        '<div class="table-wrap" id="r-table"></div>';
      $view.innerHTML = html;

      if (ui.roster.no !== no) {
        ui.roster = { no: no, page: 0, tab: J.counts.대상 ? "대상" : J.counts.경계선 ? "경계선" : "판정불가" };
      }
      drawRoster(no);
      bindProgressBox(no, rerender);
      bindAskThis(no);
      document.getElementById("r-csv").addEventListener("click", function () {
        var rows = J.rows.filter(function (r) { return r.status === ui.roster.tab; });
        var c = checks[no] || {};
        downloadCSV("빼곡_" + no + "_" + ui.roster.tab + "_건물명부_" + stamp() + ".csv",
          ["PNU", "주용도코드", "주용도", "연면적(㎡)", "지상층수", "사용승인일", "판정", "사유", "확인 결과"],
          rows.map(function (r) {
            var p = r.p;
            return [p.pnu, p.usability || "", p.usability ? USE_NAMES[p.usability] || "" : "", p.totalarea, p.grnd_flr,
              ymd(p.useapr_day), r.status, r.reason, c[p.pnu] ? CHECK[c[p.pnu]] : ""];
          }));
      });
    }).catch(showError);
  }

  function reasonTable(J) {
    return '<table class="dt"><thead><tr><th>판정</th><th>사유</th><th class="num">동수</th></tr></thead><tbody>' +
      sortedReasons(J).map(function (k) {
        var p = k.split("|");
        return '<tr><td style="white-space:nowrap"><i class="sw s-' + p[0] + '" aria-hidden="true"></i>' + esc(p[0]) + "</td><td>" + esc(p[1]) + '</td><td class="num">' + fmt(J.reasons[k]) + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  function drawRoster(no) {
    var J = D.judged[no], r = ui.roster, c = checks[no] || {};
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
      "<th>사용승인일</th><th>사유</th><th>확인 결과</th></tr></thead><tbody>" +
      (rows.map(function (x) {
        var p = x.p, v = c[p.pnu] || "";
        return "<tr><td>" + esc(p.pnu) + "</td><td>" + esc(useName(p.usability)) + '</td><td class="num">' +
          (p.totalarea ? fmt(p.totalarea) : "-") + '</td><td class="num">' + (p.grnd_flr ? fmt(p.grnd_flr) : "-") + "</td><td>" +
          (ymd(p.useapr_day) || "-") + "</td><td>" + esc(x.reason) + '</td><td><select class="check" data-pnu="' + esc(p.pnu) + '">' +
          '<option value="">미확인</option>' + Object.keys(CHECK).map(function (k) {
            return '<option value="' + k + '"' + (v === k ? " selected" : "") + ">" + CHECK[k] + "</option>";
          }).join("") + "</select></td></tr>";
      }).join("") || '<tr><td colspan="7" class="muted">해당 건물이 없습니다.</td></tr>') +
      "</tbody></table>" + pager(r.page, pages, list.length);
    box.querySelectorAll("select.check").forEach(function (sel) {
      sel.addEventListener("change", function () {
        var m = checks[no] || {};
        if (sel.value) m[sel.getAttribute("data-pnu")] = sel.value; else delete m[sel.getAttribute("data-pnu")];
        checks[no] = m;
        save("checks", checks);
      });
    });
    bindPager(box, function (p) { r.page = p; drawRoster(no); });
  }

  // ---------------------------------------------------------------- 화면: 검토서 (A4 인쇄 · 한글)
  function reviewData(no) {
    var b = D.byNo[no], demo = D.demos[no], J = judgeBill(no), cs = checkStats(no);
    var means = { 대상: "기준을 모두 충족", 경계선: "기준에 근소하게 못 미침 (수치 ±10%, 연도 ±1년)",
      비대상: "기준에 해당하지 않음", 판정불가: "속성이 비어 있거나 시행령 위임으로 확정 불가" };
    var limits = [
      "판정 결과는 건축물 데이터(브이월드 건물통합정보) 기반 추정이며 법률 판단이 아닙니다.",
      "건축물대장 속성이 비어 있는 건물은 판정불가로 둡니다 (사창동 전체 2,448동 중 약 13.4%).",
      "법률이 용도·규모를 시행령에 위임한 경우, 나머지 기준을 충족해도 확정하지 않고 판정불가로 둡니다.",
      "주용도 코드와 법안 용어(예: 물류터미널)의 대응은 아직 검증하지 않았습니다.",
      "현장 확인 전 자료이므로, 대상 건물 통보 등 행정 조치에 바로 쓰지 마십시오.",
    ];
    var hits = J.rows.filter(function (r) { return r.status === "대상" || r.status === "경계선"; });
    return { b: b, demo: demo, J: J, cs: cs, means: means, limits: limits, hits: hits, memo: (progress[no] && progress[no].memo) || "" };
  }

  function viewPrint(no) {
    var b = D.byNo[no], demo = D.demos[no];
    if (!b || !demo) {
      $view.innerHTML = '<p>판정한 법안만 검토서를 만들 수 있습니다. <a href="#/bill/' + esc(no) + '">법안으로 돌아가기</a></p>';
      return;
    }
    $view.innerHTML = '<p class="muted">검토서를 만드는 중…</p>';
    loadProps().then(function () {
      if (location.hash !== "#/print/" + no) return;
      var R = reviewData(no), J = R.J;
      var blank = function (v) { return v ? esc(v) : "○○○"; };

      var html = '<div class="print-tools no-print"><a href="#/bill/' + no + '">← 법안으로</a><span style="flex:1"></span>' +
        '<label class="small">담당 부서 <input id="p-dept" value="' + esc(prefs.dept) + '" placeholder="예: 건축과"></label>' +
        '<label class="small">작성자 직위 <input id="p-writer" value="' + esc(prefs.writer) + '" placeholder="예: 주무관"></label>' +
        '<button type="button" class="btn ghost" id="p-hwpx">한글(HWPX) 내려받기</button>' +
        '<button type="button" class="btn" id="p-print">인쇄 · PDF로 저장</button></div>' +
        '<p class="no-print muted small">부서·직위만 이 브라우저에 저장됩니다. 이름 등 개인정보는 넣지 마세요. 비워 두면 ○○○로 인쇄되어 손으로 채울 수 있습니다.</p>';

      html += '<article class="doc">';
      html += "<h1>법안 영향 검토서</h1>";
      html += '<div class="doc-sub">' + esc(D.region) + " 건축물 대상 · 작성일 " + today() + " · 부서 " + blank(prefs.dept) + " · 작성 " + blank(prefs.writer) + "</div>";
      html += '<section class="doc-sec"><h2>1. 법안 개요</h2><table>' +
        "<tr><th>의안번호</th><td>" + esc(b.no) + "</td></tr><tr><th>법안명</th><td>" + esc(b.name) + "</td></tr>" +
        "<tr><th>소관위원회</th><td>" + esc(b.committee) + "</td></tr><tr><th>제안일</th><td>" + esc(b.date) + "</td></tr>" +
        "<tr><th>분야</th><td>" + esc(fieldName(b.field)) + " (자동 분류)" + (lowConf(b) ? ' <span class="flag">· 분류 확인 필요</span>' : "") + "</td></tr>" +
        "<tr><th>검토 쟁점</th><td>" + esc(demo.title) + "</td></tr></table></section>";
      html += '<section class="doc-sec"><h2>2. 적용 기준</h2><table>' +
        "<tr><th>법안 원문</th><td>" + esc(demo.source_text) + "</td></tr>" +
        "<tr><th>적용 규칙</th><td>" + ruleText(demo.rule).map(esc).join("<br>") + "</td></tr>" +
        "<tr><th>해석 메모</th><td>" + esc(demo.rule_note) + "</td></tr>" +
        "<tr><th>기준 추출</th><td>" + esc(demo.method || "사람 추출") + "</td></tr></table></section>";
      html += '<section class="doc-sec"><h2>3. 판정 결과 (' + esc(D.region) + " " + fmt(D.total) + "동)</h2><table>" +
        "<tr><th>구분</th><td><b>동수</b></td><td><b>비율</b></td><td><b>뜻</b></td></tr>" +
        STATUSES.map(function (s) {
          return "<tr><th>" + s + "</th><td>" + fmt(J.counts[s]) + "동</td><td>" + pct(J.counts[s], D.total) + "</td><td>" + R.means[s] + "</td></tr>";
        }).join("") + "</table><p><b>결론</b> " + esc(demo.conclusion) + "</p>" +
        (R.cs.total ? "<p><b>확인 기록</b> " + fmt(R.cs.total) + "동 확인 · 맞음 " + fmt(R.cs.yes) + " · 아님 " + fmt(R.cs.no) +
          " · 확인 불가 " + fmt(R.cs.unk) + " · 적중률 " + esc(R.cs.rate) + "</p>" : "") + "</section>";
      html += '<section class="doc-sec"><h2>4. 사유별 동수</h2><table><tr><th>판정</th><td><b>사유</b></td><td><b>동수</b></td></tr>' +
        sortedReasons(J).map(function (k) {
          var p = k.split("|");
          return "<tr><th>" + esc(p[0]) + "</th><td>" + esc(p[1]) + "</td><td>" + fmt(J.reasons[k]) + "동</td></tr>";
        }).join("") + "</table></section>";
      html += '<section class="doc-sec"><h2>5. 한계와 유의사항</h2><ul>' + R.limits.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") +
        "</ul>" + (R.memo ? "<p><b>담당 메모</b> " + esc(R.memo) + "</p>" : "") + "</section>";
      html += '<div class="sign doc-sec"><table><tr><th>담당</th><th>검토</th><th>결재</th></tr><tr><td></td><td></td><td></td></tr></table></div>';
      html += '<p class="foot">출처: 열린국회정보 Open API(법안), 국토교통부 브이월드 건물통합정보(건물). 빼곡 시제품으로 만든 초안이며 담당자 검토가 필요합니다.</p>';
      html += '<section class="attach"><h2>붙임. 대상·경계선 건물 목록</h2>';
      if (!R.hits.length) html += "<p>해당 건물 없음 (대상 0동, 경계선 0동).</p>";
      else {
        html += "<table><tr><th>PNU</th><td><b>주용도</b></td><td><b>연면적(㎡)</b></td><td><b>지상층수</b></td><td><b>사용승인일</b></td><td><b>판정</b></td></tr>" +
          R.hits.map(function (r) {
            var p = r.p;
            return "<tr><th>" + esc(p.pnu) + "</th><td>" + esc(useName(p.usability)) + "</td><td>" + (p.totalarea ? fmt(p.totalarea) : "-") +
              "</td><td>" + (p.grnd_flr || "-") + "</td><td>" + (ymd(p.useapr_day) || "-") + "</td><td>" + r.status + "</td></tr>";
          }).join("") + "</table>";
      }
      html += "</section></article>";
      $view.innerHTML = html;

      document.getElementById("p-print").addEventListener("click", function () { window.print(); });
      document.getElementById("p-hwpx").addEventListener("click", function (e) { downloadHwpx(no, e.target); });
      [["p-dept", "dept"], ["p-writer", "writer"]].forEach(function (p) {
        document.getElementById(p[0]).addEventListener("change", function (e) {
          var v = e.target.value.trim();
          if (PII.test(v)) { e.target.value = ""; return; }
          prefs[p[1]] = v;
          save("prefs", prefs);
          viewPrint(no);
        });
      });
    }).catch(showError);
  }

  // 한글(HWPX): 온지붕 방식의 최소 구조 문서. 표 대신 문단으로 같은 내용을 담는다.
  function downloadHwpx(no, btn) {
    var R = reviewData(no), J = R.J, b = R.b, demo = R.demo;
    var blank = function (v) { return v || "○○○"; };
    var L = [];
    var t = function (text, style, pageBreak) { L.push({ text: text, style: style, pageBreak: pageBreak }); };
    t("법안 영향 검토서", "title");
    t(D.region + " 건축물 대상 · 작성일 " + today() + " · 부서 " + blank(prefs.dept) + " · 작성 " + blank(prefs.writer), "small");
    t("1. 법안 개요", "head");
    t("의안번호: " + b.no); t("법안명: " + b.name); t("소관위원회: " + b.committee); t("제안일: " + b.date);
    t("분야: " + fieldText(b)); t("검토 쟁점: " + demo.title);
    t("2. 적용 기준", "head");
    t("법안 원문: " + demo.source_text); t("적용 규칙: " + ruleText(demo.rule).join(" / ")); t("해석 메모: " + demo.rule_note); t("기준 추출: " + (demo.method || "사람 추출"));
    t("3. 판정 결과 (" + D.region + " " + fmt(D.total) + "동)", "head");
    STATUSES.forEach(function (s) { t("· " + s + ": " + fmt(J.counts[s]) + "동 (" + pct(J.counts[s], D.total) + ") — " + R.means[s]); });
    t("결론: " + demo.conclusion);
    if (R.cs.total) t("확인 기록: " + fmt(R.cs.total) + "동 확인 · 맞음 " + fmt(R.cs.yes) + " · 아님 " + fmt(R.cs.no) + " · 적중률 " + R.cs.rate);
    t("4. 사유별 동수", "head");
    sortedReasons(J).forEach(function (k) { var p = k.split("|"); t("· " + p[0] + " — " + p[1] + ": " + fmt(J.reasons[k]) + "동"); });
    t("5. 한계와 유의사항", "head");
    R.limits.forEach(function (l) { t("· " + l); });
    if (R.memo) t("담당 메모: " + R.memo);
    t("담당 ○○○    검토 ○○○    결재 ○○○");
    t("출처: 열린국회정보 Open API(법안), 국토교통부 브이월드 건물통합정보(건물). 빼곡 시제품으로 만든 초안이며 담당자 검토가 필요합니다.", "small");
    t("붙임. 대상·경계선 건물 목록", "head", true);
    if (!R.hits.length) t("해당 건물 없음 (대상 0동, 경계선 0동).");
    R.hits.forEach(function (r) {
      var p = r.p;
      t(p.pnu + " · " + useName(p.usability) + " · " + (p.totalarea ? fmt(p.totalarea) + "㎡" : "-") + " · " + (p.grnd_flr || "-") + "층 · " +
        (ymd(p.useapr_day) || "-") + " · " + r.status);
    });
    btn.disabled = true;
    btn.textContent = "만드는 중…";
    Hwpx.build(L, "법안 영향 검토서 " + b.no).then(function (blob) {
      download("빼곡_법안영향검토서_" + b.no + "_" + stamp() + ".hwpx", blob);
    }).catch(function (e) { alert(e.message); }).then(function () {
      btn.disabled = false;
      btn.textContent = "한글(HWPX) 내려받기";
    });
  }

  // ---------------------------------------------------------------- 화면: 진행 현황
  function viewProgress() {
    var cnt = { todo: 0, doing: 0, hold: 0, done: 0 };
    D.bills.forEach(function (b) { cnt[pgOf(b.no)]++; });
    var active = D.bills.filter(function (b) { return pgOf(b.no) !== "todo" || (progress[b.no] && progress[b.no].memo); })
      .sort(function (a, b) { return ((progress[b.no] || {}).t || "") > ((progress[a.no] || {}).t || "") ? 1 : -1; });
    var html = '<h2>진행 현황</h2><p class="lead">법안 검토가 어디까지 됐는지. 기록은 이 브라우저에만 저장되므로, 담당자끼리는 CSV로 주고받습니다.</p>';
    html += '<div class="kpis">' + PG_KEYS.map(function (k) {
      return kpi(PG[k].label, fmt(cnt[k]) + "건", k === "done" ? "결재 대기" : k === "hold" ? "시행령 확정 등을 기다림" :
        k === "doing" ? "담당자가 보고 있음" : "계류 법안 " + fmt(D.bills.length) + "건 중", k === "done" && cnt.done > 0);
    }).join("") + "</div>";
    html += '<div class="toolbar no-print" style="margin-top:16px"><b>검토 기록</b><span class="spacer"></span>' +
      '<button type="button" class="btn ghost" id="pg-export">CSV 내보내기</button>' +
      '<label class="btn ghost" style="cursor:pointer">CSV 가져오기<input type="file" id="pg-import" accept=".csv,text/csv" hidden></label></div>' +
      '<p class="small muted" id="pg-msg"></p>';
    html += '<div class="table-wrap"><table class="dt"><thead><tr><th>진행</th><th>의안번호</th><th>법안명</th><th>사창동 영향</th><th>인계 메모</th><th>마지막 변경</th></tr></thead><tbody>' +
      (active.map(function (b) {
        var p = progress[b.no] || {}, d = D.demos[b.no];
        return "<tr><td>" + pgMark(b.no) + "</td><td>" + esc(b.no) + '</td><td class="title"><a href="#/bill/' + b.no + '">' + esc(b.name) +
          "</a></td><td class=\"small\">" + (d ? "대상 " + fmt(d.counts.대상) + " · 경계선 " + fmt(d.counts.경계선) + " · 판정불가 " + fmt(d.counts.판정불가) : "기준 추출 대기") +
          '</td><td class="small">' + esc(p.memo || "") + '</td><td class="small muted">' + when(p.t) + "</td></tr>";
      }).join("") || '<tr><td colspan="6" class="muted">아직 기록이 없습니다. 법안 상세에서 진행 상태를 바꾸거나, 목록에서 여러 건을 체크해 한꺼번에 바꿀 수 있습니다.</td></tr>') +
      "</tbody></table></div>";
    $view.innerHTML = html;

    document.getElementById("pg-export").addEventListener("click", function () {
      downloadCSV("빼곡_검토기록_" + stamp() + ".csv", ["의안번호", "법안명", "진행", "메모", "마지막 변경"],
        Object.keys(progress).map(function (no) {
          var p = progress[no], b = D.byNo[no];
          return [no, b ? b.name : "", PG[p.s] ? PG[p.s].label : p.s, p.memo || "", p.t || ""];
        }));
    });
    document.getElementById("pg-import").addEventListener("change", function (e) {
      var f = e.target.files[0];
      if (!f) return;
      f.text().then(function (text) {
        var rows = parseCSV(text), head = rows.shift() || [];
        var iNo = head.indexOf("의안번호"), iPg = head.indexOf("진행"), iMemo = head.indexOf("메모"), iT = head.indexOf("마지막 변경");
        if (iNo < 0 || iPg < 0) throw new Error("의안번호·진행 열이 있는 CSV가 아닙니다");
        var byLabel = {};
        PG_KEYS.forEach(function (k) { byLabel[PG[k].label] = k; });
        var n = 0, skipped = 0;
        rows.forEach(function (r) {
          var no = (r[iNo] || "").trim(), s = byLabel[(r[iPg] || "").trim()];
          if (!D.byNo[no] || !s) return;
          var memo = iMemo >= 0 ? (r[iMemo] || "").trim().slice(0, 300) : "";
          if (PII.test(memo)) { memo = ""; skipped++; }
          var t = iT >= 0 && r[iT] ? r[iT] : new Date().toISOString();
          var cur = progress[no];
          if (cur && cur.t && cur.t > t) return; // 더 최근 기록이 있으면 그대로 둠
          progress[no] = { s: s, memo: memo, t: t, log: ((cur && cur.log) || []).concat([[new Date().toISOString(), "CSV 가져오기: " + PG[s].label]]).slice(-30) };
          n++;
        });
        save("progress", progress);
        drawSideProgress();
        viewProgress();
        document.getElementById("pg-msg").textContent = fmt(n) + "건을 가져왔습니다." + (skipped ? " 개인정보로 보이는 메모 " + skipped + "건은 비웠습니다." : "");
      }).catch(function (err) { document.getElementById("pg-msg").textContent = "가져오지 못했습니다: " + err.message; });
    });
  }

  // ---------------------------------------------------------------- 화면: 판정 규칙·검증 (심사 모드)
  function viewRules() {
    var judgedNos = Object.keys(D.demos);
    var confs = D.bills.map(function (b) { return b.conf || 0; });
    var hi = confs.filter(function (c) { return c >= 0.9; }).length;
    var lo = confs.filter(function (c) { return c < 0.6; }).length;
    var card = function (id, title, state, body) {
      var color = { 채택: "done", 참고: "", 보류: "wait", 확인필요: "wait" }[state] || "";
      return '<div class="card" style="margin-bottom:10px"><div style="display:flex;gap:8px;align-items:center"><b>' + id + "</b><b>" + esc(title) +
        '</b><span class="tag ' + color + '">' + state + '</span></div><div class="small" style="margin-top:6px">' + body + "</div></div>";
    };
    var html = '<h2>판정 규칙·검증</h2><p class="lead">심사·감사용. 판정이 어떤 규칙으로 나왔고, 무엇을 확인했고, 무엇이 남았는지.</p>';
    html += "<h3>판정 규칙</h3>" +
      card("R-01", "대상", "채택", "추출한 기준(용도·연면적·층수·사용승인)을 모두 충족") +
      card("R-02", "경계선", "채택", "수치 기준의 90~100% (±10%), 사용승인 기준 1년 이내. 입법 사각지대 후보로 따로 셈") +
      card("R-03", "판정불가 — 속성 없음", "채택", "기준에 쓰는 속성이 비어 있으면 판정하지 않음 (값 0도 빈 값으로 봄)") +
      card("R-04", "판정불가 — 시행령 위임", "채택", "법률이 용도·규모를 대통령령에 넘긴 경우, 나머지 기준을 충족해도 확정하지 않음") +
      card("R-05", "주용도 코드 대응", "확인필요", "법안 용어(예: 물류터미널)를 건축물대장 주용도 코드(예: 08000 운수시설)로 옮긴 것은 사람이 정함. 세부용도 코드가 없어 더 좁힐 수 없음");
    html += "<h3>검증</h3>";
    var checksHtml = judgedNos.map(function (no) {
      var d = D.demos[no];
      return esc(no) + " " + esc(d.title) + ": 미리 계산 " + STATUSES.map(function (s) { return fmt(d.counts[s]); }).join(" / ") + " — 법안 상세를 열면 화면에서 다시 계산해 일치 여부를 표시";
    }).join("<br>");
    html += card("V-01", "판정 재현", "채택", "Python(collect/build_web_data.py)과 화면(judge.js)이 같은 규칙. 지도 화면도 열 때마다 콘솔에서 대조.<br>" + checksHtml) +
      card("V-02", "판정불가 비율", "참고", "사창동 2,448동 중 건축물대장 미연계 약 13.4%(328동). 판정한 법안마다 판정불가가 커지는 원인") +
      card("V-03", "분야 자동 분류 확신도", "참고", "확신도 0.9 이상 " + fmt(hi) + "건 · 0.6 미만 " + fmt(lo) + "건 (전체 " + fmt(D.bills.length) + "건). 낮은 법안은 분야 필터에서 빠지거나 잘못 들어갈 수 있음") +
      card("V-04", "기준 추출", "보류", "판정한 법안 " + judgedNos.length + "건 — " + methodSummary() + ". AI 추출 건은 원문 문구·수치를 자동 대조했지만 담당자 검토 전. 나머지 " + fmt(D.bills.length - judgedNos.length) + "건은 AI 추출(원문 수치 자동 대조) 단계에서 판정 예정") +
      card("V-05", "질의 도우미 답의 숫자", "채택", "서버가 답에 나온 숫자를 근거 자료와 대조해, 근거에 없는 숫자는 경고로 표시");
    $view.innerHTML = html;
  }

  // ---------------------------------------------------------------- 화면: 데이터·한계
  function viewSources() {
    $view.innerHTML = '<h2>데이터·한계</h2><p class="lead">이 화면의 숫자가 어디서 왔고, 어디까지 믿을 수 있는지</p>' +
      '<div class="table-wrap"><table class="dt"><thead><tr><th>자료</th><th>출처</th><th>범위</th><th>쓰는 곳</th></tr></thead><tbody>' +
      "<tr><td>법안 목록·제안이유</td><td>열린국회정보 Open API</td><td>22대 국회 계류 " + fmt(D.bills.length) + "건 (건축·주거·안전 관련 위원회)</td><td>법안 검토 목록, 분야 분류, 질의 도우미</td></tr>" +
      "<tr><td>분야 분류</td><td>팀 자체 Keras 신경망</td><td>9개 분야 자동 분류. 확신도 " + CONF_LOW + " 미만은 「분류 확인 필요」 표시</td><td>분야 필터 (자동 분류라 틀릴 수 있음)</td></tr>" +
      "<tr><td>건물 속성</td><td>국토교통부 브이월드 건물통합정보</td><td>" + esc(D.region) + " " + fmt(D.total) + "동 · PNU, 주용도, 연면적, 층수, 사용승인일</td><td>판정, 건물 명부</td></tr>" +
      "<tr><td>적용 기준</td><td>법안 원문에서 추출 (" + methodSummary() + ", 원문 대조)</td><td>" + Object.keys(D.demos).length + "건</td><td>판정 (나머지는 추출 예정)</td></tr>" +
      "<tr><td>질의 도우미</td><td>OpenAI (별도 서버 경유)</td><td>공개 법안 자료와 질문만 보냄. 설정에서 끌 수 있음</td><td>오른쪽 아래 「질의 도우미」</td></tr>" +
      "</tbody></table></div>" +
      "<h3>한계</h3><div class=\"note-box\"><ul style=\"margin:0;padding-left:18px\">" +
      "<li>판정 결과는 추정이며 법률 판단이 아닙니다. 현장 확인 전 자료입니다.</li>" +
      "<li>사창동 건물의 약 13.4%는 건축물대장 속성이 비어 판정불가입니다.</li>" +
      "<li>주용도 코드와 법안 용어의 대응은 검증 전입니다.</li>" +
      "<li>질의 도우미는 AI 답변입니다. 답 아래 근거 법안을 반드시 확인하세요.</li>" +
      "<li>이 화면은 시연용으로 공개되어 있습니다. 도입 시에는 행정망 내부에서만 씁니다. 건물명·소유자 등 개인정보는 처음부터 수집하지 않습니다.</li>" +
      "</ul></div>" +
      '<h3 id="intranet">행정망에 들일 때</h3><div class="table-wrap"><table class="dt"><thead><tr><th>항목</th><th>지금</th><th>행정망에서</th></tr></thead><tbody>' +
      '<tr><td>글꼴</td><td><span class="pg pg-done">완료</span> Pretendard 글꼴 파일을 화면과 함께 둠 (외부 글꼴 서버 안 씀)</td><td>그대로 사용</td></tr>' +
      "<tr><td>지도</td><td>브이월드 3D 지도 · 키가 없으면 OpenStreetMap 바탕의 가벼운 지도</td><td>행정망용 지도(기관 GIS) 또는 가벼운 지도로 교체 필요</td></tr>" +
      "<tr><td>질의 도우미</td><td>외부 AI 서버(OpenAI) 경유 · 지금 " + (prefs.ai ? "켜짐" : "꺼짐") + "</td><td>설정에서 끄거나, 기관이 허용한 AI로 교체</td></tr>" +
      "<tr><td>진행 기록 공유</td><td>이 브라우저에만 저장, 담당자끼리 CSV로 주고받음</td><td>함께 보려면 기관 내부 서버 필요</td></tr>" +
      "</tbody></table></div>";
  }

  // ---------------------------------------------------------------- 공통: 왼쪽 진행 카드 · 상태 바 · 개인정보 안내
  function drawSideProgress() {
    var cnt = { todo: 0, doing: 0, hold: 0, done: 0 };
    D.bills.forEach(function (b) { cnt[pgOf(b.no)]++; });
    document.getElementById("side-progress").innerHTML = '<div class="hd">검토 진행</div>' +
      PG_KEYS.map(function (k) {
        return '<div class="row">' + pgBadge(k) + "<b>" + fmt(cnt[k]) + "</b></div>";
      }).join("");
  }

  function modal(html) {
    var m = document.getElementById("modal");
    document.getElementById("modal-box").innerHTML = html;
    m.classList.remove("hidden");
    return m;
  }
  function closeModal() { document.getElementById("modal").classList.add("hidden"); }
  document.getElementById("modal").addEventListener("click", function (e) {
    if (e.target.id === "modal" || e.target.hasAttribute("data-close")) closeModal();
  });

  document.getElementById("privacy-btn").addEventListener("click", function () {
    modal("<h3>개인정보 처리 안내</h3><ul class=\"small\" style=\"padding-left:18px\">" +
      "<li><b>수집하지 않는 것</b>: 건물명, 소유자, 주소, 지번 상세. 건물은 PNU(필지 고유번호)와 대장 속성만 씁니다.</li>" +
      "<li><b>이 브라우저에만 저장</b>: 역할·모드 선택, 진행 상태, 인계 메모, 건물 확인 결과, 검토서의 부서·직위. 서버로 보내지 않습니다.</li>" +
      "<li><b>메모</b>: 전화번호·주민등록번호·이메일로 보이는 내용은 저장하지 않습니다. 이름·주소도 넣지 마세요.</li>" +
      "<li><b>질의 도우미</b>: 질문과 공개 법안 자료만 별도 서버를 거쳐 OpenAI로 보냅니다. 개인정보가 든 질문은 서버에서 거절합니다. 질문을 저장하지 않습니다.</li>" +
      "<li><b>공개 범위</b>: 시연용 공개 화면입니다. 도입 시 행정망 내부 전용으로 운영합니다.</li>" +
      "</ul><div style=\"text-align:right\"><button type=\"button\" class=\"btn\" data-close>닫기</button></div>");
  });

  // ---------------------------------------------------------------- 역할 · 모드
  var roleSel = document.getElementById("role");
  function applyPrefs() {
    roleSel.value = prefs.role || "review";
    document.body.classList.toggle("audit", prefs.mode === "audit");
    document.querySelectorAll("#mode button").forEach(function (b) {
      b.classList.toggle("on", b.getAttribute("data-mode") === prefs.mode);
    });
  }
  roleSel.addEventListener("change", function () {
    prefs.role = roleSel.value;
    save("prefs", prefs);
    location.hash = ROLES[prefs.role].start;
    route();
  });
  document.querySelectorAll("#mode button").forEach(function (b) {
    b.addEventListener("click", function () {
      prefs.mode = b.getAttribute("data-mode");
      save("prefs", prefs);
      applyPrefs();
      if (prefs.mode !== "audit" && location.hash === "#/rules") location.hash = "#/";
    });
  });

  // ---------------------------------------------------------------- 설정: 질의 도우미 켜고 끄기
  var aiPinged = false;
  function applyAi() {
    document.body.classList.toggle("no-ai", !prefs.ai);
    document.getElementById("pref-ai").checked = !!prefs.ai;
    var el = document.getElementById("st-ai");
    if (!prefs.ai) {
      document.getElementById("ask-panel").classList.add("hidden");
      document.getElementById("ask-fab").classList.add("hidden");
      el.innerHTML = '<i class="dot"></i>질의 도우미 꺼짐';
      aiPinged = false;
    } else {
      if (document.getElementById("ask-panel").classList.contains("hidden")) document.getElementById("ask-fab").classList.remove("hidden");
      if (!aiPinged) { aiPinged = true; el.innerHTML = '<i class="dot"></i>질의 도우미 확인 중'; pingAsk(); }
    }
  }
  var setBtn = document.getElementById("settings-btn"), setMenu = document.getElementById("settings-menu");
  function setMenuOpen(open) {
    setMenu.classList.toggle("hidden", !open);
    setBtn.setAttribute("aria-expanded", String(open));
  }
  setBtn.addEventListener("click", function (e) { e.stopPropagation(); setMenuOpen(setMenu.classList.contains("hidden")); });
  document.addEventListener("click", function (e) { if (!setMenu.contains(e.target) && !setBtn.contains(e.target)) setMenuOpen(false); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !setMenu.classList.contains("hidden")) { setMenuOpen(false); setBtn.focus(); }
  });
  document.getElementById("pref-ai").addEventListener("change", function (e) {
    prefs.ai = e.target.checked;
    save("prefs", prefs);
    applyAi();
    if (location.hash === "#/sources") route();
  });
  document.getElementById("role-btn").addEventListener("click", function () { setMenuOpen(false); welcome(); });

  // 처음 오면 역할을 고르게 한다 (사각119 첫 진입 화면)
  function welcome() {
    var m = modal('<h3>빼곡 행정 화면</h3><p class="small" style="margin:0">국회 계류 법안이 ' + esc(D.region) +
      " 건물에 미치는 영향을 검토하는 담당자 화면입니다. 역할은 첫 화면 순서만 바꾸며 권한 차이는 없습니다. 나중에 위쪽에서 바꿀 수 있습니다.</p>" +
      '<div class="role-pick">' + Object.keys(ROLES).map(function (k) {
        return '<button type="button" data-role="' + k + '"><b>' + ROLES[k].label + "</b><small>" + ROLES[k].desc + "</small></button>";
      }).join("") + '</div><p class="small muted" style="margin:0">시연용 공개 화면 · 도입 시 행정망 내부 전용. 로그인·서버 저장이 없습니다.</p>');
    m.querySelectorAll("[data-role]").forEach(function (b) {
      b.addEventListener("click", function () {
        prefs.role = b.getAttribute("data-role");
        save("prefs", prefs);
        applyPrefs();
        closeModal();
        location.hash = ROLES[prefs.role].start;
        route();
        if (!prefs.toured) setTimeout(startTour, 300);
      });
    });
  }

  // ---------------------------------------------------------------- 둘러보기 (온지붕·필지 블랙박스의 사용법 투어)
  var TOUR = [
    { sel: "#role", text: "역할을 고르면 첫 화면과 상황판 카드가 바뀝니다. 권한 차이는 없습니다." },
    { sel: "#mode", text: "심사·검증 모드에서는 판정 규칙·검증 메뉴와 원본 규칙이 함께 보입니다." },
    { sel: "#todo-cards", text: "지금 할 일: 검토 순서를 정해 줍니다. 법 적용 여부를 정하지는 않습니다." },
    { sel: '#nav a[data-route="bills"]', text: "법안 검토 목록에서 678건을 찾고, 여러 건의 진행 상태를 한꺼번에 바꿀 수 있습니다." },
    { sel: '#nav a[data-route="progress"]', text: "진행 현황에서 검토가 어디까지 됐는지 보고, 담당자끼리 CSV로 주고받습니다." },
    { sel: "#settings-btn", text: "설정에서 질의 도우미를 끄거나 둘러보기를 다시 볼 수 있습니다. 행정망에서는 질의 도우미를 끄세요." },
    { sel: "#ask-fab", text: "질의 도우미에게 법안과 판정 결과를 물어볼 수 있습니다. 답 아래 근거 법안이 함께 나옵니다." },
    { sel: "#privacy-btn", text: "무엇을 저장하고 무엇을 수집하지 않는지는 여기서 확인합니다." },
  ];
  var tourAt = 0;
  function startTour() {
    if (location.hash && location.hash !== "#/") { location.hash = "#/"; route(); }
    tourAt = 0;
    document.getElementById("tour").classList.remove("hidden");
    showTour();
  }
  function endTour() {
    document.getElementById("tour").classList.add("hidden");
    prefs.toured = true;
    save("prefs", prefs);
  }
  function showTour() {
    var steps = TOUR.filter(function (s) { var el = document.querySelector(s.sel); return el && el.offsetParent !== null; });
    if (tourAt >= steps.length) { endTour(); return; }
    var st = steps[tourAt], el = document.querySelector(st.sel);
    el.scrollIntoView({ block: "center" });
    var r = el.getBoundingClientRect(), hole = document.getElementById("tour-hole"), pop = document.getElementById("tour-pop");
    hole.style.left = r.left - 4 + "px"; hole.style.top = r.top - 4 + "px";
    hole.style.width = r.width + 8 + "px"; hole.style.height = r.height + 8 + "px";
    pop.innerHTML = "<div>" + esc(st.text) + '</div><div class="nav"><span class="muted small">' + (tourAt + 1) + " / " + steps.length +
      '</span><span><button type="button" class="linkish" id="tour-skip">그만 보기</button> <button type="button" class="btn" id="tour-next">' +
      (tourAt === steps.length - 1 ? "끝" : "다음") + "</button></span></div>";
    var top = r.bottom + 10;
    if (top + 120 > window.innerHeight) top = Math.max(10, r.top - 130);
    pop.style.top = top + "px";
    pop.style.left = Math.max(10, Math.min(window.innerWidth - 310, r.left)) + "px";
    document.getElementById("tour-next").onclick = function () { tourAt++; showTour(); };
    document.getElementById("tour-skip").onclick = endTour;
  }
  document.getElementById("tour-btn").addEventListener("click", function () { setMenuOpen(false); startTour(); });

  // ---------------------------------------------------------------- 질의 도우미 (AI, 별도 서버)
  var askBill = null;
  var panel = document.getElementById("ask-panel"), log = document.getElementById("ask-log");
  function openAsk(no) {
    if (!prefs.ai) return;
    askBill = no || null;
    panel.classList.remove("hidden");
    document.getElementById("ask-fab").classList.add("hidden");
    var ex = askBill
      ? [askBill + " 법안이 사창동에 미치는 영향은?", "이 법안의 판정불가는 왜 많아?", "이 법안 검토 때 확인할 점은?"]
      : ["소방 분야에서 최근 제안된 법안은?", "판정한 법안 결과를 요약해 줘", "노후 건축물 안전점검 관련 법안은?"];
    document.getElementById("ask-ex").innerHTML = ex.map(function (q) { return '<button type="button">' + esc(q) + "</button>"; }).join("");
    document.querySelectorAll("#ask-ex button").forEach(function (b) {
      b.addEventListener("click", function () { ask(b.textContent); });
    });
    document.getElementById("ask-q").focus();
  }
  function bindAskThis(no) {
    var b = document.getElementById("ask-this");
    if (b) b.addEventListener("click", function () { openAsk(no); });
  }
  document.getElementById("ask-fab").addEventListener("click", function () {
    var m = location.hash.match(/^#\/(?:bill|print)\/(\d+)$/);
    openAsk(m ? m[1] : null);
  });
  document.getElementById("ask-close").addEventListener("click", function () {
    panel.classList.add("hidden");
    document.getElementById("ask-fab").classList.remove("hidden");
  });
  document.getElementById("ask-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var q = document.getElementById("ask-q").value.trim();
    if (q) ask(q);
  });
  function ask(q) {
    document.getElementById("ask-q").value = "";
    var qDiv = document.createElement("div");
    qDiv.className = "msg q";
    qDiv.innerHTML = "<span>" + esc(q) + "</span>";
    log.appendChild(qDiv);
    var a = document.createElement("div");
    a.className = "msg a";
    a.innerHTML = '<div class="body muted">답을 찾는 중…</div>';
    log.appendChild(a);
    log.scrollTop = log.scrollHeight;
    if (PII.test(q)) {
      a.innerHTML = '<div class="body">전화번호·주민등록번호·이메일 같은 개인정보는 보내지 않았습니다. 빼고 다시 질문해 주세요.</div>';
      return;
    }
    fetch(ASK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: q, bill: askBill }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); })
      .then(function (j) {
        var src = (j.sources || []).map(function (s) { return '<a href="#/bill/' + s.no + '">' + esc(s.no) + " " + esc(s.name) + "</a>"; }).join(" · ");
        a.innerHTML = '<div class="body">' + esc(j.answer) + '</div><div class="meta">' +
          (j.fixed ? "고정 안내 (AI 미사용)" : '<span class="tag">AI 답변 · 근거는 아래 법안</span>') +
          (src ? "<div>근거: " + src + "</div>" : "") +
          ((j.unverified && j.unverified.length) ? '<div class="warn">⚠ 근거 자료에 없는 숫자: ' + esc(j.unverified.join(", ")) + " — 직접 확인하세요</div>" : "") +
          "</div>";
        log.scrollTop = log.scrollHeight;
      })
      .catch(function (e) {
        a.innerHTML = '<div class="body">질의 도우미에 연결하지 못했습니다: ' + esc(e.message) + "</div>";
      });
  }
  function pingAsk() {
    var el = document.getElementById("st-ai");
    if (!prefs.ai) return; // 꺼져 있으면 서버에 묻지 않는다
    fetch(ASK_URL).then(function (r) { return r.json(); }).then(function (j) {
      el.innerHTML = '<i class="dot ' + (j.ok ? "ok" : "bad") + '"></i>질의 도우미 ' + (j.ok ? "연결됨" : "키 없음");
    }).catch(function () { el.innerHTML = '<i class="dot bad"></i>질의 도우미 연결 안 됨'; });
  }

  // ---------------------------------------------------------------- 라우터
  function route() {
    var h = location.hash.replace(/^#/, "") || "/";
    var m, key = "home";
    if (h === "/bills") { key = "bills"; viewBills(); }
    else if ((m = h.match(/^\/bill\/(\d+)$/))) { key = "bills"; viewBill(m[1]); }
    else if ((m = h.match(/^\/print\/(\d+)$/))) { key = "bills"; viewPrint(m[1]); }
    else if (h === "/progress") { key = "progress"; viewProgress(); }
    else if (h === "/rules") { key = "rules"; viewRules(); }
    else if (h === "/sources") { key = "sources"; viewSources(); }
    else viewHome();
    document.querySelectorAll("#nav a").forEach(function (a) {
      a.classList.toggle("active", a.getAttribute("data-route") === key);
    });
    window.scrollTo(0, 0);
  }

  function showError(err) {
    console.error(err);
    $view.innerHTML = "<p>데이터를 불러오지 못했습니다: " + esc(err.message) + "</p>";
  }

  applyPrefs();
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
    document.getElementById("st-bills").textContent = fmt(D.bills.length);
    document.getElementById("st-bldg").textContent = fmt(D.total);
    document.getElementById("hdr-bldg").textContent = fmt(D.total);
    drawSideProgress();
    window.addEventListener("hashchange", route);
    if (!prefs.role && SHOT) prefs.role = "review"; // 화면 찍기용: 창 없이 기본 역할 (저장 안 함)
    if (!prefs.role) { route(); welcome(); }
    else {
      if (!location.hash || location.hash === "#") location.hash = ROLES[prefs.role].start;
      route();
    }
    applyAi();
  }).catch(showError);
})();
