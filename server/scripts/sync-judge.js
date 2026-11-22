#!/usr/bin/env node
/*
 * 판정 로직 한 곳에 두기
 *
 * 원본은 web/judge.js 하나다 (화면이 GitHub Pages 에서 그대로 읽는다).
 * Vercel 은 server/ 만 올리므로 서버 함수는 ../web 을 읽을 수 없다. 그래서 server/lib/judge.js 에
 * 머리말 한 줄 + web/judge.js 내용 그대로를 복사해 둔다.
 *
 *   node server/scripts/sync-judge.js          복사본을 다시 만든다 (web/judge.js 를 고친 뒤 실행)
 *   node server/scripts/sync-judge.js --check  복사본이 원본과 다르면 실패 (테스트에서 실행)
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "web", "judge.js");
const OUT = path.join(__dirname, "..", "lib", "judge.js");
const HEADER = "// 자동 생성 파일: web/judge.js 의 복사본이다. 여기를 고치지 말고 web/judge.js 를 고친 뒤 node server/scripts/sync-judge.js 를 실행할 것.\n";

// 줄바꿈(CRLF/LF)은 git 설정에 따라 달라지므로 LF 로 맞춰 비교한다
const lf = (s) => s.replace(/\r\n/g, "\n");
function expected() { return HEADER + lf(fs.readFileSync(SRC, "utf8")); }

if (process.argv.includes("--check")) {
  const now = fs.existsSync(OUT) ? lf(fs.readFileSync(OUT, "utf8")) : "";
  if (now !== expected()) {
    console.error("server/lib/judge.js 가 web/judge.js 와 다릅니다. node server/scripts/sync-judge.js 를 실행하세요.");
    process.exit(1);
  }
  console.log("판정 로직 복사본 일치 (server/lib/judge.js = web/judge.js)");
} else {
  fs.writeFileSync(OUT, expected());
  console.log("server/lib/judge.js 를 다시 만들었습니다.");
}
