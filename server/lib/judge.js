// 자동 생성 파일: web/judge.js 의 복사본이다. 여기를 고치지 말고 web/judge.js 를 고친 뒤 node server/scripts/sync-judge.js 를 실행할 것.
/*
 * 빼곡 — 건물 판정 로직
 *
 * 규칙 형식
 *   { 용도: ["08000"], 연면적: {min, max}, 층수: {min}, 사용승인: {before: "1990-01-01"}, 위임: ["용도"] }
 *   - 위임: 법률이 시행령에 넘긴 기준. 나머지 기준을 충족해도 확정할 수 없으므로 판정불가
 *
 * 판정 4단계
 *   대상     모든 기준 충족
 *   경계선   기준에 근소하게 못 미침 (수치 ±10%, 연도 ±1년)
 *   비대상   기준에 해당하지 않음
 *   판정불가 판정에 필요한 속성이 비어 있음 / 시행령 위임
 *
 * collect/build_web_data.py 의 judge() 와 같은 규칙이다. 한쪽을 고치면 다른 쪽도 고칠 것.
 * 서버(검토 에이전트)는 이 파일의 복사본 server/lib/judge.js 를 쓴다. 이 파일을 고친 뒤
 * node server/scripts/sync-judge.js 로 복사본을 다시 만들 것 (--check 는 다르면 실패).
 */
(function (global) {
  "use strict";

  // 건축물대장 주용도 코드(대분류) → 이름. data/building_use_codes.csv(별표1 대조)와 맞출 것
  var USE_NAMES = {
    "01000": "단독주택", "02000": "공동주택", "03000": "제1종근린생활시설", "04000": "제2종근린생활시설",
    "05000": "문화및집회시설", "06000": "종교시설", "07000": "판매시설", "08000": "운수시설",
    "09000": "의료시설", "10000": "교육연구시설", "11000": "노유자시설", "12000": "수련시설",
    "13000": "운동시설", "14000": "업무시설", "15000": "숙박시설", "16000": "위락시설",
    "17000": "공장", "18000": "창고시설", "19000": "위험물저장및처리시설", "20000": "자동차관련시설",
    "21000": "동물및식물관련시설", "22000": "자원순환관련시설", "23000": "교정시설",
    "24000": "방송통신시설", "25000": "발전시설", "26000": "묘지관련시설", "27000": "관광휴게시설",
    "28000": "장례시설", "29000": "야영장시설",
  };

  // 화면·문서에 보일 용도 이름. 코드는 모르는 값일 때만 덧붙인다 (CSV에는 코드 열이 따로 있음)
  function useName(code) {
    if (isEmpty(code)) return "(없음)";
    return USE_NAMES[code] || "기타 용도(코드 " + code + ")";
  }

  // 구조 코드 → 이름 (건축HUB 표제부 코드표, docs/data_check.md 4절)
  var STRUCT_NAMES = {
    "10": "조적구조", "11": "벽돌구조", "12": "블록구조", "19": "기타조적구조",
    "21": "철근콘크리트구조", "31": "일반철골구조", "32": "경량철골구조",
    "41": "철골콘크리트구조", "42": "철골철근콘크리트구조", "51": "일반목구조",
  };
  function structName(code) {
    if (isEmpty(code)) return "(없음)";
    return STRUCT_NAMES[code] || "기타 구조(코드 " + code + ")";
  }

  var NEAR_RATIO = 0.1;
  var NEAR_YEARS = 1;
  var STATUSES = ["대상", "경계선", "비대상", "판정불가"];
  var ATTR = { 용도: "usability", 연면적: "totalarea", 층수: "grnd_flr", 사용승인: "useapr_day" };

  function isEmpty(v) {
    return v === null || v === undefined || v === "" || v === 0;
  }

  /** 건물 속성 p 와 규칙 rule 로 {status, reason} 을 돌려준다. */
  function judge(p, rule) {
    var k;
    for (k in ATTR) {
      if (rule[k] !== undefined && isEmpty(p[ATTR[k]])) {
        return { status: "판정불가", reason: "속성 없음(" + k + ")" };
      }
    }
    var near = false;

    if (rule.용도 && rule.용도.indexOf(p.usability) < 0) {
      return { status: "비대상", reason: "용도 불일치" };
    }

    var nums = ["연면적", "층수"];
    for (var i = 0; i < nums.length; i++) {
      k = nums[i];
      var r = rule[k];
      if (!r) continue;
      var v = Number(p[ATTR[k]]);
      if (r.min !== undefined && v < r.min) {
        if (v >= r.min * (1 - NEAR_RATIO)) near = true;
        else return { status: "비대상", reason: k + " 미달" };
      }
      if (r.max !== undefined && v > r.max) {
        if (v <= r.max * (1 + NEAR_RATIO)) near = true;
        else return { status: "비대상", reason: k + " 초과" };
      }
    }

    if (rule.사용승인) {
      var d = String(p.useapr_day).slice(0, 8);
      var before = String(rule.사용승인.before).replace(/-/g, "");
      var nearLimit = String(Number(before.slice(0, 4)) + NEAR_YEARS) + before.slice(4);
      if (d >= before) {
        if (d < nearLimit) near = true;
        else return { status: "비대상", reason: "사용승인 기준 이후" };
      }
    }

    if (rule.위임 && rule.위임.length) {
      return { status: "판정불가", reason: "시행령 위임(" + rule.위임.join("·") + ")" };
    }
    return near ? { status: "경계선", reason: "기준 ±10% / ±1년" } : { status: "대상", reason: "기준 충족" };
  }

  /** 건물 속성 배열에 규칙을 적용해 단계별 동수와 사유별 동수를 센다. */
  function countAll(propsList, rule) {
    var counts = {}, reasons = {};
    STATUSES.forEach(function (s) { counts[s] = 0; });
    propsList.forEach(function (p) {
      var r = judge(p, rule);
      counts[r.status]++;
      var key = r.status + "|" + r.reason;
      reasons[key] = (reasons[key] || 0) + 1;
    });
    return { counts: counts, reasons: reasons };
  }

  var api = { judge: judge, countAll: countAll, STATUSES: STATUSES, isEmpty: isEmpty, USE_NAMES: USE_NAMES, useName: useName, structName: structName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.Judge = api;
})(this);
