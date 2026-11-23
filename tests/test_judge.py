"""파이썬 판정(collect/build_web_data.py judge)이 demo_rules.json 의 동수와 같은지: python tests/test_judge.py

server/test/judge-parity.js 와 짝이다. 그쪽은 서버·화면(자바스크립트) 판정 = demo_rules.json counts 를 보고,
여기서는 데이터를 만든 파이썬 판정을 지금 배포 데이터(web/data/buildings.geojson)에 다시 돌려 같은 동수가 나오는지 본다.
그래서 세 판정(파이썬·화면·서버)이 시범 법안 모두에서 같다.
"""
import json
import os
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "collect"))
from build_web_data import STATUSES, judge  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass


def load(name):
    with open(os.path.join(ROOT, "web", "data", name), encoding="utf-8") as f:
        return json.load(f)


def test_demo_counts():
    demos = load("demo_rules.json")
    props = [ft["properties"] for ft in load("buildings.geojson")["features"]]
    assert len(demos["demos"]) >= 26, f"시범 법안이 26건보다 적음: {len(demos['demos'])}"
    assert demos["total"] == len(props), f"total {demos['total']} != 건물 {len(props)}동"
    bad = []
    for d in demos["demos"]:
        cnt = Counter(judge(p, d["rule"]) for p in props)
        counts = {k: cnt.get(k, 0) for k in STATUSES}
        if counts != d["counts"]:
            bad.append(f"{d['bill_no']} 파이썬 {counts} != demo_rules.json {d['counts']}")
    assert not bad, "\n".join(bad)
    return len(demos["demos"])


def test_household_rule():
    """세대수 규칙: 용도를 먼저 보고, 세대수가 비면 판정불가, min 의 90% 이상이면 경계선"""
    rule = {"용도": ["02000"], "세대수": {"min": 30}}
    assert judge({"usability": "01000", "hhld_cnt": 50}, rule) == "비대상"
    assert judge({"usability": "02000", "hhld_cnt": None}, rule) == "판정불가"
    assert judge({"usability": "02000", "hhld_cnt": 30}, rule) == "대상"
    assert judge({"usability": "02000", "hhld_cnt": 27}, rule) == "경계선"
    assert judge({"usability": "02000", "hhld_cnt": 26}, rule) == "비대상"


if __name__ == "__main__":
    ok = True
    for name, fn in (("시범 법안 동수 = demo_rules.json", test_demo_counts), ("세대수 판정 규칙", test_household_rule)):
        try:
            r = fn()
            print("통과  " + name + (f" ({r}건)" if r else ""))
        except AssertionError as e:
            ok = False
            print("실패  " + name + "\n" + str(e))
    sys.exit(0 if ok else 1)
