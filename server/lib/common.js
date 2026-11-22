/*
 * 빼곡 서버 함수 공통 부품 (api/ask.js, api/agent.js 가 함께 씀)
 *
 *   - CORS 허용 사이트 목록과 헤더
 *   - IP당 호출 수 제한 (함수마다 따로 센다)
 *   - 개인정보(전화번호·주민번호·이메일) / 개별 건물 판정 질문 거르기
 *   - 답에 나온 숫자가 근거에 있는지 대조
 *   - 공개 데이터 읽기 (DATA_DIR 이 있으면 로컬 파일, 없으면 DATA_BASE 주소)
 *   - 오류 문구에서 키 가리기
 */
const fs = require("fs");
const path = require("path");

const DATA_BASE = process.env.DATA_BASE || "https://cbnu-lawmap.github.io/law-impact-map/data/";

const ALLOWED = [
  "https://cbnu-lawmap.github.io",
  "http://localhost:8000",
  "http://localhost:8766",
  "http://127.0.0.1:8000",
];

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

/** IP당 windowMs 안에 max 회를 넘으면 true 를 돌려주는 함수를 만든다. */
function createLimiter(rate) {
  const hits = new Map(); // ip -> [시각]
  return function limited(ip) {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < rate.windowMs);
    list.push(now);
    hits.set(ip, list);
    return list.length > rate.max;
  };
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
}

function readBody(req) {
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  return body || {};
}

const PII = /(01[016789][-\s]?\d{3,4}[-\s]?\d{4})|(\d{6}[-\s]?[1-4]\d{6})|([\w.+-]+@[\w-]+\.[\w.]+)/;
const PERSONAL_JUDGE = /(우리\s*집|내\s*집|제\s*집|내\s*건물|제\s*건물|우리\s*건물|저희\s*(집|건물)).*(대상|해당|적용|걸리)/;

const PII_ANSWER = "전화번호·주민등록번호·이메일 같은 개인정보는 받지 않습니다. 개인정보를 빼고 다시 질문해 주세요.";
const PERSONAL_ANSWER = "개별 집이나 건물이 법 적용 대상인지는 이 도우미가 판정하지 않습니다. 화면의 판정은 건축물 데이터로 추정한 결과이며 법률 판단이 아닙니다. 법안별 집계와 건물 명부를 확인하신 뒤, 최종 판단은 담당 부서 검토와 시행령 확정 후 기준을 따라 주세요.";

/** 답에 나온 10 넘는 숫자 가운데 근거(ctx)·질문(q)에 없는 것 */
function numbersNotInContext(answer, ctx, q) {
  const norm = (s) => s.replace(/,/g, "");
  const hay = norm(ctx + " " + q);
  const nums = (answer.match(/\d[\d,]*(\.\d+)?/g) || []).map(norm);
  return Array.from(new Set(nums.filter((n) => Number(n) > 10 && !hay.includes(n))));
}

/** 공개 데이터 파일 하나 읽기. DATA_DIR(로컬 시험용)이 있으면 파일에서, 없으면 DATA_BASE 에서 받는다. */
async function loadJson(name) {
  const dir = process.env.DATA_DIR;
  if (dir) return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  const r = await fetch((process.env.DATA_BASE || DATA_BASE) + name);
  if (!r.ok) throw new Error(name + " 을 받지 못했습니다 (" + r.status + ")");
  return r.json();
}

// 오류 문구에 키 일부가 섞여 나오지 않게 가린다
function maskKey(e) {
  return String((e && e.message) || e).replace(/sk-[\w*-]+/g, "sk-***").slice(0, 200);
}

module.exports = {
  DATA_BASE, ALLOWED, cors, createLimiter, clientIp, readBody,
  PII, PERSONAL_JUDGE, PII_ANSWER, PERSONAL_ANSWER, numbersNotInContext, loadJson, maskKey,
};
