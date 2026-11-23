/*
 * 빼곡 검토 진행 저장 (Vercel 서버리스 함수, /api/progress)
 *
 * 시연용: 로그인 없이 역할을 고르는 방식. 실제 도입 시 기관 통합로그인(SSO)·공무원 인증서(GPKI)와 연동
 *
 * 브라우저는 Supabase 를 읽기만 한다 (RLS). 쓰기는 이 함수가 서비스 키(service_role)로
 * DB 함수 progress_set / progress_decide 만 부른다 (supabase/migrations/003_no_login.sql).
 * 역할(담당자 / 결재자)과 이름은 화면에서 스스로 고른 값이라 권한 증명이 아니다. 시연용으로만 쓴다.
 *
 *   GET  → { ok }  (서버에 서비스 키가 있으면 true)
 *   POST { action: "set", role: "담당자", name, bill, status, memo }               → { ok, row }
 *   POST { action: "set", role: "담당자", name, items: [{ bill, status, memo }] }   → { ok, saved, rows, failed: [{ bill, error }] }  (최대 50건)
 *   POST { action: "decide", role: "결재자", name, bill, decision: "승인"|"반려", reason } → { ok, row }
 *
 * 막는 것: 허용한 사이트(CORS 목록)만, IP당 1분 30회, 이름 1~20자, 메모 300자, 반려 사유 100자,
 *          의안번호 7자리이고 bills.json 에 있어야 함, 이름·메모·사유에 전화번호·주민번호·이메일 모양이면 거절,
 *          담당자는 상태·메모만, 결재자는 승인·반려만.
 */
const { cors, createLimiter, clientIp, readBody, PII, loadJson } = require("../lib/common");
const { sbEnv, sbRpc } = require("../lib/supabase");

const STATUSES = ["todo", "doing", "hold", "done"]; // web/admin.js PG_KEYS 와 같음
const ROLES = ["담당자", "결재자"];
const DECISIONS = ["승인", "반려"];
const MAX_ITEMS = 50;
const CACHE_MS = 10 * 60000;
const limited = createLimiter({ windowMs: 60000, max: 30 });

let billCache = null;
async function billNos() {
  if (billCache && Date.now() - billCache.at < CACHE_MS) return billCache.set;
  const b = await loadJson("bills.json");
  billCache = { at: Date.now(), set: new Set(b.bills.map((x) => String(x.no))) };
  return billCache.set;
}

class Bad extends Error {
  constructor(msg, code) { super(msg); this.code = code || 400; }
}

function str(x) { return typeof x === "string" ? x : x == null ? "" : String(x); }

function checkName(name) {
  name = str(name).trim();
  if (!name) throw new Bad("이름을 적어 주세요");
  if (name.length > 20) throw new Bad("이름은 20자까지입니다");
  if (PII.test(name)) throw new Bad("이름에 전화번호·주민등록번호·이메일로 보이는 내용이 있습니다. 표시 이름만 적어 주세요.");
  return name;
}

function checkBill(no, nos) {
  no = str(no).trim();
  if (!/^\d{7}$/.test(no)) throw new Bad("의안번호는 7자리 숫자여야 합니다");
  if (!nos.has(no)) throw new Bad("의안번호 " + no + " 법안을 찾지 못했습니다", 404);
  return no;
}

function checkSet(item, nos) {
  item = item || {};
  const bill = checkBill(item.bill, nos);
  const status = str(item.status).trim();
  if (!STATUSES.includes(status)) throw new Bad("진행 상태는 " + STATUSES.join(", ") + " 중 하나입니다");
  const memo = str(item.memo).trim();
  if (memo.length > 300) throw new Bad("메모는 300자까지입니다");
  if (PII.test(memo)) throw new Bad("메모에 전화번호·주민등록번호·이메일로 보이는 내용이 있어 저장하지 않았습니다");
  return { bill, status, memo };
}

/** DB 함수 호출 결과 → { row } 또는 Bad */
async function call(fn, args) {
  const r = await sbRpc(fn, args);
  if (r.ok) return Array.isArray(r.json) ? r.json[0] : r.json;
  if (r.status === 0) throw new Bad("서버에 DB 키가 없어 저장할 수 없습니다", 503);
  if (r.status === 400 && r.code === "P0001" && r.message) throw new Bad(r.message, 400); // DB 함수가 거절한 이유 (우리가 쓴 한국어 문구)
  throw new Bad("DB 에 저장하지 못했습니다", 502);
}

module.exports = async function handler(req, res) {
  const okOrigin = cors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method === "GET") { res.status(200).json({ ok: !!sbEnv() }); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 받습니다" }); return; }
  if (!okOrigin) { res.status(403).json({ error: "허용하지 않은 사이트입니다" }); return; }
  if (limited(clientIp(req))) { res.status(429).json({ error: "요청이 너무 잦습니다. 1분 뒤에 다시 해 주세요." }); return; }

  const body = readBody(req);
  try {
    const action = str(body.action);
    const role = str(body.role);
    if (!ROLES.includes(role)) throw new Bad("역할은 담당자 또는 결재자입니다");
    const name = checkName(body.name);

    if (action === "set") {
      if (role !== "담당자") throw new Bad("결재자는 진행 상태·메모를 바꿀 수 없습니다", 403);
      const nos = await billNos();
      if (Array.isArray(body.items)) {
        if (!body.items.length) throw new Bad("저장할 항목이 없습니다");
        if (body.items.length > MAX_ITEMS) throw new Bad("한 번에 " + MAX_ITEMS + "건까지 저장합니다");
        const rows = [], failed = [];
        for (const it of body.items) {
          try {
            const v = checkSet(it, nos);
            rows.push(await call("progress_set", { p_bill_no: v.bill, p_status: v.status, p_memo: v.memo, p_actor: name }));
          } catch (e) {
            if (e.code === 503) throw e;
            failed.push({ bill: str(it && it.bill).slice(0, 7), error: e instanceof Bad ? e.message : "저장 실패" });
          }
        }
        res.status(200).json({ ok: true, saved: rows.length, rows, failed });
        return;
      }
      const v = checkSet(body, nos);
      const row = await call("progress_set", { p_bill_no: v.bill, p_status: v.status, p_memo: v.memo, p_actor: name });
      res.status(200).json({ ok: true, row });
      return;
    }

    if (action === "decide") {
      if (role !== "결재자") throw new Bad("담당자는 승인·반려할 수 없습니다", 403);
      const decision = str(body.decision);
      if (!DECISIONS.includes(decision)) throw new Bad("결재는 승인 또는 반려만 됩니다");
      const reason = decision === "반려" ? str(body.reason).trim() : "";
      if (reason.length > 100) throw new Bad("반려 사유는 100자까지입니다");
      if (PII.test(reason)) throw new Bad("반려 사유에 전화번호·주민등록번호·이메일로 보이는 내용이 있습니다");
      const bill = checkBill(body.bill, await billNos());
      const row = await call("progress_decide", { p_bill_no: bill, p_decision: decision, p_reason: reason || null, p_actor: name });
      res.status(200).json({ ok: true, row });
      return;
    }

    throw new Bad("action 은 set 또는 decide 입니다");
  } catch (e) {
    if (e instanceof Bad) { res.status(e.code).json({ error: e.message }); return; }
    res.status(502).json({ error: "저장하지 못했습니다" });
  }
};

module.exports._test = { clearCache: () => { billCache = null; }, STATUSES, MAX_ITEMS };
