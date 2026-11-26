// 다음 할 일 패널(web/actions.js) 시험: 현장 점검 정렬·열, 의견 문단 자동 생성, 의견서 내용, CSV·HWPX 문단
// 실행: node server/test/next-actions.js
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const WEB = path.join(__dirname, "..", "..", "web");
const NA = require(path.join(WEB, "actions.js"));
const Judge = require(path.join(WEB, "judge.js"));
const demos = require(path.join(WEB, "data", "demo_rules.json")).demos;
const props = JSON.parse(fs.readFileSync(path.join(WEB, "data", "buildings.geojson"), "utf8")).features.map((f) => f.properties);
const demo = (no) => demos.find((d) => d.bill_no === no);
const bill = (no) => ({ no, name: "시험 법안 " + no, committee: "국토교통위원회" });

let n = 0;
function test(name, fn) { fn(); n++; console.log("통과  " + name); }

test("점검 목록: 대상+경계선만, 사용승인 오래된 순 → 같으면 연면적 큰 순, 순번 1부터", () => {
  const d = demo("2206436");
  const list = NA.inspectionList(props, d.rule);
  assert.strictEqual(list.length, d.counts.대상 + d.counts.경계선);
  assert.ok(list.every((r) => r.status === "대상" || r.status === "경계선"));
  list.forEach((r, i) => assert.strictEqual(r.rank, i + 1));
  const year = (r) => (r.date ? Number(r.date.slice(0, 4)) : Infinity);
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    assert.ok(year(a) <= year(b), `${a.rank}·${b.rank} 연도 순서`);
    if (year(a) === year(b)) assert.ok((a.area ?? -1) >= (b.area ?? -1), `${a.rank}·${b.rank} 같은 해 연면적 순서`);
  }
  assert.strictEqual(props[list[0].idx].pnu, list[0].pnu, "idx 가 props 위치와 맞아야 지도 배지가 맞는 건물에 붙음");
});

test("점검 목록 직접 만든 예: 연도 같으면 큰 면적 먼저, 사용승인일 없으면 맨 뒤", () => {
  const rule = { 용도: ["01000"] };
  const P = [
    { pnu: "A", usability: "01000", totalarea: 100, grnd_flr: 1, useapr_day: "19900101" },
    { pnu: "B", usability: "01000", totalarea: 300, grnd_flr: 2, useapr_day: "19901231" },
    { pnu: "C", usability: "01000", totalarea: 50, grnd_flr: 1, useapr_day: "19750505" },
    { pnu: "D", usability: "01000", totalarea: 999, grnd_flr: 3, useapr_day: "" },
    { pnu: "E", usability: "02000", totalarea: 999, grnd_flr: 3, useapr_day: "19500101" },
  ];
  const list = NA.inspectionList(P, rule);
  assert.deepStrictEqual(list.map((r) => r.pnu), ["C", "B", "A", "D"]);
});

test("점검 목록 열: 순번·PNU·용도·연면적·층수·사용승인일·판정만, 건물명·소유자 없음", () => {
  assert.deepStrictEqual(NA.CHECK_HEADER, ["순번", "PNU", "용도", "연면적(㎡)", "층수", "사용승인일", "판정"]);
  const list = NA.inspectionList(props, demo("2206436").rule);
  const csv = NA.checklistCsv(list);
  assert.ok(csv.startsWith("﻿순번,PNU,용도,연면적(㎡),층수,사용승인일,판정\r\n"));
  assert.strictEqual(csv.split("\r\n").length, list.length + 1);
  assert.ok(!/건물명|소유자|성명/.test(csv.split("\r\n")[0]));
  // 연면적 1,000 이상은 쉼표가 들어가므로 따옴표로 감싸 열이 밀리지 않아야 함
  csv.split("\r\n").slice(1).forEach((line) => {
    const cols = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).filter((x) => x !== "");
    assert.strictEqual(cols.length, 7, line);
  });
  const lines = NA.checklistLines(bill("2206436"), list);
  assert.strictEqual(lines.filter((l) => /^\d+ · /.test(l.text)).length, list.length);
  assert.ok(lines.some((l) => l.text.indexOf("법률 판단이 아닙니다") >= 0));
});

