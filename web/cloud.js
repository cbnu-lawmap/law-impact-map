/*
 * 빼곡 — 검토 진행 공유 (Supabase, 시연용 클라우드 DB)
 *
 * 실제 도입 시에는 기관 내부 DB 로 바꾼다. 이 파일만 바꾸면 되도록 행정 화면(admin.js)과는 작은 연결부(hook)로만 잇는다.
 *
 *   - 키가 없으면(web/config.js 자리 표시 그대로) 아무것도 하지 않는다. 외부로 요청도 보내지 않는다 → 지금과 똑같이 동작
 *   - 키가 있으면 supabase-js(고정 버전, 무결성 확인)를 받아 이메일 링크 로그인을 띄운다
 *   - 로그인한 구성원(public.members)만 review_progress 를 읽는다 (RLS)
 *       담당자: 진행 상태·메모 저장 (수정자·시각은 DB 트리거가 채움), 이 브라우저 기록 가져오기
 *       결재자: 읽기 전용 + 결재 버튼 (rpc approve_review), 결재 대기 목록
 *   - 다른 사람이 바꾸면 실시간(Realtime)으로 화면에 반영
 *   - 연결 실패·로그인 전·구성원 아님 → 이 브라우저(localStorage) 기록을 그대로 쓴다
 *
 * 화면에 보이는 이메일은 로그인한 본인 것뿐이다. 다른 사람은 아이디 앞 두 글자만 보인다.
 * 이메일을 콘솔·로그에 남기지 않는다.
 */
