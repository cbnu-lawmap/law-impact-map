"""상황판 "기준 확인 대기 / 건물 기준 없음" 나누기가 데이터와 맞는지: python tests/test_criteria_wait.py

web/data/bills.json 의 has_criteria 를 세 출처에서 따로 다시 모아 본다 (collect/build_web_data.py 의
criteria_bill_sets 를 쓰지 않고 여기서 직접 읽는다).
  data/criteria_rule.csv         속성·값이 있는 줄이 있는 법안
  data/ai_feature_extraction.csv use·area·floors·year·delegated 중 하나라도 "미기재"·빈칸이 아닌 법안
  web/data/crosscheck.json       items 가 한 개 이상인 법안
화면(web/admin.js waitKind)은 판정함 / 기준 확인 대기 (has_criteria, 판정 전) / 건물 기준 없음 으로 나눈다.
"""
import csv
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass


def load(name):
    with open(os.path.join(ROOT, "web", "data", name), encoding="utf-8") as f:
        return json.load(f)


def read_csv(name):
    with open(os.path.join(ROOT, "data", name), encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def sources():
    rule = {r["BILL_NO"] for r in read_csv("criteria_rule.csv") if r["ATTRIBUTE"].strip() and r["VALUE"].strip()}
    team = {r["BILL_NO"] for r in read_csv("ai_feature_extraction.csv")
            if any(r[k].strip() not in ("", "미기재") for k in ("use", "area", "floors", "year", "delegated"))}
    cross = {no for no, v in load("crosscheck.json")["bills"].items() if v["items"]}
    return rule, team, cross


def test_has_criteria_union():
    bills = load("bills.json")["bills"]
    nos = {b["no"] for b in bills}
    flagged = {b["no"] for b in bills if b.get("has_criteria")}
    # 해당할 때만 true 로 넣는다 (false·0 은 넣지 않음)
    assert all(b["has_criteria"] is True for b in bills if "has_criteria" in b)
    rule, team, cross = sources()
    union = (rule | team | cross) & nos
    assert flagged == union, f"has_criteria {len(flagged)}건 != 세 출처 합집합 {len(union)}건 (차이 {sorted(flagged ^ union)[:10]})"
    return f"rule {len(rule)} · team {len(team)} · cross {len(cross)} → {len(union)}건"


def test_split_adds_up():
    bills = load("bills.json")["bills"]
    judged = {d["bill_no"] for d in load("demo_rules.json")["demos"]}
    nos = {b["no"] for b in bills}
    assert judged <= nos, f"bills.json 에 없는 판정 법안: {sorted(judged - nos)}"
    flagged = {b["no"] for b in bills if b.get("has_criteria")}
    # 판정한 법안은 규칙이 있으니 기준 후보에도 들어 있어야 한다. 빠지면 crosscheck_criteria.py 를 다시 돌린다
    assert judged <= flagged, f"기준 후보에 없는 판정 법안: {sorted(judged - flagged)}"
    crit = len(flagged - judged)                 # 기준 확인 대기
    none = sum(1 for b in bills if b["no"] not in judged and not b.get("has_criteria"))   # 건물 기준 없음
    assert crit + none + len(judged) == len(bills), (crit, none, len(judged), len(bills))
    return f"판정 {len(judged)} + 기준 확인 대기 {crit} + 건물 기준 없음 {none} = {len(bills)}건"


if __name__ == "__main__":
    ok = True
    for name, fn in (("has_criteria = 세 출처 합집합", test_has_criteria_union),
                     ("판정 + 기준 확인 대기 + 건물 기준 없음 = 전체", test_split_adds_up)):
        try:
            r = fn()
            print("통과  " + name + (f" ({r})" if r else ""))
        except AssertionError as e:
            ok = False
            print("실패  " + name + "\n" + str(e))
    sys.exit(0 if ok else 1)
