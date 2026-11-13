# -*- coding: utf-8 -*-
"""법안별 심사 단계를 만든다.

입력 : bills_raw.csv (collect_bills.py 결과, 저장소에는 없음)  + data/bills_summary.csv (대상 법안 목록)
출력 : data/bills_stage.csv  (BILL_NO, STAGE, STAGE_DATE, IN_PROGRESS)

사용법 (저장소 맨 위 폴더에서):
    python collect/add_review_stage.py 경로/bills_raw.csv

단계는 열린국회 API의 날짜·결과 열에서 만든다. 열 이름 기준 해석이므로
열린국회 API 설명서와 한 번 더 대조해야 한다 (docs/review_stage.md 참고).
"""
import csv
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUMMARY = ROOT / "data" / "bills_summary.csv"
OUT = ROOT / "data" / "bills_stage.csv"

# 진행 중이 아닌 단계(종결)
CLOSED = {"본회의 처리 완료", "대안반영폐기(종결)"}


def classify(r):
    """한 법안 행(dict)을 (단계, 기준날짜)로 바꾼다. 위에서부터 먼저 맞는 것을 쓴다."""
    g = lambda k: (r.get(k) or "").strip()
    if g("PROC_RESULT"):
        return "본회의 처리 완료", g("PROC_DT")
    if g("CMT_PROC_RESULT_CD") == "대안반영폐기":
        return "대안반영폐기(종결)", g("CMT_PROC_DT")
    if g("LAW_PROC_DT"):
        return "법사위 처리", g("LAW_PROC_DT")
    if g("LAW_PRESENT_DT"):
        return "법사위 상정", g("LAW_PRESENT_DT")
    if g("LAW_SUBMIT_DT"):
        return "법사위 회부", g("LAW_SUBMIT_DT")
    if g("CMT_PROC_DT"):
        if g("CMT_PROC_RESULT_CD") == "심사미료":
            return "위원회 심사미료", g("CMT_PROC_DT")
        return "위원회 의결", g("CMT_PROC_DT")
    if g("CMT_PRESENT_DT"):
        return "위원회 상정(심사 중)", g("CMT_PRESENT_DT")
    if g("COMMITTEE_DT"):
        return "위원회 회부(상정 전)", g("COMMITTEE_DT")
    return "접수", g("PROPOSE_DT")


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def main():
    if len(sys.argv) < 2:
        sys.exit("사용법: python collect/add_review_stage.py 경로/bills_raw.csv")
    raw = read_csv(sys.argv[1])
    targets = {r["BILL_NO"] for r in read_csv(SUMMARY)}

    rows = []
    for r in raw:
        if r["BILL_NO"] not in targets:
            continue
        stage, date = classify(r)
        rows.append({
            "BILL_NO": r["BILL_NO"],
            "STAGE": stage,
            "STAGE_DATE": date,
            "IN_PROGRESS": "N" if stage in CLOSED else "Y",
        })

    OUT.parent.mkdir(exist_ok=True)
    with open(OUT, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["BILL_NO", "STAGE", "STAGE_DATE", "IN_PROGRESS"])
        w.writeheader()
        w.writerows(rows)

    print(f"대상 법안 {len(targets)}건 중 {len(rows)}건 저장 → {OUT.name}")
    for stage, n in Counter(x["STAGE"] for x in rows).most_common():
        print(f"  {stage:<18}{n:>5}")

    # 점검: 상정일이 처리일보다 늦은 건(열 해석이 틀렸다는 신호)
    bad = sum(1 for r in raw
              if r.get("CMT_PRESENT_DT") and r.get("CMT_PROC_DT") and r["CMT_PRESENT_DT"] > r["CMT_PROC_DT"])
    print(f"점검: 위원회 상정일이 처리일보다 늦은 법안 {bad}건 (0이면 정상)")


if __name__ == "__main__":
    main()
