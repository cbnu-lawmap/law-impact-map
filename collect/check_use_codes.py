# -*- coding: utf-8 -*-
"""용도 코드표(data/building_use_codes.csv)로 건물 데이터의 주용도 코드를 점검한다.

사용법 (저장소 맨 위 폴더에서):
    python collect/check_use_codes.py
    python collect/check_use_codes.py data/bldginfo_사창동.csv
"""
import csv
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CODE_TABLE = ROOT / "data" / "building_use_codes.csv"
DEFAULT_BLDG = ROOT / "data" / "bldginfo_사창동.csv"


def load_codes(path=CODE_TABLE):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return {r["code"]: r["name"] for r in csv.DictReader(f)}


def main():
    bldg = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_BLDG
    names = load_codes()
    with open(bldg, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    cnt = Counter((r.get("usability") or "").strip() for r in rows)

    print(f"파일: {bldg.name}  / 건물 {len(rows)}동")
    print(f"{'코드':<8}{'용도':<22}{'동 수':>6}")
    unknown = []
    for code, n in sorted(cnt.items(), key=lambda x: -x[1]):
        if code == "":
            print(f"{'(빈칸)':<8}{'대장 미연계 → 판정불가':<20}{n:>6}")
        elif code in names:
            print(f"{code:<8}{names[code]:<20}{n:>6}")
        else:
            print(f"{code:<8}{'!! 코드표에 없음':<20}{n:>6}")
            unknown.append(code)
    print()
    print("코드표에 없는 코드:", unknown if unknown else "없음")


if __name__ == "__main__":
    main()
