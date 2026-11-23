/*
 * 빼곡 검토 진행 공유 (Supabase, 시연용 클라우드 DB)
 *
 * 시연용: 로그인 없이 역할을 고르는 방식. 실제 도입 시 기관 통합로그인(SSO)·공무원 인증서(GPKI)와 연동
 *
 * 실제 도입 시에는 기관 내부 DB 로 바꾼다. 이 파일만 바꾸면 되도록 행정 화면(admin.js)과는 작은 연결부(hook)로만 잇는다.
 *
 *   - 키가 없으면(web/config.js 자리 표시 그대로) 아무것도 하지 않는다. 외부로 요청도 보내지 않는다 → 지금과 똑같이 동작
 *   - 키가 있으면 supabase-js(고정 버전, 무결성 확인)를 받아 review_progress 를 읽고 실시간으로 받는다 (공개 키, 읽기만)
 *   - 화면 맨 위에서 역할(담당자 / 결재자)과 표시 이름을 고른다. 이 브라우저(localStorage)에만 남는다
 *   - 쓰기는 브라우저가 Supabase 로 직접 하지 않고 서버(/api/progress, Vercel)에 보낸다.
 *     서버가 사이트·호출 수·길이·개인정보 모양·역할을 확인한 뒤 서비스 키로 DB 함수를 부른다
 *       담당자: 진행 상태·메모 저장, 이 브라우저 기록 가져오기
 *       결재자: 승인 / 반려 (검토 완료된 법안만), 승인 대기 목록
 *   - Supabase 나 저장 서버에 닿지 않으면 → 이 브라우저(localStorage) 기록을 그대로 쓴다
 */
