/*
 * 빼곡 — 행정 화면 질의 도우미 (Vercel 서버리스 함수)
 *
 * GitHub Pages(정적)에는 OpenAI 키를 둘 수 없어(누구나 볼 수 있음) 이 함수만 Vercel에 따로 올린다.
 * 키는 Vercel 환경변수 OPENAI_API_KEY 에만 있다. 저장소·화면 코드에는 없다.
 *
 * 하는 일
 *   1. 배포 사이트의 공개 데이터(bills.json, demo_rules.json)에서 질문과 관련된 법안을 찾는다 (검색은 코드가 함)
 *   2. 찾은 법안 내용만 근거로 OpenAI가 답을 쓴다
 *   3. 답에 나온 숫자가 근거에 실제로 있는지 대조한다
 * 막는 것
 *   - 개인정보(전화번호·주민번호·이메일)가 든 질문, 개별 건물·집이 대상인지 묻는 판정 질문 → 고정 문구로 답함
 *   - 허용한 사이트 밖에서의 호출(CORS), IP당 1분 10회 초과
 * OpenAI에는 공개 법안 텍스트와 질문만 보낸다.
 */

const DATA_BASE = process.env.DATA_BASE || "https://cbnu-lawmap.github.io/law-impact-map/data/";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const ALLOWED = [
  "https://cbnu-lawmap.github.io",
  "http://localhost:8000",
  "http://localhost:8766",
  "http://127.0.0.1:8000",
];
const RATE = { windowMs: 60000, max: 10 };

let cache = null; // { at, bills, fields, demos, region, total }
const hits = new Map(); // ip -> [시각]

async function loadData() {
  if (cache && Date.now() - cache.at < 10 * 60000) return cache;
  const [b, d] = await Promise.all([
    fetch(DATA_BASE + "bills.json").then((r) => r.json()),
    fetch(DATA_BASE + "demo_rules.json").then((r) => r.json()),
  ]);
  const demos = {};
  d.demos.forEach((x) => { demos[x.bill_no] = x; });
  cache = { at: Date.now(), bills: b.bills, fields: b.fields, demos, region: d.region, total: d.total };
  return cache;
}

function cors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  return ALLOWED.includes(origin);
}

function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE.max;
}

const PII = /(01[016789][-\s]?\d{3,4}[-\s]?\d{4})|(\d{6}[-\s]?[1-4]\d{6})|([\w.+-]+@[\w-]+\.[\w.]+)/;
const PERSONAL_JUDGE = /(우리\s*집|내\s*집|제\s*집|내\s*건물|제\s*건물|우리\s*건물|저희\s*(집|건물)).*(대상|해당|적용|걸리)/;

// 어느 법안에나 나오는 말이라 검색에서 뺀다
const STOP = new Set(["판정", "판정한", "결과", "요약", "요약해", "알려", "알려줘", "설명", "정리", "사창동", "영향", "건물", "어떤", "무엇", "뭐야", "있어", "해줘", "줘"]);

// 질문과 관련 있는 법안 고르기 (점수 = 제목 일치 3점 + 요약 일치 1점)
function retrieve(D, q, billNo) {
  const picked = [];
  const add = (b) => { if (b && !picked.includes(b)) picked.push(b); };
  if (billNo) add(D.bills.find((b) => b.no === billNo));
  (q.match(/\d{7}/g) || []).forEach((no) => add(D.bills.find((b) => b.no === no)));
  const words = (q.match(/[가-힣A-Za-z0-9]{2,}/g) || [])
    .map((w) => w.replace(/(은|는|이|가|을|를|의|에|에서|으로|로|과|와|도|만|이야|인가|일까|있어|있나|있는|관련|법안|법률|개정안)$/, ""))
    .filter((w) => w.length >= 2 && !STOP.has(w));
  if (words.length) {
    const scored = D.bills.map((b) => {
      let s = 0;
      words.forEach((w) => {
        if (b.name.includes(w)) s += 3;
        if (b.summary.includes(w)) s += 1;
        if ((D.fields[b.field] || "").includes(w)) s += 2;
      });
      if (D.demos[b.no]) s += 0.5; // 판정한 법안을 조금 앞으로
      return [s, b];
    }).filter((x) => x[0] >= (billNo ? 3 : 1));
    // "최근·최신" 질문이면 날짜순, 아니면 관련도순
    const byDate = (a, b) => (a[1].date < b[1].date ? 1 : a[1].date > b[1].date ? -1 : 0);
    if (/최근|최신|요즘|새로/.test(q)) scored.sort(byDate);
    else scored.sort((a, b) => b[0] - a[0] || byDate(a, b));
    scored.slice(0, billNo ? 3 : 6).forEach((x) => add(x[1]));
  }
  return picked.slice(0, 6);
}

