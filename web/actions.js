/*
 * 빼곡 · 다음 할 일 (법안 상세 화면: 지도·행정 화면 공용)
 *   1) 국회 의견서 초안: 관내 동수·적용 기준·근거 문구·의견 문단·판정불가 사유 → 미리보기 / 한글(HWPX) / 인쇄·PDF
 *   2) 현장 점검 목록: 대상+경계선 건물을 사용승인 연도 오래된 순(같으면 연면적 큰 순) → CSV / 한글(HWPX), 지도 순번 배지
 *
 * 계산 함수(inspectionList, opinionAuto, opinionHtml, opinionLines, checklistCsv, checklistLines)는 DOM 없이 돌아
 * node 시험(server/test/next-actions.js)에서도 쓴다. 건물명·소유자는 다루지 않는다 (자료에 없음).
 */
(function (global) {
  "use strict";

  var Judge = global.Judge || (typeof require === "function" ? require("./judge.js") : null);

  var BADGE_N = 20; // 지도에 순번 배지를 붙이는 상위 건물 수
  var DISCLAIMER = "이 자료는 건축물 데이터(브이월드 건물통합정보, 건축물대장 표제부) 기반 추정이며 법률 판단이 아닙니다.";
  var CHECK_HEADER = ["순번", "PNU", "용도", "연면적(㎡)", "층수", "사용승인일", "판정"];

  function fmt(n) { return Number(n).toLocaleString("ko-KR"); }
  function empty(v) { return Judge.isEmpty(v); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ymd(d) {
    if (empty(d)) return "";
    d = String(d);
    return d.length >= 8 ? d.slice(0, 4) + "." + d.slice(4, 6) + "." + d.slice(6, 8) : d;
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + "." + String(d.getMonth() + 1).padStart(2, "0") + "." + String(d.getDate()).padStart(2, "0");
  }

  /** 적용 규칙을 사람이 읽는 줄로 (행정 화면 ruleText 와 같은 표현) */
  function ruleLines(rule) {
    var out = [];
    if (rule.용도) out.push("주용도: " + rule.용도.map(Judge.useName).join(", "));
    ["연면적", "층수", "세대수"].forEach(function (k) {
      var r = rule[k];
      if (!r) return;
      var unit = { 연면적: "㎡", 층수: "층", 세대수: "세대" }[k];
      if (r.min !== undefined) out.push(k + " " + fmt(r.min) + unit + " 이상");
      if (r.max !== undefined) out.push(k + " " + fmt(r.max) + unit + " 이하");
    });
    if (rule.사용승인) out.push("사용승인 " + ymd(rule.사용승인.before) + " 이전");
    if (rule.위임 && rule.위임.length) out.push("시행령 위임: " + rule.위임.join("·") + " (확정 불가)");
    return out;
  }

  /**
   * 판정 요약: 동수와 사유별 동수. props 는 건물 속성 배열, rule 은 demo.rule
   * 반환 { counts, reasons: {"판정|사유": n}, unknownReasons: [[사유, n], ...] }
   */
  function summarize(props, rule) {
    var res = Judge.countAll(props, rule);
    var unknown = Object.keys(res.reasons).filter(function (k) { return k.indexOf("판정불가|") === 0; })
      .map(function (k) { return [k.split("|")[1], res.reasons[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });
    return { counts: res.counts, reasons: res.reasons, unknownReasons: unknown, total: props.length };
  }

  /**
   * 현장 점검 목록: 대상+경계선 건물을 사용승인 연도가 오래된 순, 같으면 연면적 큰 순.
   * 사용승인일·연면적이 비면 뒤로 보낸다. 같은 연도·면적이면 PNU 순(결과가 늘 같도록).
   * idx 는 props 안의 위치(지도 배지에 씀). 반환 [{rank, idx, pnu, use, useName, area, floors, date, status}]
   */
  function inspectionList(props, rule) {
    var rows = [];
    props.forEach(function (p, i) {
      var r = Judge.judge(p, rule);
      if (r.status !== "대상" && r.status !== "경계선") return;
      rows.push({ idx: i, p: p, status: r.status });
    });
    var yearOf = function (p) {
      if (empty(p.useapr_day)) return Infinity;
      var y = parseInt(String(p.useapr_day).slice(0, 4), 10);
      return isNaN(y) ? Infinity : y;
    };
    var areaOf = function (p) { return empty(p.totalarea) ? -1 : Number(p.totalarea); };
    rows.sort(function (a, b) {
      return (yearOf(a.p) - yearOf(b.p)) || (areaOf(b.p) - areaOf(a.p)) || (String(a.p.pnu) < String(b.p.pnu) ? -1 : String(a.p.pnu) > String(b.p.pnu) ? 1 : 0);
    });
    return rows.map(function (x, k) {
      var p = x.p;
      return {
        rank: k + 1, idx: x.idx, pnu: String(p.pnu || ""),
        use: empty(p.usability) ? "" : String(p.usability), useName: empty(p.usability) ? "" : Judge.useName(p.usability),
        area: empty(p.totalarea) ? null : Number(p.totalarea), floors: empty(p.grnd_flr) ? null : Number(p.grnd_flr),
        date: ymd(p.useapr_day), status: x.status,
      };
    });
  }

  /** 의견 문단 자동 생성 (숫자로). S = summarize 결과, demo = 시범 규칙 */
  function opinionAuto(S, demo, region) {
    var c = S.counts, t = c.대상, n = c.경계선, u = c.판정불가;
    var deleg = demo.rule.위임 && demo.rule.위임.length;
    var out = [];
    region = region || "사창동";
    if (t + n === 0) {
      out.push(region + "에는 이 법안의 기준을 충족하거나 근접한 건물이 없어, 관내 건축물에 대한 직접 영향은 크지 않을 것으로 보입니다.");
    } else if (n > 0) {
      var share = Math.round(n / (t + n) * 100);
      out.push(region + " 건물 중 대상은 " + fmt(t) + "동이고, 기준에 근소하게 못 미치는 경계선 건물이 " + fmt(n) + "동(대상과 경계선 합계의 " + share + "%) 있습니다.");
      out.push("경계선 건물은 수치 기준의 ±10%, 연도 기준의 ±1년 안에 있어, 심사 과정이나 시행령에서 기준이 조금만 달라져도 대상이 바뀔 수 있는 건물입니다.");
      out.push("기준 수치를 정할 때 이 " + fmt(n) + "동의 규모와 사용승인 연도 분포를 함께 검토해 주실 것을 건의합니다.");
    } else {
      out.push(region + " 건물 중 대상은 " + fmt(t) + "동이며, 기준에 근접한 경계선 건물은 없어 기준이 조금 달라지더라도 관내 대상 동수는 크게 바뀌지 않을 것으로 보입니다.");
    }
    if (deleg && u > 0) {
      out.push("다만 대상 범위를 시행령에 위임하고 있어 " + fmt(u) + "동은 판정불가로 두었으며, 시행령안이 나오면 다시 확인이 필요합니다.");
    } else if (u > 0) {
      out.push("건축물 속성이 비어 판정하지 못한 " + fmt(u) + "동은 현장 확인이 필요합니다.");
    }
    return out.join(" ");
  }

  /** 의견서 내용 (미리보기·HWPX·PDF 공통). info = {bill, demo, S, opinion, region, dept} */
  function opinionModel(info) {
    var b = info.bill, demo = info.demo, S = info.S, c = S.counts;
    var region = info.region || "사창동";
    return {
      title: "법안 영향 의견서 (초안)",
      sub: region + " 건축물 대상 · 작성일 " + (info.date || today()) + " · 부서 " + (info.dept || "○○○"),
      overview: [["법안명", b.name], ["의안번호", b.no], ["소관위원회", b.committee]],
      counts: [["대상", c.대상, "기준을 모두 충족"], ["경계선", c.경계선, "기준에 근소하게 못 미침 (수치 ±10%, 연도 ±1년)"],
        ["판정불가", c.판정불가, "속성이 비어 있거나 시행령 위임으로 확정 불가"]],
      total: S.total, region: region,
      rules: ruleLines(demo.rule), quote: demo.source_text,
      opinion: (info.opinion != null && String(info.opinion).trim()) ? String(info.opinion).trim() : opinionAuto(S, demo, region),
      unknown: S.unknownReasons,
      disclaimer: DISCLAIMER,
    };
  }

  function opinionHtml(info) {
    var M = opinionModel(info);
    var h = '<article class="op-doc"><h1>' + esc(M.title) + '</h1><div class="op-sub">' + esc(M.sub) + "</div>";
    h += "<h2>1. 법안 개요</h2><table>" + M.overview.map(function (r) { return "<tr><th>" + esc(r[0]) + "</th><td>" + esc(r[1]) + "</td></tr>"; }).join("") + "</table>";
    h += "<h2>2. 관내(" + esc(M.region) + ") 영향 · 전체 " + fmt(M.total) + "동</h2><table>" +
      M.counts.map(function (r) { return "<tr><th>" + r[0] + "</th><td><b>" + fmt(r[1]) + "동</b></td><td>" + esc(r[2]) + "</td></tr>"; }).join("") + "</table>";
    h += "<h2>3. 적용 기준과 근거 문구</h2><table><tr><th>근거 문구</th><td>" + esc(M.quote) + "</td></tr><tr><th>적용 기준</th><td>" +
      M.rules.map(esc).join("<br>") + "</td></tr></table>";
    h += "<h2>4. 의견</h2><p>" + esc(M.opinion) + "</p>";
    h += "<h2>5. 판정불가 사유</h2>" + (M.unknown.length
      ? "<ul>" + M.unknown.map(function (r) { return "<li>" + esc(r[0]) + ": " + fmt(r[1]) + "동</li>"; }).join("") + "</ul>"
      : "<p>판정불가 건물 없음</p>");
    h += '<p class="op-disc">' + esc(M.disclaimer) + " 담당자 검토 전 초안입니다.</p></article>";
    return h;
  }

  /** Hwpx.build 에 넘길 문단 목록 */
  function opinionLines(info) {
    var M = opinionModel(info), L = [];
    var t = function (text, style) { L.push({ text: text, style: style }); };
    t(M.title, "title"); t(M.sub, "small");
    t("1. 법안 개요", "head"); M.overview.forEach(function (r) { t(r[0] + ": " + r[1]); });
    t("2. 관내(" + M.region + ") 영향 · 전체 " + fmt(M.total) + "동", "head");
    M.counts.forEach(function (r) { t("· " + r[0] + ": " + fmt(r[1]) + "동 (" + r[2] + ")"); });
    t("3. 적용 기준과 근거 문구", "head"); t("근거 문구: " + M.quote); M.rules.forEach(function (r) { t("· " + r); });
    t("4. 의견", "head"); t(M.opinion);
    t("5. 판정불가 사유", "head");
    if (M.unknown.length) M.unknown.forEach(function (r) { t("· " + r[0] + ": " + fmt(r[1]) + "동"); }); else t("판정불가 건물 없음");
    t(M.disclaimer + " 담당자 검토 전 초안입니다.", "small");
    return L;
  }

  function checklistRows(list) {
    return list.map(function (r) {
      return [r.rank, r.pnu, r.useName || "-", r.area == null ? "-" : fmt(r.area), r.floors == null ? "-" : r.floors, r.date || "-", r.status];
    });
  }
  /** CSV 텍스트 (엑셀용 BOM 포함). 쉼표가 든 값(연면적 1,234)은 따옴표로 감싼다 */
  function checklistCsv(list) {
    var cell = function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return "﻿" + [CHECK_HEADER].concat(checklistRows(list)).map(function (r) { return r.map(cell).join(","); }).join("\r\n");
  }
  function checklistLines(bill, list, region) {
    var L = [{ text: "현장 점검 목록", style: "title" },
      { text: bill.name + " (의안 " + bill.no + ") · " + (region || "사창동") + " 대상·경계선 " + fmt(list.length) + "동 · 작성일 " + today(), style: "small" },
      { text: "정렬: 사용승인 연도가 오래된 순, 같으면 연면적 큰 순. 건물명·소유자는 넣지 않습니다.", style: "small" },
      { text: CHECK_HEADER.join(" · "), style: "head" }];
    checklistRows(list).forEach(function (r) { L.push({ text: r.join(" · ") }); });
    if (!list.length) L.push({ text: "해당 건물 없음 (대상 0동, 경계선 0동)." });
    L.push({ text: DISCLAIMER + " 현장 확인 전 자료입니다.", style: "small" });
    return L;
  }

  // ------------------------------------------------------------------ 화면 (브라우저에서만)
  var STORE = "ppaegok.opinion";
  function loadOpinions() { try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch (e) { return {}; } }
  function saveOpinion(no, text) {
    try { var m = loadOpinions(); if (text) m[no] = text; else delete m[no]; localStorage.setItem(STORE, JSON.stringify(m)); } catch (e) { /* 저장 못 해도 화면은 동작 */ }
  }
  function savedOpinion(no) { return loadOpinions()[no] || null; }

  function fileStamp() { return today().replace(/\./g, ""); }
  function download(name, blob) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  function hwpx(lines, title, name, btn) {
    var label = btn.textContent;
    btn.disabled = true; btn.textContent = "만드는 중…";
    return global.Hwpx.build(lines, title).then(function (blob) { download(name, blob); })
      .catch(function (e) { alert(e.message); })
      .then(function () { btn.disabled = false; btn.textContent = label; });
  }

  var DOC_CSS = ".op-doc{font-family:'Pretendard Variable',Pretendard,'Malgun Gothic',sans-serif;color:#111;line-height:1.6;font-size:14px}" +
    ".op-doc h1{font-size:22px;margin:0 0 4px;text-align:center}.op-doc .op-sub{text-align:center;color:#555;font-size:12px;margin-bottom:14px}" +
    ".op-doc h2{font-size:15px;margin:16px 0 6px;border-bottom:1px solid #333;padding-bottom:2px}" +
    ".op-doc table{width:100%;border-collapse:collapse}.op-doc th,.op-doc td{border:1px solid #999;padding:5px 8px;text-align:left;vertical-align:top}" +
    ".op-doc th{width:96px;background:#f2f2f2;font-weight:600}.op-doc p{margin:6px 0}.op-doc ul{margin:4px 0;padding-left:20px}" +
    ".op-doc .op-disc{margin-top:16px;font-size:12px;color:#444;border-top:1px dashed #999;padding-top:6px}";

  /** 인쇄 창을 열어 PDF 로 저장 (브라우저 인쇄 대화상자) */
  function printDoc(html, title) {
    var w = window.open("", "_blank");
    if (!w) { alert("팝업이 막혀 인쇄 창을 열지 못했습니다. 팝업을 허용해 주세요."); return; }
    w.document.write("<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><title>" + esc(title) + "</title><style>" +
      "@page{size:A4;margin:18mm}body{margin:0;padding:24px}" + DOC_CSS + "</style></head><body>" + html +
      "<script>window.onload=function(){setTimeout(function(){window.print()},150)}<\/script></body></html>");
    w.document.close();
  }

  /** 의견서 미리보기 창 (화면 위에 덮음) */
  function preview(html, title, onHwpx, onPdf) {
    var old = document.getElementById("op-modal");
    if (old) old.remove();
    var m = document.createElement("div");
    m.id = "op-modal";
    m.className = "op-modal";
    m.setAttribute("role", "dialog");
    m.setAttribute("aria-modal", "true");
    m.setAttribute("aria-label", title);
    m.innerHTML = '<div class="op-sheet"><div class="op-bar"><b>' + esc(title) + '</b><span class="op-sp"></span>' +
      '<button type="button" class="na-btn" data-op="hwpx">한글(HWPX)</button><button type="button" class="na-btn" data-op="pdf">인쇄 · PDF</button>' +
      '<button type="button" class="na-btn ghost" data-op="close" aria-label="미리보기 닫기">닫기</button></div>' +
      '<div class="op-paper"><style>' + DOC_CSS + "</style>" + html + "</div></div>";
    document.body.appendChild(m);
    var close = function () { m.remove(); document.removeEventListener("keydown", onKey); };
    var onKey = function (e) { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    m.addEventListener("click", function (e) {
      if (e.target === m) { close(); return; }
      var b = e.target.closest("[data-op]");
      if (!b) return;
      var k = b.getAttribute("data-op");
      if (k === "close") close(); else if (k === "hwpx") onHwpx(b); else if (k === "pdf") onPdf();
    });
    m.querySelector('[data-op="close"]').focus();
  }

  /**
   * 패널 그리기. opts = { el, bill, demo, props, region, compact(지도 왼쪽 패널), mapHref(행정 화면: 지도로 가는 주소),
   *   badges(지도: 현재 배지 표시 여부), onBadges(fn(on, list)) }
   */
  function render(opts) {
    var b = opts.bill, demo = opts.demo, no = b.no, region = opts.region || "사창동";
    var S = summarize(opts.props, demo.rule);
    var list = inspectionList(opts.props, demo.rule);
    var auto = opinionAuto(S, demo, region);
    var text = savedOpinion(no) || auto;
    var showN = opts.compact ? 5 : BADGE_N;
    var info = function () { return { bill: b, demo: demo, S: S, opinion: text, region: region, dept: opts.dept }; };

    var rows = list.slice(0, showN).map(function (r) {
      return "<tr><td class=\"num\">" + r.rank + "</td><td>" + esc(r.pnu) + "</td><td>" + esc(r.useName || "-") + '</td><td class="num">' +
        (r.area == null ? "-" : fmt(r.area)) + '</td><td class="num">' + (r.floors == null ? "-" : r.floors) + "</td><td>" + esc(r.date || "-") +
        '</td><td><i class="na-dot na-' + r.status + '"></i>' + r.status + "</td></tr>";
    }).join("");

    var h = '<section class="next-actions' + (opts.compact ? " compact" : "") + '" aria-labelledby="na-h-' + no + '">' +
      '<h3 id="na-h-' + no + '">다음 할 일</h3>' +
      '<div class="na-step"><div class="na-step-h"><span class="na-num">1</span><b>국회 의견서 초안</b>' +
      '<span class="na-sub">대상 ' + fmt(S.counts.대상) + " · 경계선 " + fmt(S.counts.경계선) + " · 판정불가 " + fmt(S.counts.판정불가) + "동</span></div>" +
      '<label class="na-label" for="na-op-' + no + '">의견 문단 <span class="na-hint">숫자로 자동 작성, 고쳐 쓸 수 있음 (이 브라우저에만 저장)</span></label>' +
      '<textarea id="na-op-' + no + '" class="na-op" rows="' + (opts.compact ? 6 : 4) + '">' + esc(text) + "</textarea>" +
      '<div class="na-btns"><button type="button" class="na-btn" data-na="preview">의견서 미리보기</button>' +
      '<button type="button" class="na-btn ghost" data-na="op-hwpx">한글(HWPX)</button>' +
      '<button type="button" class="na-btn ghost" data-na="op-pdf">인쇄 · PDF</button>' +
      '<button type="button" class="na-btn link" data-na="reset" title="자동 작성한 문단으로 되돌리기">자동 문단으로</button></div></div>';

    h += '<div class="na-step"><div class="na-step-h"><span class="na-num">2</span><b>현장 점검 목록</b>' +
      '<span class="na-sub">대상·경계선 ' + fmt(list.length) + "동 · 사용승인 오래된 순</span></div>";
    if (list.length) {
      h += '<div class="na-table"><table><thead><tr><th class="num">순번</th><th>PNU</th><th>용도</th><th class="num">연면적(㎡)</th><th class="num">층수</th><th>사용승인일</th><th>판정</th></tr></thead><tbody>' +
        rows + "</tbody></table></div>" +
        (list.length > showN ? '<p class="na-hint">상위 ' + showN + "동만 보입니다. 전체 " + fmt(list.length) + "동은 CSV·한글로 받습니다.</p>" : "") +
        '<div class="na-btns"><button type="button" class="na-btn ghost" data-na="ck-csv">CSV</button>' +
        '<button type="button" class="na-btn ghost" data-na="ck-hwpx">한글(HWPX)</button>' +
        (opts.mapHref ? '<a class="na-btn" href="' + esc(opts.mapHref) + '">지도에서 순번 보기 (상위 ' + BADGE_N + "동)</a>" : "") +
        (opts.onBadges ? '<label class="na-check"><input type="checkbox" data-na="badges"' + (opts.badges ? " checked" : "") + "> 지도에 순번 표시 (상위 " + BADGE_N + "동)</label>" : "") +
        "</div>";
    } else {
      h += '<p class="na-hint">대상·경계선 건물이 없어 점검할 건물이 없습니다.</p>';
    }
    h += '<p class="na-hint">건물명·소유자는 넣지 않습니다. 건축물 데이터 기반 추정이며 법률 판단이 아닙니다.</p></div></section>';
    opts.el.innerHTML = h;

    var box = opts.el.querySelector(".next-actions");
    var ta = box.querySelector(".na-op");
    ta.addEventListener("input", function () { text = ta.value; saveOpinion(no, ta.value.trim() === auto ? "" : ta.value); });
    var opHwpx = function (btn) { return hwpx(opinionLines(info()), "법안 영향 의견서 " + no, "빼곡_법안영향의견서_" + no + "_" + fileStamp() + ".hwpx", btn); };
    var opPdf = function () { printDoc(opinionHtml(info()), "법안 영향 의견서 " + no); };
    box.addEventListener("click", function (e) {
      var btn = e.target.closest("button[data-na]");
      if (!btn) return;
      var k = btn.getAttribute("data-na");
      if (k === "preview") preview(opinionHtml(info()), "의견서 미리보기 · 의안 " + no, opHwpx, opPdf);
      else if (k === "op-hwpx") opHwpx(btn);
      else if (k === "op-pdf") opPdf();
      else if (k === "reset") { text = auto; ta.value = auto; saveOpinion(no, ""); }
      else if (k === "ck-csv") download("빼곡_현장점검목록_" + no + "_" + fileStamp() + ".csv", new Blob([checklistCsv(list)], { type: "text/csv;charset=utf-8" }));
      else if (k === "ck-hwpx") hwpx(checklistLines(b, list, region), "현장 점검 목록 " + no, "빼곡_현장점검목록_" + no + "_" + fileStamp() + ".hwpx", btn);
    });
    var cb = box.querySelector('input[data-na="badges"]');
    if (cb) cb.addEventListener("change", function () { opts.onBadges(cb.checked, list.slice(0, BADGE_N)); });
    return { list: list, S: S };
  }

  var api = {
    BADGE_N: BADGE_N, DISCLAIMER: DISCLAIMER, CHECK_HEADER: CHECK_HEADER,
    ruleLines: ruleLines, summarize: summarize, inspectionList: inspectionList, opinionAuto: opinionAuto,
    opinionModel: opinionModel, opinionHtml: opinionHtml, opinionLines: opinionLines,
    checklistCsv: checklistCsv, checklistLines: checklistLines, render: render,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.NextActions = api;
})(this);
