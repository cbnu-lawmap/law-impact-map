// 서버 판정(server/lib/judge.js)과 화면 판정(web/judge.js)이 시범 법안 26건 모두에서 같은 동수를 내는지,
// 그리고 demo_rules.json 의 counts(데이터 만들 때 Python 으로 센 값)와도 같은지 본다.
// 실행: node server/test/judge-parity.js
const assert = require("assert");
const path = require("path");
const WEB = path.join(__dirname, "..", "..", "web");

const serverJudge = require("../lib/judge");
const webJudge = require(path.join(WEB, "judge.js"));
const demos = require(path.join(WEB, "data", "demo_rules.json")).demos;
const props = JSON.parse(require("fs").readFileSync(path.join(WEB, "data", "buildings.geojson"), "utf8")).features.map((f) => f.properties);

assert.ok(demos.length >= 26, "시범 법안이 26건보다 적음: " + demos.length);
let n = 0;
demos.forEach((d) => {
  const s = serverJudge.countAll(props, d.rule).counts;
  const w = webJudge.countAll(props, d.rule).counts;
  assert.deepStrictEqual(s, w, d.bill_no + " 서버와 화면 판정이 다름");
  assert.deepStrictEqual(s, d.counts, d.bill_no + " demo_rules.json counts 와 다름");
  n++;
});
console.log("판정 일치: 시범 법안 " + n + "건, 서버 = 화면 = demo_rules.json counts");
