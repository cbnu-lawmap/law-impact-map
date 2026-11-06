# -*- coding: utf-8 -*-
"""
웹 지도(web/)용 데이터를 가볍게 만들어 web/data/ 에 저장한다.

  web/data/buildings.geojson  사창동 건물 (판정용 속성 6개만, 좌표 소수 6자리)
  web/data/boundary.geojson   사창동 행정동 경계
  web/data/bills.json         법안 목록 (bills_summary + bills_field_pred, BILL_NO 기준)
  web/data/demo_rules.json    수작업 판정 시범 2건의 규칙과 결과 동수

개인정보 보호: 건물명(bld_nm), 동명(dong_nm) 등 이름이 섞일 수 있는 필드는 넣지 않는다.
cheongju_buildings_footprint.geojson 은 출처가 불명이라 사용하지 않는다.

사용법 (law-impact-map 폴더에서):
  python collect/build_web_data.py
"""
import csv
import json
import os
import re
import sys
from collections import Counter

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "web", "data")

EMD = "사창동"
KEEP = ["pnu", "usability", "totalarea", "grnd_flr", "useapr_day", "strct_cd"]
FIELD_NAMES = {
    1: "소방·화재", 2: "재난·안전관리", 3: "건축물 안전·노후·유지관리",
    4: "주택 공급·임대·금융", 5: "공동주택 관리·주거환경", 6: "정비사업·도시재생",
    7: "도시계획·건축규제", 8: "주차·보행·교통", 9: "건설산업·기술·기타",
}
SUMMARY_LEN = 300


def round_coords(c):
    if isinstance(c, (int, float)):
        return round(c, 6)
    return [round_coords(x) for x in c]


def dump(obj, name):
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  {name}: {os.path.getsize(path) / 1024:,.0f} KB")


# ---------------------------------------------------------------- 판정 (web/judge.js 와 같은 규칙)
NEAR_RATIO = 0.10   # 수치 기준 ±10%
NEAR_YEARS = 1      # 연도 기준 ±1년


def empty(v):
    return v is None or v == "" or v == 0


def judge(p, rule):
    """대상 / 경계선 / 비대상 / 판정불가"""
    need = {"용도": "usability", "연면적": "totalarea", "층수": "grnd_flr", "사용승인": "useapr_day"}
    for k, attr in need.items():
        if k in rule and empty(p.get(attr)):
            return "판정불가"
    near = False
    if "용도" in rule and p["usability"] not in rule["용도"]:
        return "비대상"
    for k, attr in (("연면적", "totalarea"), ("층수", "grnd_flr")):
        if k not in rule:
            continue
        v, r = float(p[attr]), rule[k]
        if "min" in r and v < r["min"]:
            if v >= r["min"] * (1 - NEAR_RATIO):
                near = True
            else:
                return "비대상"
        if "max" in r and v > r["max"]:
            if v <= r["max"] * (1 + NEAR_RATIO):
                near = True
            else:
                return "비대상"
    if "사용승인" in rule:
        d = str(p["useapr_day"])[:8]
        before = str(rule["사용승인"]["before"]).replace("-", "")
        y = int(before[:4])
        if d >= before:
            if d < f"{y + NEAR_YEARS}{before[4:]}":
                near = True
            else:
                return "비대상"
    if rule.get("위임"):
        # 법률 기준은 충족하지만 나머지 기준을 시행령에 위임 → 확정할 수 없음
        return "판정불가"
    return "경계선" if near else "대상"


