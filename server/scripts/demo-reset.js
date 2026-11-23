#!/usr/bin/env node
/*
 * 시연 초기화: 배포 서버의 /api/progress 에 action "reset" 을 보내 진행 기록과 결재 기록을 모두 지운다.
 * 시연 전용. 키는 필요 없다 (서버가 확인 문구·사이트·호출 수를 보고 DB 함수 progress_reset 을 부른다).
 * 먼저 supabase/migrations/004_demo_reset.sql 이 DB 에 적용되어 있어야 한다.
 *
 *   npm run demo:reset                                   https://ppaegok-api.vercel.app
 *   npm run demo:reset -- --base http://127.0.0.1:3000   로컬 dev-server
 */
const args = process.argv.slice(2);
const i = args.indexOf("--base");
const BASE = String(i >= 0 && args[i + 1] ? args[i + 1] : "https://ppaegok-api.vercel.app").replace(/\/+$/, "");
const ORIGIN = "https://cbnu-lawmap.github.io";
const CONFIRM = "초기화";

(async () => {
  let r;
  try {
    r = await fetch(BASE + "/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ action: "reset", confirm: CONFIRM }),
    });
  } catch (e) {
    console.error("서버에 닿지 못했습니다: " + BASE + " (" + e.message + ")");
    process.exit(1);
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("초기화 실패 (" + r.status + "): " + (j.error || "알 수 없음"));
    process.exit(1);
  }
  const x = j.reset || {};
  console.log("시연 초기화 완료 (" + BASE + ")");
  console.log("  지운 진행 기록 " + (x.progress ?? "?") + "건, 결재·변경 기록 " + (x.log ?? "?") + "건, 사람 수정 표시를 되돌린 에이전트 기록 " + (x.runs_reset ?? "?") + "건");
})();