(function () {
  "use strict";

  var SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";
  var SDK_SRI = "sha384-GFr3yTh5lJznCbZfpTtXnwboFsxqtTQoeTZCRHhE0579KrRmlCzen5AA8ohaB5ug";
  var BANNER = "시연용 클라우드 DB, 실제 도입 시 기관 내부 DB로 교체";
  var CFG = window.PPAEGOK_CONFIG || {};
  var URL_OK = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(String(CFG.supabaseUrl || ""));
  var KEY = String(CFG.supabaseAnonKey || "");
  var ENABLED = URL_OK && KEY.length > 20 && KEY.indexOf("__") !== 0;
  var SHOT = /[?&]shot=1(&|$)/.test(location.search);
  if (SHOT) ENABLED = false; // 화면 찍기용은 늘 이 브라우저 모드

  // off(키 없음) · loading · error(연결 실패) · out(로그인 전) · sent(링크 보냄) · guest(구성원 아님) · ready
  var st = { state: ENABLED ? "loading" : "off", email: "", role: "", rows: {}, msg: "", err: "" };
  var sb = null, hooks = null, channel = null;

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
  // 다른 사람 이메일은 아이디 앞 두 글자만 (본인은 "나")
  function who(email) {
    if (!email) return "알 수 없음";
    if (email === st.email) return "나";
    return String(email).split("@")[0].slice(0, 2) + "***";
  }
  function label(s) { return (hooks && hooks.PG && hooks.PG[s]) ? hooks.PG[s].label : s; }

  // ------------------------------------------------------------ 상태 바꾸기
  function rowToProgress(r) {
    return { s: r.status, memo: r.memo || "", t: r.updated_at, log: [], editor: r.editor, approved: !!r.approved, approved_by: r.approved_by, approved_at: r.approved_at };
  }
  function cloudProgress() {
    var out = {};
    Object.keys(st.rows).forEach(function (no) { out[no] = rowToProgress(st.rows[no]); });
    return out;
  }
  function set(state, extra) {
    var wasReady = st.state === "ready";
    st.state = state;
    if (extra) Object.keys(extra).forEach(function (k) { st[k] = extra[k]; });
    if (!hooks) return;
    if (state === "ready") hooks.setProgress(cloudProgress());
    else if (wasReady) hooks.setProgress(hooks.localProgress());
    drawChip();
    var foot = document.getElementById("st-store");
    if (foot) foot.textContent = state === "ready" ? "진행 기록은 클라우드(시연용)에 저장" : "진행 기록은 이 브라우저에만 저장";
    hooks.refresh();
  }

  // ------------------------------------------------------------ 연결
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

  function start() {
    loadSdk().then(function () {
      sb = window.supabase.createClient(CFG.supabaseUrl, KEY, {
        auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
      });
      sb.auth.onAuthStateChange(function (event, session) {
        if (event === "SIGNED_OUT") { unsubscribe(); st.rows = {}; set("out", { email: "", role: "" }); }
        else if (event === "SIGNED_IN" && session && session.user && String(session.user.email || "").toLowerCase() !== st.email) {
          // 이 콜백 안에서 바로 다른 supabase 호출을 기다리면 멈출 수 있어 한 박자 늦춘다 (supabase-js 안내)
          st.email = String(session.user.email || "").toLowerCase();
          setTimeout(function () { afterLogin(session); }, 0);
        }
      });
      return sb.auth.getSession();
    }).then(function (r) {
      cleanUrl();
      var session = r && r.data && r.data.session;
      if (session && String(session.user.email || "").toLowerCase() === st.email) return; // 이미 SIGNED_IN 으로 처리함
      if (session) return afterLogin(session);
      set("out");
    }).catch(function (e) {
      set("error", { err: (e && e.message) || "연결 실패" });
    });
  }

  // 로그인 링크로 돌아오면 주소에 남는 ?code= 를 지운다 (화면 주소의 # 뒤는 그대로)
  function cleanUrl() {
    if (!/[?&]code=/.test(location.search)) return;
    var q = location.search.replace(/([?&])code=[^&]*&?/, "$1").replace(/[?&]$/, "");
    history.replaceState(null, "", location.pathname + q + location.hash);
  }

  function afterLogin(session) {
    st.email = String(session.user.email || "").toLowerCase();
    return sb.from("members").select("role").maybeSingle().then(function (r) {
      if (r.error) throw r.error;
      if (!r.data) { set("guest", { role: "" }); return; }
      st.role = r.data.role;
      return loadRows().then(function () { subscribe(); set("ready"); });
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
    if (st.state === "ready" && hooks) {
      hooks.updateProgress(r.bill_no, rowToProgress(r));
      hooks.refresh();
    }
  }

  function subscribe() {
    unsubscribe();
    channel = sb.channel("review_progress")
      .on("postgres_changes", { event: "*", schema: "public", table: "review_progress" }, function (p) { applyRow(p.new); })
      .subscribe();
  }
  function unsubscribe() { if (channel && sb) { sb.removeChannel(channel); channel = null; } }

  function signIn(email) {
    st.msg = "";
    var redirect = location.origin + location.pathname;
    return sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: redirect, shouldCreateUser: true } }).then(function (r) {
      if (r.error) throw r.error;
      set("sent", { msg: "" });
    });
  }

  // ------------------------------------------------------------ 저장 (담당자)
  function push(no, p) {
    if (!canEdit()) return Promise.resolve(false);
    st.msg = "";
    return sb.from("review_progress").upsert({ bill_no: no, status: p.s, memo: (p.memo || "").slice(0, 300) }, { onConflict: "bill_no" })
      .select().single().then(function (r) {
        if (r.error) throw r.error;
        applyRow(r.data);
        return true;
      }).catch(function (e) {
        st.msg = "클라우드에 저장하지 못했습니다: " + ((e && e.message) || "연결 실패");
        hooks.refresh();
        return false;
      });
  }
  function pushMany(nos) {
    if (!canEdit() || !nos.length) return Promise.resolve(0);
    var progress = hooks.getProgress();
    var rows = nos.filter(function (no) { return progress[no]; }).map(function (no) {
      return { bill_no: no, status: progress[no].s, memo: (progress[no].memo || "").slice(0, 300) };
    });
    return upsertRows(rows);
  }
  function upsertRows(rows) {
    var chunks = [];
    for (var i = 0; i < rows.length; i += 200) chunks.push(rows.slice(i, i + 200));
    return chunks.reduce(function (p, c) {
      return p.then(function () {
        return sb.from("review_progress").upsert(c, { onConflict: "bill_no" }).then(function (r) { if (r.error) throw r.error; });
      });
    }, Promise.resolve()).then(loadRows).then(function () {
      hooks.setProgress(cloudProgress());
      hooks.refresh();
      return rows.length;
    });
  }

  // 이 브라우저(localStorage) 기록을 클라우드로. 클라우드 쪽이 더 최근이면 그대로 둔다
  function importLocal() {
    st.msg = "";
    var local = hooks.localProgress();
    var rows = Object.keys(local).filter(function (no) {
      var p = local[no], c = st.rows[no];
      if (!p || !p.s || (p.s === "todo" && !p.memo)) return false;
      if (hooks.validNo && !hooks.validNo(no)) return false;
      if (hooks.PII && hooks.PII.test(p.memo || "")) return false;
      return !(c && c.updated_at && p.t && c.updated_at > p.t);
    }).map(function (no) { return { bill_no: no, status: local[no].s, memo: (local[no].memo || "").slice(0, 300) }; });
    if (!rows.length) return Promise.resolve(0);
    return upsertRows(rows);
  }
  function localCount() {
    var local = hooks ? hooks.localProgress() : {};
    return Object.keys(local).filter(function (no) { return local[no] && (local[no].s !== "todo" || local[no].memo); }).length;
  }

  function approve(no) {
    st.msg = "";
    return sb.rpc("approve_review", { p_bill_no: no }).then(function (r) {
      if (r.error) throw r.error;
      return sb.from("review_progress").select("*").eq("bill_no", no).single();
    }).then(function (r) {
      if (r.error) throw r.error;
      applyRow(r.data);
    }).catch(function (e) {
      st.msg = "결재하지 못했습니다: " + ((e && e.message) || "연결 실패");
      hooks.refresh();
    });
  }

  // ------------------------------------------------------------ 화면 조각
  function canEdit() { return st.state === "ready" && st.role === "담당자"; }

  function drawChip() {
    if (!ENABLED) return;
    var box = document.getElementById("cloud-chip");
    if (!box) {
      var top = document.querySelector(".top-right");
      if (!top) return;
      box = document.createElement("a");
      box.id = "cloud-chip";
      box.className = "demo-chip cloud-chip";
      box.href = "#/progress";
      top.insertBefore(box, top.firstChild);
    }
    box.title = BANNER;
    box.textContent = st.state === "ready" ? st.email + " · " + st.role
      : st.state === "loading" ? "클라우드 연결 중"
      : st.state === "error" ? "클라우드 연결 안 됨"
      : st.state === "guest" ? "구성원 아님"
      : "검토 공유 로그인";
  }

  // 진행 현황 화면 맨 위
  function panelHtml() {
    if (!ENABLED) return "";
    var h = '<div class="card cloud-panel no-print" id="cloud-panel"><div class="cloud-banner">' + esc(BANNER) + "</div>";
    if (st.state === "loading") h += '<p class="small muted">클라우드에 연결하는 중입니다. 그동안은 이 브라우저 기록을 보여 줍니다.</p>';
    else if (st.state === "error") h += '<p class="small">클라우드에 연결하지 못해 <b>이 브라우저에만 저장</b>합니다. (' + esc(st.err) + ")</p>";
    else if (st.state === "out" || st.state === "sent") {
      h += '<p class="small">로그인하지 않아 <b>이 브라우저에만 저장</b>합니다. 등록된 구성원은 이메일 링크로 로그인하면 검토 진행을 함께 봅니다.</p>' +
        '<form id="cloud-login" class="cloud-login"><input type="email" id="cloud-email" class="ctl" required placeholder="기관 이메일" autocomplete="email" aria-label="이메일">' +
        '<button type="submit" class="btn">로그인 링크 받기</button></form>' +
        (st.state === "sent" ? '<p class="small">메일함에서 링크를 눌러 주세요. 이 브라우저에서 열어야 로그인됩니다.</p>' : "");
    } else if (st.state === "guest") {
      h += '<p class="small">로그인했지만 구성원으로 등록되지 않은 계정입니다. 관리자에게 등록을 요청하세요. 그동안은 <b>이 브라우저에만 저장</b>합니다.</p>' +
        '<button type="button" class="btn ghost" id="cloud-out">로그아웃</button>';
    } else if (st.state === "ready") {
      h += '<div class="cloud-who"><span>' + esc(st.email) + " · <b>" + esc(st.role) + "</b>" +
        (st.role === "결재자" ? " (읽기 전용, 결재만 가능)" : " (진행 상태·메모 저장)") + "</span>" +
        '<span class="spacer"></span><button type="button" class="btn ghost" id="cloud-out">로그아웃</button></div>';
      if (st.role === "담당자") {
        var n = localCount();
        if (n) h += '<div class="cloud-import"><button type="button" class="btn ghost" id="cloud-import">이 브라우저 기록 가져오기 (' + n + "건)</button>" +
          '<span class="small muted">이 브라우저에 남은 진행 기록을 클라우드로 올립니다. 클라우드 쪽이 더 최근이면 그대로 둡니다.</span></div>';
      }
      if (st.role === "결재자") h += waitingList();
    }
    if (st.msg) h += '<p class="small pii-warn" id="cloud-msg">' + esc(st.msg) + "</p>";
    return h + "</div>";
  }

  function waitingList() {
    var nos = Object.keys(st.rows).filter(function (no) { return !st.rows[no].approved; })
      .sort(function (a, b) {
        var ra = st.rows[a], rb = st.rows[b];
        return (rb.status === "done") - (ra.status === "done") || (ra.updated_at < rb.updated_at ? 1 : -1);
      });
    var name = hooks.billName || function (no) { return no; };
    return '<h3 style="margin:14px 0 6px">결재 대기 목록 <span class="muted small">' + nos.length + "건</span></h3>" +
      (nos.length ? '<div class="table-wrap"><table class="dt"><thead><tr><th>진행</th><th>법안</th><th>마지막 수정</th><th></th></tr></thead><tbody>' +
        nos.map(function (no) {
          var r = st.rows[no];
          return "<tr><td>" + esc(label(r.status)) + '</td><td class="title"><a href="#/bill/' + esc(no) + '">' + esc(name(no)) + '</a><div class="muted small">' + esc(no) + "</div></td>" +
            '<td class="small muted">' + esc(who(r.editor)) + " · " + esc(when(r.updated_at)) + '</td><td><button type="button" class="btn" data-approve="' + esc(no) + '">결재</button></td></tr>';
        }).join("") + "</tbody></table></div>" : '<p class="small muted">결재할 법안이 없습니다.</p>');
  }

  function bindApprove(root) {
    (root || document).querySelectorAll("[data-approve]").forEach(function (b) {
      b.addEventListener("click", function () {
        b.disabled = true;
        b.textContent = "결재 중…";
        approve(b.getAttribute("data-approve"));
      });
    });
  }

  function bindPanel() {
    if (!ENABLED) return;
    var f = document.getElementById("cloud-login");
    if (f) f.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = document.getElementById("cloud-email").value.trim();
      if (!email) return;
      var btn = f.querySelector("button");
      btn.disabled = true;
      signIn(email).catch(function (err) {
        st.msg = "링크를 보내지 못했습니다: " + ((err && err.message) || "연결 실패");
        hooks.refresh();
      });
    });
    var out = document.getElementById("cloud-out");
    if (out) out.addEventListener("click", function () { sb.auth.signOut(); });
    var imp = document.getElementById("cloud-import");
    if (imp) imp.addEventListener("click", function () {
      imp.disabled = true;
      importLocal().then(function (n) { st.msg = n + "건을 클라우드로 가져왔습니다."; hooks.refresh(); })
        .catch(function (e) { st.msg = "가져오지 못했습니다: " + ((e && e.message) || "연결 실패"); hooks.refresh(); });
    });
    bindApprove(document.getElementById("cloud-panel"));
  }

  // 법안 상세 진행 카드 아래: 마지막 수정 · 결재 상태 · 결재 버튼
  function progressExtra(no) {
    if (st.state !== "ready") return "";
    var r = st.rows[no];
    var h = '<div class="cloud-extra small" id="cloud-extra">';
    if (!r) h += '<span class="muted">아직 클라우드 기록이 없습니다.</span>';
    else {
      h += "<span>마지막 수정: " + esc(who(r.editor)) + " · " + esc(when(r.updated_at)) + "</span>";
      h += r.approved
        ? ' <span class="tag done">결재 완료 · ' + esc(who(r.approved_by)) + " · " + esc(when(r.approved_at)) + "</span>"
        : ' <span class="tag wait">결재 전</span>';
      if (st.role === "결재자" && !r.approved) h += ' <button type="button" class="btn" data-approve="' + esc(no) + '">결재</button>';
    }
    if (st.role === "결재자") h += ' <span class="muted">결재자는 진행 상태·메모를 바꿀 수 없습니다.</span>';
    if (st.msg) h += '<div class="pii-warn">' + esc(st.msg) + "</div>";
    return h + "</div>";
  }
  function bindProgressExtra() { bindApprove(document.getElementById("cloud-extra")); }

  // 진행 현황 표의 "마지막 변경" 칸 꼬리
  function whoCell(no) {
    var r = st.state === "ready" && st.rows[no];
    if (!r) return "";
    return " · " + esc(who(r.editor)) + (r.approved ? ' <span class="tag done">결재</span>' : "");
  }

  // 상황판 카드: AI 초안 N건 중 사람 수정 M건 (rpc agent_run_stats, 로그인 없이 집계만)
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
    enabled: function () { return ENABLED; },
    active: function () { return st.state === "ready"; },
    canEdit: canEdit,
    readOnly: function () { return st.state === "ready" && st.role === "결재자"; },
    /**
     * admin.js 가 한 번 부른다. hooks:
     *   getProgress() / setProgress(obj) / localProgress() / updateProgress(no, p) / refresh()
     *   billName(no), validNo(no), PG, PII
     */
    init: function (h) {
      hooks = h;
      drawChip();
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