DEMO_RULES = [
    {
        "bill_no": "2220631",
        "title": "소방시설법 개정안: 연면적 10만㎡ 이상 물류터미널",
        "source_text": "연면적이 10만㎡ 이상인 물류터미널에도 강화된 소방시설 기준을 적용",
        "rule": {"용도": ["08000"], "연면적": {"min": 100000}},
        "rule_note": "용도 08000(운수시설, 물류터미널 포함)으로 가정. 주용도 코드 매핑은 아직 검증되지 않음",
        "conclusion": "사창동 최대 연면적이 34,703㎡라 대상 0동, 경계선(9만~10만㎡) 0동",
    },
    {
        "bill_no": "2220895",
        "title": "건축법 개정안: 2층 이상 노대 난간 1.2m",
        "source_text": "대통령령으로 정하는 용도 및 규모의 건축물의 2층 이상인 층에 있는 노대(露臺)에 높이 1.2미터 이상의 난간 설치",
        "rule": {"층수": {"min": 2}, "위임": ["용도", "연면적"]},
        "rule_note": "용도·규모를 시행령에 위임했으므로 2층 이상 건물도 판정불가(후보)로 둠",
        "conclusion": "2층 이상 1,836동이 후보지만 용도·규모를 시행령에 위임했으므로 판정불가",
    },
]


def main():
    os.makedirs(OUT, exist_ok=True)
    print("web/data 생성")

    # 1) 건물
    with open(os.path.join(DATA, f"bldginfo_{EMD}.geojson"), encoding="utf-8") as f:
        src = json.load(f)
    feats = []
    for ft in src["features"]:
        p = ft["properties"]
        props = {k: p.get(k) for k in KEEP}
        if props["totalarea"] is not None:
            props["totalarea"] = round(float(props["totalarea"]), 2)
        feats.append({
            "type": "Feature",
            "geometry": {"type": ft["geometry"]["type"],
                         "coordinates": round_coords(ft["geometry"]["coordinates"])},
            "properties": props,
        })
    dump({"type": "FeatureCollection",
          "source": "브이월드 WFS lt_c_bldginfo (건물명 등 이름 필드 제외)",
          "features": feats}, "buildings.geojson")

    # 2) 동 경계
    with open(os.path.join(DATA, "cheongju_emd.geojson"), encoding="utf-8") as f:
        emd = json.load(f)
    bnd = [ft for ft in emd["features"] if ft["properties"].get("emd") == EMD]
    dump({"type": "FeatureCollection", "features": bnd}, "boundary.geojson")

    # 3) 법안
    with open(os.path.join(DATA, "bills_field_pred.csv"), encoding="utf-8-sig") as f:
        pred = {r["BILL_NO"]: r for r in csv.DictReader(f)}
    bills = []
    with open(os.path.join(DATA, "bills_summary.csv"), encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            pr = pred.get(r["BILL_NO"], {})
            s = re.sub(r"^\s*제안이유(\s*및\s*주요내용)?\s*", "", r["SUMMARY"] or "")
            s = re.sub(r"\s+", " ", s).strip()
            field = int(pr["FIELD_PRED"]) if pr.get("FIELD_PRED") else None
            bills.append({
                "no": r["BILL_NO"],
                "name": r["BILL_NAME"],
                "committee": r["COMMITTEE"],
                "date": r["PROPOSE_DT"],
                "field": field,
                "conf": round(float(pr["CONF"]), 3) if pr.get("CONF") else None,
                "summary": s[:SUMMARY_LEN] + ("…" if len(s) > SUMMARY_LEN else ""),
                "link": r["DETAIL_LINK"],
            })
    bills.sort(key=lambda b: (b["date"], b["no"]), reverse=True)
    dump({"fields": FIELD_NAMES, "bills": bills}, "bills.json")

    # 4) 판정 시범
    props = [ft["properties"] for ft in feats]
    max_area = max(float(p["totalarea"]) for p in props if not empty(p["totalarea"]))
    out = []
    for d in DEMO_RULES:
        cnt = Counter(judge(p, d["rule"]) for p in props)
        counts = {k: cnt.get(k, 0) for k in ("대상", "경계선", "비대상", "판정불가")}
        extra = {}
        if d["bill_no"] == "2220631":
            extra["max_totalarea"] = round(max_area)
        if d["bill_no"] == "2220895":
            extra["candidates_2f_plus"] = sum(
                1 for p in props if not empty(p["grnd_flr"]) and p["grnd_flr"] >= 2)
        out.append({**d, "counts": counts, **extra})
        print(f"  [{d['bill_no']}] {counts} {extra}")
    dump({"region": EMD, "total": len(props), "demos": out}, "demo_rules.json")


if __name__ == "__main__":
    main()