(function () {
  "use strict";

  var SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
  var SDK_SRI = "sha384-GFr3yTh5lJznCbZfpTtXnwboFsxqtTQoeTZCRHhE0579KrRmlCzen5AA8ohaB5ug";
  var BANNER = "시연용 클라우드 DB, 실제 도입 시 기관 내부 DB로 교체";
  var NOTICE = "시연용: 로그인 없이 역할을 고르는 방식. 실제 도입 시 기관 통합로그인(SSO)·공무원 인증서(GPKI)와 연동";
  var ID_KEY = "ppaegok.cloudId";
  var CHUNK = 50; // 서버가 한 번에 받는 최대 건수
  var CFG = window.PPAEGOK_CONFIG || {};
  var URL_OK = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(String(CFG.supabaseUrl || ""));
  var KEY = String(CFG.supabaseAnonKey || "");
  var ENABLED = URL_OK && KEY.length > 20 && KEY.indexOf("__") !== 0;
  var SHOT = /[?&]shot=1(&|$)/.test(location.search);
  if (SHOT) ENABLED = false; // 화면 찍기용은 늘 이 브라우저 모드

  // off(키 없음) · loading · error(연결 실패) · ready
  var st = { state: ENABLED ? "loading" : "off", rows: {}, msg: "", err: "" };
  var id = loadId();
  var sb = null, hooks = null, channel = null;

  function loadId() {
    try {
      var v = JSON.parse(localStorage.getItem(ID_KEY) || "{}") || {};
      return { role: v.role === "담당자" || v.role === "결재자" ? v.role : "", name: String(v.name || "").trim().slice(0, 20) };
    } catch (e) { return { role: "", name: "" }; }
  }
  function saveId() {
    try { localStorage.setItem(ID_KEY, JSON.stringify(id)); } catch (e) { /* 저장 불가 */ }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function when(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return (d.getMonth() + 1) + "." + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }
  function who(name) { return name ? String(name) : "알 수 없음"; }
  function label(s) { return (hooks && hooks.PG && hooks.PG[s]) ? hooks.PG[s].label : s; }
  function apiUrl() { return ((hooks && hooks.apiBase) || "") + "/api/progress"; }

  // ------------------------------------------------------------ 역할
  function ready() { return st.state === "ready"; }
  function hasId() { return !!(id.role && id.name); }
  function isEditor() { return ready() && hasId() && id.role === "담당자"; }
  function isApprover() { return ready() && hasId() && id.role === "결재자"; }

  // ------------------------------------------------------------ 상태 바꾸기
  function rowToProgress(r) {
    return { s: r.status, memo: r.memo || "", t: r.updated_at, log: [], editor: r.editor, decision: r.decision || "" };
  }
  function cloudProgress() {
    var out = {};
    Object.keys(st.rows).forEach(function (no) { out[no] = rowToProgress(st.rows[no]); });
    return out;
  }
  function set(state, extra) {
    var wasReady = ready();
    st.state = state;
    if (extra) Object.keys(extra).forEach(function (k) { st[k] = extra[k]; });
    if (!hooks) return;
    if (state === "ready") hooks.setProgress(cloudProgress());
    else if (wasReady) hooks.setProgress(hooks.localProgress());
    drawBar();
    var foot = document.getElementById("st-store");
    if (foot) foot.textContent = state === "ready" ? "진행 기록은 클라우드(시연용)에 저장" : "진행 기록은 이 브라우저에만 저장";
    hooks.refresh();
  }

  // ------------------------------------------------------------ 연결 (읽기: 공개 키 / 쓰기: 저장 서버)
  function loadSdk() {
    return new Promise(function (resolve, reject) {
      if (window.supabase && window.supabase.createClient) { resolve(); return; }
      var s = document.createElement("script");
      s.src = SDK;
      s.integrity = SDK_SRI;
      s.crossOrigin = "anonymous";
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("supabase-js 를 받지 못했습니다")); };
      document.head.appendChild(s);
    });
  }

  // 예전 이메일 로그인이 남긴 세션(이메일이 들어 있음)을 지운다
  function dropOldSession() {
    try {
      Object.keys(localStorage).forEach(function (k) { if (/^sb-.*-auth-token/.test(k)) localStorage.removeItem(k); });
    } catch (e) { /* 무시 */ }
  }

  function health() {
    return fetch(apiUrl(), { method: "GET" }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (!j || !j.ok) throw new Error("저장 서버에 연결하지 못했습니다"); });
  }

  function start() {
    dropOldSession();
    loadSdk().then(function () {
      sb = window.supabase.createClient(CFG.supabaseUrl, KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      return Promise.all([loadRows(), health()]);
    }).then(function () {
      subscribe();
      set("ready");
    }).catch(function (e) {
      set("error", { err: (e && e.message) || "연결 실패" });
    });
  }

  function loadRows() {
    return sb.from("review_progress").select("*").range(0, 4999).then(function (r) {
      if (r.error) throw r.error;
      st.rows = {};
      (r.data || []).forEach(function (x) { st.rows[x.bill_no] = x; });
    });
  }

  function applyRow(r) {
    if (!r || !r.bill_no) return;
    st.rows[r.bill_no] = r;
    if (ready() && hooks) {
      hooks.updateProgress(r.bill_no, rowToProgress(r));
      hooks.refresh();
    }
  }

  function subscribe() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel("review_progress")
      .on("postgres_changes", { event: "*", schema: "public", table: "review_progress" }, function (p) { applyRow(p.new); })
      .subscribe();
  }

  function post(body) {
    body.role = id.role;
    body.name = id.name;
    return fetch(apiUrl(), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .catch(function () { throw new Error("저장 서버에 연결하지 못했습니다"); })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || "저장하지 못했습니다 (" + r.status + ")");
          return j;
        });
      });
  }

  // ------------------------------------------------------------ 저장 (담당자)
  function push(no, p) {
    if (!isEditor()) return Promise.resolve(false);
    st.msg = "";
    return post({ action: "set", bill: no, status: p.s, memo: (p.memo || "").slice(0, 300) }).then(function (j) {
      applyRow(j.row);
      return true;
    }).catch(function (e) {
      st.msg = "클라우드에 저장하지 못했습니다: " + ((e && e.message) || "연결 실패");
      // 화면을 클라우드에 있는 값으로 되돌린다
      hooks.updateProgress(no, st.rows[no] ? rowToProgress(st.rows[no]) : null);
      hooks.refresh();
      return false;
    });
  }

  // 여러 건을 50건씩 차례로 보낸다 (서버 호출 수 제한에 맞춤)
  function saveItems(items) {
    var chunks = [], saved = 0, failed = 0;
    for (var i = 0; i < items.length; i += CHUNK) chunks.push(items.slice(i, i + CHUNK));
    return chunks.reduce(function (p, c) {
      return p.then(function () {
        return post({ action: "set", items: c }).then(function (j) {
          saved += j.saved || 0;
          failed += (j.failed || []).length;
        });
      });
    }, Promise.resolve()).then(loadRows).then(function () {
      hooks.setProgress(cloudProgress());
      hooks.refresh();
      return { saved: saved, failed: failed };
    });
  }
  function toItem(no, p) { return { bill: no, status: p.s, memo: (p.memo || "").slice(0, 300) }; }

  function pushMany(nos) {
    if (!isEditor() || !nos.length) return Promise.resolve(null);
    var progress = hooks.getProgress();
    var items = nos.filter(function (no) { return progress[no]; }).map(function (no) { return toItem(no, progress[no]); });
    return saveItems(items).then(function (r) {
      st.msg = r.saved + "건을 클라우드에 저장했습니다." + (r.failed ? " " + r.failed + "건은 저장하지 못했습니다." : "");
      hooks.refresh();
      return r;
    }).catch(function (e) {
      st.msg = "클라우드에 저장하지 못했습니다: " + ((e && e.message) || "연결 실패");
      hooks.refresh();
    });
  }

  // 이 브라우저(localStorage) 기록을 클라우드로. 클라우드 쪽이 더 최근이면 그대로 둔다
  function importLocal() {
    st.msg = "";
    var local = hooks.localProgress();
    var items = Object.keys(local).filter(function (no) {
      var p = local[no], c = st.rows[no];
      if (!p || !p.s || (p.s === "todo" && !p.memo)) return false;
      if (hooks.validNo && !hooks.validNo(no)) return false;
      if (hooks.PII && hooks.PII.test(p.memo || "")) return false;
      if (c && c.status === p.s && (c.memo || "") === (p.memo || "")) return false; // 이미 같음
      return !(c && c.updated_at && p.t && c.updated_at > p.t);
    }).map(function (no) { return toItem(no, local[no]); });
    if (!items.length) return Promise.resolve({ saved: 0, failed: 0 });
    return saveItems(items);
  }
  function localCount() {
    var local = hooks ? hooks.localProgress() : {};
    return Object.keys(local).filter(function (no) { return local[no] && (local[no].s !== "todo" || local[no].memo); }).length;
  }

  // ------------------------------------------------------------ 결재 (결재자)
  function decide(no, decision, reason) {
    if (!isApprover()) return Promise.resolve(false);
    st.msg = "";
    if (decision === "반려" && hooks.PII && hooks.PII.test(reason || "")) {
      st.msg = "반려 사유에 전화번호·주민등록번호·이메일로 보이는 내용이 있어 보내지 않았습니다.";
      hooks.refresh();
      return Promise.resolve(false);
    }
    return post({ action: "decide", bill: no, decision: decision, reason: decision === "반려" ? (reason || "").trim().slice(0, 100) : "" })
      .then(function (j) { applyRow(j.row); return true; })
      .catch(function (e) {
        st.msg = decision + "하지 못했습니다: " + ((e && e.message) || "연결 실패");
        hooks.refresh();
        return false;
      });
  }
  function waiting(r) { return r && r.status === "done" && !r.decision; }

  // ------------------------------------------------------------ 화면 맨 위: 역할·이름 고르기
  function drawBar() {
    if (!ENABLED) return;
    var bar = document.getElementById("cloud-bar");
    if (!bar) {
      var shell = document.querySelector(".shell");
      if (!shell) return;
      bar = document.createElement("div");
      bar.id = "cloud-bar";
      bar.className = "cloud-bar no-print";
      bar.innerHTML =
        '<span class="cloud-notice">' + esc(NOTICE) + "</span>" +
        '<label class="cloud-field"><span>검토 공유 역할</span><select id="cloud-role" class="ctl">' +
        '<option value="">고르기</option><option value="담당자">담당자</option><option value="결재자">결재자</option></select></label>' +
        '<label class="cloud-field"><span>이름</span><input id="cloud-name" class="ctl" maxlength="20" autocomplete="off" placeholder="표시 이름 (20자)"></label>' +
        '<span class="cloud-state small" id="cloud-state"></span>' +
        '<span class="small muted cloud-hint" id="cloud-hint">화면에 보일 이름만 적으세요. 연락처·이메일·주민번호 같은 개인정보는 넣지 마세요.</span>';
      shell.parentNode.insertBefore(bar, shell);
      var sel = bar.querySelector("#cloud-role"), nm = bar.querySelector("#cloud-name");
      sel.value = id.role;
      nm.value = id.name;
      sel.addEventListener("change", function () { id.role = sel.value; saveId(); st.msg = ""; drawBar(); if (hooks) hooks.refresh(); });
      nm.addEventListener("change", function () {
        var v = nm.value.trim().slice(0, 20);
        var hint = document.getElementById("cloud-hint");
        if (hooks && hooks.PII && hooks.PII.test(v)) {
          hint.textContent = "전화번호·주민등록번호·이메일로 보이는 이름은 쓸 수 없습니다. 표시 이름만 적으세요.";
          hint.className = "small pii-warn cloud-hint";
          nm.value = id.name;
          return;
        }
        hint.textContent = "화면에 보일 이름만 적으세요. 연락처·이메일·주민번호 같은 개인정보는 넣지 마세요.";
        hint.className = "small muted cloud-hint";
        nm.value = v;
        id.name = v;
        saveId();
        st.msg = "";
        drawBar();
        if (hooks) hooks.refresh();
      });
    }
    var s = document.getElementById("cloud-state");
    s.textContent = st.state === "loading" ? "클라우드 연결 중"
      : st.state === "error" ? "클라우드 연결 안 됨 · 이 브라우저에만 저장"
      : !hasId() ? "역할과 이름을 정하면 함께 저장합니다 (지금은 보기만)"
      : id.role === "담당자" ? "진행 상태·메모 저장" : "승인·반려만";
  }

  // ------------------------------------------------------------ 진행 현황 화면 맨 위
  function panelHtml() {
    if (!ENABLED) return "";
    var h = '<div class="card cloud-panel no-print" id="cloud-panel"><div class="cloud-banner">' + esc(BANNER) + "</div>";
    if (st.state === "loading") h += '<p class="small muted">클라우드에 연결하는 중입니다. 그동안은 이 브라우저 기록을 보여 줍니다.</p>';
    else if (st.state === "error") h += '<p class="small">클라우드에 연결하지 못해 <b>이 브라우저에만 저장</b>합니다. (' + esc(st.err) + ")</p>";
    else if (!hasId()) h += '<p class="small">함께 보는 검토 기록입니다. 화면 맨 위에서 <b>역할과 이름</b>을 정하면 저장하거나 결재할 수 있습니다. 지금은 보기만 됩니다.</p>';
    else {
      h += '<div class="cloud-who"><span>' + esc(id.name) + " · <b>" + esc(id.role) + "</b>" +
        (id.role === "결재자" ? " (진행 상태·메모는 바꿀 수 없고 승인·반려만)" : " (진행 상태·메모 저장, 결재는 결재자가)") + "</span></div>";
      if (id.role === "담당자") {
        var n = localCount();
        if (n) h += '<div class="cloud-import"><button type="button" class="btn ghost" id="cloud-import">이 브라우저 기록 가져오기 (' + n + "건)</button>" +
          '<span class="small muted">이 브라우저에 남은 진행 기록을 클라우드로 올립니다. 클라우드 쪽이 더 최근이면 그대로 둡니다.</span></div>';
      } else h += waitingList();
    }
    if (st.msg) h += '<p class="small pii-warn" id="cloud-msg">' + esc(st.msg) + "</p>";
    return h + "</div>";
  }

  function decideCtl(no) {
    return '<span class="cloud-decide" data-no="' + esc(no) + '">' +
      '<button type="button" class="btn" data-decide="승인">승인</button>' +
      '<input class="ctl" data-reason maxlength="100" placeholder="반려 사유 (선택, 100자)" aria-label="반려 사유">' +
      '<button type="button" class="btn ghost" data-decide="반려">반려</button></span>';
  }

  function waitingList() {
    var nos = Object.keys(st.rows).filter(function (no) { return waiting(st.rows[no]); })
      .sort(function (a, b) { return st.rows[a].updated_at < st.rows[b].updated_at ? 1 : -1; });
    var name = hooks.billName || function (no) { return no; };
    return '<h3 style="margin:14px 0 6px">승인 대기 목록 <span class="muted small">검토 완료 · 결재 전 ' + nos.length + "건</span></h3>" +
      (nos.length ? '<div class="table-wrap"><table class="dt"><thead><tr><th>법안</th><th>인계 메모</th><th>마지막 수정</th><th>결재</th></tr></thead><tbody>' +
        nos.map(function (no) {
          var r = st.rows[no];
          return '<tr><td class="title"><a href="#/bill/' + esc(no) + '">' + esc(name(no)) + '</a><div class="muted small">' + esc(no) + "</div></td>" +
            '<td class="small">' + esc(r.memo || "") + '</td><td class="small muted">' + esc(who(r.editor)) + " · " + esc(when(r.updated_at)) + "</td>" +
            "<td>" + decideCtl(no) + "</td></tr>";
        }).join("") + "</tbody></table></div>" : '<p class="small muted">승인을 기다리는 법안이 없습니다.</p>');
  }

  function bindDecide(root) {
    if (!root) return;
    root.querySelectorAll(".cloud-decide [data-decide]").forEach(function (b) {
      b.addEventListener("click", function () {
        var box = b.closest(".cloud-decide");
        var reason = box.querySelector("[data-reason]");
        box.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
        b.textContent = b.getAttribute("data-decide") + " 중…";
        decide(box.getAttribute("data-no"), b.getAttribute("data-decide"), reason ? reason.value : "");
      });
    });
  }

  function bindPanel() {
    if (!ENABLED) return;
    var imp = document.getElementById("cloud-import");
    if (imp) imp.addEventListener("click", function () {
      imp.disabled = true;
      importLocal().then(function (r) {
        st.msg = r.saved + "건을 클라우드로 가져왔습니다." + (r.failed ? " " + r.failed + "건은 가져오지 못했습니다." : "");
        hooks.refresh();
      }).catch(function (e) { st.msg = "가져오지 못했습니다: " + ((e && e.message) || "연결 실패"); hooks.refresh(); });
    });
    bindDecide(document.getElementById("cloud-panel"));
  }

  function decisionTag(r) {
    if (r.decision === "승인") return '<span class="tag done">승인 · ' + esc(who(r.decision_by)) + " · " + esc(when(r.decided_at)) + "</span>";
    if (r.decision === "반려") return '<span class="tag check">반려 · ' + esc(who(r.decision_by)) + " · " + esc(when(r.decided_at)) + "</span>" +
      (r.decision_reason ? ' <span class="muted">사유: ' + esc(r.decision_reason) + "</span>" : "");
    return r.status === "done" ? '<span class="tag wait">승인 대기</span>' : "";
  }

  // 법안 상세 진행 카드 아래: 마지막 수정 · 결재 상태 · 승인/반려
  function progressExtra(no) {
    if (!ready()) return "";
    var r = st.rows[no];
    var h = '<div class="cloud-extra small" id="cloud-extra">';
    if (!r) h += '<span class="muted">아직 클라우드 기록이 없습니다.</span>';
    else {
      h += "<span>마지막 수정: " + esc(who(r.editor)) + " (담당자) · " + esc(when(r.updated_at)) + "</span> " + decisionTag(r);
      if (isApprover() && waiting(r)) h += " " + decideCtl(no);
    }
    if (isApprover()) h += ' <span class="muted">결재자는 진행 상태·메모를 바꿀 수 없습니다.' + (r && r.status !== "done" ? " 검토 완료된 법안만 결재합니다." : "") + "</span>";
    else if (!isEditor()) h += ' <span class="muted">화면 맨 위에서 역할(담당자)과 이름을 정하면 저장할 수 있습니다.</span>';
    if (st.msg) h += '<div class="pii-warn">' + esc(st.msg) + "</div>";
    return h + "</div>";
  }
  function bindProgressExtra() { bindDecide(document.getElementById("cloud-extra")); }

  // 진행 현황 표의 "마지막 변경" 칸 꼬리
  function whoCell(no) {
    var r = ready() && st.rows[no];
    if (!r) return "";
    return " · " + esc(who(r.editor)) + (r.decision === "승인" ? ' <span class="tag done">승인</span>' : r.decision === "반려" ? ' <span class="tag check">반려</span>' : "");
  }

  // 상황판 카드: AI 초안 N건 중 사람 수정 M건 (rpc agent_run_stats, 집계만)
  function fillStats(slotId) {
    var slot = document.getElementById(slotId);
    if (!slot || !ENABLED) return;
    fetch(CFG.supabaseUrl + "/rest/v1/rpc/agent_run_stats", {
      method: "POST",
      headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
      body: "{}",
    }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }).then(function (j) {
      var s = (Array.isArray(j) ? j[0] : j) || {};
      var n = Number(s.bills) || 0, m = Number(s.edited) || 0;
      var el = document.getElementById(slotId);
      if (!el) return;
      el.innerHTML = '<div class="card" style="margin-top:16px"><div class="near-head"><h3 style="margin:0">검토 에이전트 초안</h3>' +
        '<span class="tag" title="' + esc(BANNER) + '">시연용 클라우드 DB</span></div>' +
        (n ? '<p style="margin:8px 0 0"><b>AI 초안 ' + n + "건 중 사람 수정 " + m + "건</b></p>" +
          '<p class="muted small" style="margin:4px 0 0">에이전트가 초안을 만든 법안 수와, 그중 담당자가 진행 상태나 메모를 저장한 법안 수입니다.</p>'
          : '<p class="muted small" style="margin:8px 0 0">기록 없음</p>') + "</div>";
    }).catch(function () { /* 집계를 못 받으면 카드를 그리지 않는다 */ });
  }

  // ------------------------------------------------------------ 바깥에 보이는 것
  window.Cloud = {
    BANNER: BANNER,
    NOTICE: NOTICE,
    enabled: function () { return ENABLED; },
    active: ready,
    canEdit: isEditor,
    // 클라우드 모드인데 담당자가 아니면(결재자, 역할·이름 안 정함) 진행 상태·메모를 바꿀 수 없다
    readOnly: function () { return ready() && !isEditor(); },
    /**
     * admin.js 가 한 번 부른다. hooks:
     *   getProgress() / setProgress(obj) / localProgress() / updateProgress(no, p 또는 null) / refresh()
     *   billName(no), validNo(no), PG, PII, apiBase
     */
    init: function (h) {
      hooks = h;
      drawBar();
      if (ENABLED) start();
    },
    push: push,
    pushMany: pushMany,
    panelHtml: panelHtml,
    bindPanel: bindPanel,
    progressExtra: progressExtra,
    bindProgressExtra: bindProgressExtra,
    whoCell: whoCell,
    fillStats: fillStats,
  };
})();
