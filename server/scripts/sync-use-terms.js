#!/usr/bin/env node
/*
 * 용도 근거 대조용 시설 이름표 만들기
 *
 * 원본은 data/building_use_codes.csv (팀 코드표, 건축법 시행령 별표1 대조)다.
 * Vercel 은 server/ 만 올리므로 서버 함수는 ../data 를 읽을 수 없어 server/lib/use-terms.js 로 옮겨 둔다.
 * 코드마다 별표1 호 이름, 법령 이름, 하위 시설 예(물류터미널 등)를 공백 없이 담는다.
 * collect/crosscheck_criteria.py 의 LEGAL_ALIASES 와 같은 보탬 이름도 넣는다.
 *
 *   node server/scripts/sync-use-terms.js          다시 만든다 (코드표를 고친 뒤 실행)
 *   node server/scripts/sync-use-terms.js --check  코드표와 다르면 실패 (테스트에서 실행)
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "data", "building_use_codes.csv");
const OUT = path.join(__dirname, "..", "lib", "use-terms.js");

// 코드표 예시에 없지만 법안에 자주 나오는 이름 (crosscheck_criteria.py 의 LEGAL_ALIASES 와 같게)
const ALIASES = {
  "01000": ["주택"],
  "02000": ["주택"],
  "03000": ["근린생활시설"],
  "04000": ["근린생활시설"],
  "05000": ["전시시설"],
  "08000": ["여객터미널"],
  "18000": ["물류시설"],
  "19000": ["위험물"],
};

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1);
}

function expected() {
  const rows = parseCsv(fs.readFileSync(SRC, "utf8").replace(/^﻿/, ""));
  const head = rows.shift();
  const col = (r, name) => r[head.indexOf(name)] || "";
  const terms = {};
  rows.forEach((r) => {
    const code = col(r, "code");
    const list = [col(r, "name"), col(r, "law_name")].concat(col(r, "examples").split(/[,，]/), ALIASES[code] || [])
      .map((t) => t.replace(/\(.*?\)|등$/g, "").replace(/\s+/g, ""))
      .reduce((acc, t) => acc.concat([t], t.includes("·") ? t.split("·") : []), [])
      .filter((t) => t.length >= 2);
    terms[code] = Array.from(new Set(list));
  });
  return "// 자동 생성 파일: data/building_use_codes.csv 에서 만든다. 고치지 말고 node server/scripts/sync-use-terms.js 를 실행할 것.\n" +
    "// 주용도 코드 → 시설 이름(공백 없음). 별표1 호 이름, 법령 이름, 하위 시설 예, 보탬 이름\n" +
    "module.exports = " + JSON.stringify(terms, null, 2) + ";\n";
}

const lf = (s) => s.replace(/\r\n/g, "\n");
if (process.argv.includes("--check")) {
  const now = fs.existsSync(OUT) ? lf(fs.readFileSync(OUT, "utf8")) : "";
  if (now !== expected()) {
    console.error("server/lib/use-terms.js 가 data/building_use_codes.csv 와 다릅니다. node server/scripts/sync-use-terms.js 를 실행하세요.");
    process.exit(1);
  }
  console.log("용도 이름표 일치 (server/lib/use-terms.js = data/building_use_codes.csv)");
} else {
  fs.writeFileSync(OUT, expected());
  console.log("server/lib/use-terms.js 를 다시 만들었습니다.");
}
