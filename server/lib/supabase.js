/*
 * Supabase(PostgREST) 호출 공통 부품. supabase-js 없이 fetch 만 쓴다.
 *
 * 환경변수 (Vercel 에만 둔다. 저장소·화면에는 넣지 않는다)
 *   SUPABASE_URL               예: https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  서버 전용 키 (RLS 를 건너뛰므로 화면에 절대 내보내지 않는다)
 *   SUPABASE_ANON_KEY          (선택) 서비스 키가 없을 때 읽기 전용 호출에 쓴다
 *
 * 키가 없거나 호출이 실패하면 null 을 돌려주고, 부르는 쪽이 원래 방식으로 대체한다.
 */

function sbEnv(opts) {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const anon = process.env.SUPABASE_ANON_KEY || "";
  const key = service || ((opts && opts.allowAnon) ? anon : "");
  if (!/^https:\/\//.test(url) || !key) return null;
  return { url, key };
}

/** POST {url}/rest/v1/{path}. 성공하면 { status, json }, 실패·시간 초과면 null (예외를 던지지 않는다) */
async function sbPost(path, body, opts) {
  opts = opts || {};
  const env = sbEnv(opts);
  if (!env) return null;
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs || 3000) : null;
  try {
    const r = await fetch(env.url + "/rest/v1/" + path, {
      method: "POST",
      headers: Object.assign({
        apikey: env.key,
        Authorization: "Bearer " + env.key,
        "Content-Type": "application/json",
      }, opts.headers || {}),
      body: JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined,
    });
    if (!r.ok) return null;
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    return { status: r.status, json };
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * POST {url}/rest/v1/rpc/{fn} (서비스 키만). 실패해도 예외를 던지지 않고 이유를 돌려준다.
 *   성공: { ok: true, status, json }
 *   실패: { ok: false, status, code, message }  status 0 = 키 없음, -1 = 연결 실패·시간 초과
 * DB 함수가 raise exception 으로 거절하면 status 400, code P0001 과 그 문구(message)가 온다.
 */
async function sbRpc(fn, args, opts) {
  opts = opts || {};
  const env = sbEnv();
  if (!env) return { ok: false, status: 0, message: "키 없음" };
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs || 5000) : null;
  try {
    const r = await fetch(env.url + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: { apikey: env.key, Authorization: "Bearer " + env.key, "Content-Type": "application/json" },
      body: JSON.stringify(args || {}),
      signal: ctl ? ctl.signal : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
    if (!r.ok) return { ok: false, status: r.status, code: String((json && json.code) || ""), message: String((json && json.message) || "").slice(0, 120) };
    return { ok: true, status: r.status, json };
  } catch (e) {
    return { ok: false, status: -1, message: "연결 실패" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { sbEnv, sbPost, sbRpc };