test("의견 문단: 경계선이 있으면 동수·비율과 '대상이 바뀔 수 있는' 문장", () => {
  const d = demo("2206436");
  const S = NA.summarize(props, d.rule);
  const t = NA.opinionAuto(S, d, "사창동");
  assert.ok(t.indexOf("대상은 " + S.counts.대상.toLocaleString("ko-KR") + "동") >= 0, t);
  assert.ok(t.indexOf("경계선 건물이 " + S.counts.경계선.toLocaleString("ko-KR") + "동") >= 0, t);
  assert.ok(/대상이 바뀔 수 있는/.test(t));
  assert.ok(!/—/.test(t), "UI 문구에 em dash 금지");
});

test("의견 문단: 경계선 0동·대상 0동·위임이면 각각 다른 문장", () => {
  const mk = (c, rule) => ({ counts: Object.assign({ 대상: 0, 경계선: 0, 비대상: 0, 판정불가: 0 }, c), total: 100, unknownReasons: [] });
  const noNear = NA.opinionAuto(mk({ 대상: 12 }), { rule: { 용도: ["01000"] } });
  assert.ok(/경계선 건물은 없어/.test(noNear), noNear);
  const none = NA.opinionAuto(mk({}), { rule: { 용도: ["01000"] } });
  assert.ok(/근접한 건물이 없어/.test(none), none);
  const deleg = NA.opinionAuto(mk({ 판정불가: 10 }), { rule: { 용도: ["15000"], 위임: ["용도"] } });
  assert.ok(/시행령에 위임/.test(deleg) && /10동은 판정불가/.test(deleg), deleg);
});

test("의견서: 법안명·의안번호·소관위원회, 대상·경계선·판정불가 동수, 근거 문구, 판정불가 사유, 추정 문구", () => {
  const d = demo("2205867");
  const S = NA.summarize(props, d.rule);
  const info = { bill: bill("2205867"), demo: d, S, region: "사창동" };
  const html = NA.opinionHtml(info);
  ["시험 법안 2205867", "2205867", "국토교통위원회", "대상", "경계선", "판정불가", "판정불가 사유", "법률 판단이 아닙니다"].forEach((k) =>
    assert.ok(html.indexOf(k) >= 0, k));
  assert.ok(html.indexOf(S.counts.판정불가.toLocaleString("ko-KR") + "동") >= 0);
  assert.ok(html.indexOf(d.source_text.slice(0, 20)) >= 0, "근거 문구");
  assert.ok(S.unknownReasons.some((r) => /시행령 위임/.test(r[0])), JSON.stringify(S.unknownReasons));
  // 담당자가 고친 문단이 그대로 들어가고, HTML 은 이스케이프
  const edited = NA.opinionHtml(Object.assign({}, info, { opinion: "<b>담당자 수정</b> 문단" }));
  assert.ok(edited.indexOf("&lt;b&gt;담당자 수정&lt;/b&gt; 문단") >= 0);
  // 비워 두면 자동 문단
  assert.strictEqual(NA.opinionModel(Object.assign({}, info, { opinion: "  " })).opinion, NA.opinionAuto(S, d, "사창동"));
  const lines = NA.opinionLines(info);
  assert.strictEqual(lines[0].style, "title");
  ["1. 법안 개요", "2. 관내(사창동) 영향", "3. 적용 기준과 근거 문구", "4. 의견", "5. 판정불가 사유"].forEach((h) =>
    assert.ok(lines.some((l) => l.style === "head" && l.text.indexOf(h) === 0), h));
});

test("시범 법안 모두: 요약 동수가 demo_rules.json 과 같고 점검 목록 수 = 대상+경계선", () => {
  demos.forEach((d) => {
    const S = NA.summarize(props, d.rule);
    assert.deepStrictEqual(S.counts, d.counts, d.bill_no);
    assert.strictEqual(NA.inspectionList(props, d.rule).length, d.counts.대상 + d.counts.경계선, d.bill_no);
    assert.ok(NA.opinionAuto(S, d).length > 20, d.bill_no);
  });
  assert.strictEqual(Judge.STATUSES.length, 4);
});

console.log("다음 할 일 시험 모두 통과 (" + n + "개)");