function context(D, bills) {
  const fieldCnt = {};
  D.bills.forEach((b) => { fieldCnt[b.field] = (fieldCnt[b.field] || 0) + 1; });
  const lines = [];
  lines.push(`[전체] 계류 법안 ${D.bills.length}건, 시범 지역 ${D.region} 건물 ${D.total}동, 적용 기준을 추출해 판정한 법안 ${Object.keys(D.demos).length}건`);
  // 판정한 법안(시범)은 질문과 상관없이 맨 앞에 요약해 둔다. 빠지면 "판정한 법안이 없다"고 잘못 답함
  lines.push("[판정한 법안 " + Object.keys(D.demos).length + "건] " + Object.keys(D.demos).map((no) => {
    const d = D.demos[no], b = D.bills.find((x) => x.no === no);
    return `${no} ${b ? b.name : ""}(${d.title}): 대상 ${d.counts["대상"]}동, 경계선 ${d.counts["경계선"]}동, 비대상 ${d.counts["비대상"]}동, 판정불가 ${d.counts["판정불가"]}동 — ${d.conclusion}`;
  }).join(" / "));
  lines.push("[분야별 법안 수] " + Object.keys(fieldCnt).map((k) => `${D.fields[k] || "미분류"} ${fieldCnt[k]}건`).join(", "));
  bills.forEach((b) => {
    const d = D.demos[b.no];
    lines.push(`[법안 ${b.no}] ${b.name} | 위원회 ${b.committee} | 제안일 ${b.date} | 분야 ${D.fields[b.field] || "미분류"}`);
    lines.push(`  제안이유 요약: ${String(b.summary).slice(0, 600)}`);
    if (d) {
      lines.push(`  판정(${D.region} ${D.total}동): 대상 ${d.counts["대상"]}동, 경계선 ${d.counts["경계선"]}동, 비대상 ${d.counts["비대상"]}동, 판정불가 ${d.counts["판정불가"]}동`);
      lines.push(`  근거 원문: ${d.source_text} | 해석: ${d.rule_note} | 결론: ${d.conclusion}`);
    } else {
      lines.push("  판정: 아직 적용 기준을 추출하지 않아 건물 판정 없음");
    }
  });
  return lines.join("\n");
}

const SYSTEM = [
  "너는 「빼곡」 행정 화면의 질의 도우미다. 지자체 담당 공무원이 국회 계류 법안과 시범 지역 건물 판정 결과를 묻는다.",
  "규칙:",
  "1. 아래 [근거]에 있는 내용만으로 한국어로 답한다. 근거에 없으면 '제공된 자료에서는 확인되지 않습니다'라고 말한다.",
  "2. 법안을 말할 때는 의안번호를 함께 적는다.",
  "3. 숫자는 근거에 적힌 그대로만 쓴다. 계산하거나 추정한 숫자를 만들지 않는다.",
  "4. 판정 결과는 건축물 데이터 기반 추정이며 법률 판단이 아니라는 점을 필요하면 짧게 덧붙인다.",
  "5. 특정 개인·주소·소유자에 대해 말하지 않는다. 개별 건물이 법 적용 대상인지 확정해 주지 않는다.",
  "6. 6문장 이내, 공문체가 아닌 쉬운 존댓말로 쓴다.",
].join("\n");

function numbersNotInContext(answer, ctx, q) {
  const norm = (s) => s.replace(/,/g, "");
  const hay = norm(ctx + " " + q);
  const nums = (answer.match(/\d[\d,]*(\.\d+)?/g) || []).map(norm);
  return Array.from(new Set(nums.filter((n) => Number(n) > 10 && !hay.includes(n))));
}

module.exports = async function handler(req, res) {
  const okOrigin = cors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method === "GET") {
    res.status(200).json({ ok: !!process.env.OPENAI_API_KEY, model: MODEL });
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ error: "POST만 받습니다" }); return; }
  if (!okOrigin) { res.status(403).json({ error: "허용하지 않은 사이트입니다" }); return; }

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) { res.status(429).json({ error: "질문이 너무 잦습니다. 1분 뒤에 다시 해 주세요." }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const q = String((body && body.q) || "").trim().slice(0, 300);
  const billNo = /^\d{7}$/.test(String(body && body.bill)) ? String(body.bill) : "";
  if (!q) { res.status(400).json({ error: "질문이 비어 있습니다" }); return; }

  if (PII.test(q)) {
    res.status(200).json({ answer: "전화번호·주민등록번호·이메일 같은 개인정보는 받지 않습니다. 개인정보를 빼고 다시 질문해 주세요.", sources: [], fixed: true });
    return;
  }
  if (PERSONAL_JUDGE.test(q)) {
    res.status(200).json({
      answer: "개별 집이나 건물이 법 적용 대상인지는 이 도우미가 판정하지 않습니다. 화면의 판정은 건축물 데이터로 추정한 결과이며 법률 판단이 아닙니다. 법안별 집계와 건물 명부를 확인하신 뒤, 최종 판단은 담당 부서 검토와 시행령 확정 후 기준을 따라 주세요.",
      sources: [], fixed: true,
    });
    return;
  }
  if (!process.env.OPENAI_API_KEY) { res.status(503).json({ error: "AI 키가 설정되지 않았습니다" }); return; }

  try {
    const D = await loadData();
    const picked = retrieve(D, q, billNo);
    const ctx = context(D, picked);
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + process.env.OPENAI_API_KEY },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 600,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: "[근거]\n" + ctx + "\n\n[질문]\n" + q },
        ],
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || "OpenAI 오류 " + r.status);
    const answer = String(j.choices[0].message.content || "").trim();
    // 근거 표시는 답에 실제로 인용한 법안만 (없으면 질문의 기준 법안)
    const pool = picked.concat(Object.keys(D.demos).map((no) => D.bills.find((b) => b.no === no)).filter((b) => b && !picked.includes(b)));
    let cited = pool.filter((b) => answer.includes(b.no));
    if (!cited.length && billNo) cited = picked.filter((b) => b.no === billNo);
    res.status(200).json({
      answer,
      sources: cited.map((b) => ({ no: b.no, name: b.name, judged: !!D.demos[b.no] })),
      unverified: numbersNotInContext(answer, ctx, q),
      model: MODEL,
    });
  } catch (e) {
    // 오류 문구에 키 일부가 섞여 나오지 않게 가린다
    const msg = String(e.message || e).replace(/sk-[\w*-]+/g, "sk-***").slice(0, 200);
    res.status(502).json({ error: "답을 만들지 못했습니다: " + msg });
  }
};
