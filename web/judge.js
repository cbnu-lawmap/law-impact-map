/*
 * 법안 영향 지도 — 건물 판정 로직
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
 */
(function (global) {
  "use strict";

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

  var api = { judge: judge, countAll: countAll, STATUSES: STATUSES, isEmpty: isEmpty };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.Judge = api;
})(this);
