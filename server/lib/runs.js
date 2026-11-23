/*
 * 검토 에이전트 실행 기록 (Supabase agent_runs 표)
 *
 *   await logRun({ bill_no, mode, steps, tokens })   → true(기록함) / false(키 없음·실패)
 *
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 가 없으면 아무것도 하지 않는다.
 * 실패해도 예외를 던지지 않으므로 에이전트 응답을 막지 않는다.
 * 담당자가 그 법안의 진행 상황을 저장하면 DB 트리거가 human_edited 를 true 로 바꾸고,
 * 상황판은 rpc agent_run_stats() 로 "AI 초안 N건 중 사람 수정 M건" 만 본다 (이메일 등은 남기지 않음).
 */
const { sbEnv, sbPost } = require("./supabase");

function toInt(x) {
  const n = Math.round(Number(x));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function logRun(run) {
  run = run || {};
  const no = String(run.bill_no || "");
  if (!/^\d{7}$/.test(no)) return false;
  if (!sbEnv()) return false; // 서비스 키 없음: 기록하지 않음 (anon 키로는 넣을 수 없다)
  const r = await sbPost("agent_runs", {
    bill_no: no,
    mode: String(run.mode || "agent").slice(0, 20),
    steps: toInt(run.steps),
    tokens: toInt(run.tokens),
  }, { headers: { Prefer: "return=minimal" } });
  return !!r;
}

module.exports = { logRun };
