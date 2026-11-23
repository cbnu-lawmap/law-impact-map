#!/usr/bin/env node
/*
 * Agentic RAG 재검색용 출처 글 만들기: data/bill_docs/*.txt → web/data/bill_docs.json
 *
 *   node server/scripts/build-bill-docs.js           파일을 다시 만든다
 *   node server/scripts/build-bill-docs.js --check   지금 파일이 다시 만든 결과와 같은지 확인 (npm test)
 *
 * 서버(server/api/agent.js)는 공개 사이트의 web/data 를 읽으므로, PDF 에서 뽑은 긴 글 전체가 아니라 작게 줄여 싣는다.
 *   bill_text      법안 원문의 개정 부분만 (criteria.js 의 amendedText: 개정문 안에서 새로 들어가는 글. 제안이유·정의 조문·부칙·대비표 뺌)
 *   review_report  검토보고서에서 건물 기준 낱말(연면적·층·용도·위임 문구 등)이 든 문장만, 3,000자까지
 * 사람 이름이 나올 수 있는 문장(의원·전문위원·조사관·위원장·대표발의)은 싣지 않는다.
 * 원문이나 검토보고서가 없는 법안은 그 칸을 넣지 않는다 (에이전트는 "없음" 으로 답함).
 */
const fs = require("fs");
const path = require("path");
const { amendedText, prepDocText, normText } = require("../lib/criteria");

const ROOT = path.join(__dirname, "..", "..");
const DOCS = path.join(ROOT, "data", "bill_docs");
const OUT = path.join(ROOT, "web", "data", "bill_docs.json");
const REVIEW_MAX = 3000;
const NAME_RE = /의원|전문위원|조사관|위원장|대표발의|발의자/;
const CUE_RE = /연면적|바닥면적|제곱미터|㎡|\d+\s*층|층수|준공|사용승인|대통령령|[가-힣]{1,10}부령|조례로|규모|용도|공동주택|근린생활시설|창고|공장|숙박시설|업무시설|판매시설|의료시설|노유자시설|물류/;

function reviewExcerpt(raw) {
  const text = prepDocText(raw);
  const out = [];
  let len = 0;
  for (const s0 of text.split(/(?<=[.])\s+/)) {
    const s = normText(s0);
    if (s.length < 15 || s.length > 400 || NAME_RE.test(s) || !CUE_RE.test(s)) continue;
    if (/·{3,}/.test(s)) continue; // 목차 줄
    if (len + s.length + 1 > REVIEW_MAX) break;
    out.push(s);
    len += s.length + 1;
  }
  return out.join(" ");
}

function build() {
  const docs = {};
  const files = fs.readdirSync(DOCS).filter((f) => /^\d{7}_(원문|검토보고서)\.txt$/.test(f)).sort();
  files.forEach((f) => {
    const [no, kind] = f.replace(/\.txt$/, "").split("_");
    const raw = fs.readFileSync(path.join(DOCS, f), "utf8");
    const d = (docs[no] = docs[no] || {});
    if (kind === "원문") {
      const t = amendedText(raw);
      d.bill_text = NAME_RE.test(t) ? "" : t; // 개정 부분에 이름이 섞이면 싣지 않음 (지금은 없음)
    } else d.review_report = reviewExcerpt(raw);
  });
  return {
    note: "data/bill_docs/*.txt 에서 만든 재검색용 출처 글 (server/scripts/build-bill-docs.js). bill_text = 법안 원문의 개정 부분, review_report = 검토보고서에서 건물 기준 낱말이 든 문장 " + REVIEW_MAX + "자까지. 사람 이름이 든 문장은 뺌.",
    docs,
  };
}

const out = JSON.stringify(build(), null, 1) + "\n";
if (process.argv.includes("--check")) {
  const now = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") : ""; // Windows 줄바꿈 무시
  if (now !== out) { console.error("web/data/bill_docs.json 이 data/bill_docs 와 다릅니다. node server/scripts/build-bill-docs.js 로 다시 만드세요."); process.exit(1); }
  console.log("bill_docs.json 같음");
} else {
  fs.writeFileSync(OUT, out);
  const j = JSON.parse(out);
  console.log("web/data/bill_docs.json " + Object.keys(j.docs).length + "건, " + Math.round(out.length / 1024) + "KB");
}
