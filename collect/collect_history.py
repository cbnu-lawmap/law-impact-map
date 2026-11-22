"""통과 예측 학습용: 처리 결과가 확정된 지난 국회(기본 21대) 법안 수집

    python collect/collect_history.py            # 21대, 목록 + 제안이유
    python collect/collect_history.py --age 21 --no-summary

- 범위는 지금 계류 법안을 고를 때(filter_bills.py)와 같은 위원회·법률 낱말
- 정답(PASSED): 원안가결·수정가결·대안반영폐기·수정안반영폐기 = 1 (내용이 법에 반영됨), 임기만료폐기·철회·부결·폐기 = 0
- 의원 이름은 저장하지 않는다 (정치 중립). 대표발의 종류(의원·정부·위원장)와 발의 인원 수만 남긴다
- 키(ASSEMBLY_API_KEY)가 없으면 조용히 건너뛴다. 결과: data/bills_history_<대수>.csv
"""
import argparse
import csv
import os
import re
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from http_retry import ApiError, get_json  # noqa: E402

load_dotenv()
KEY = os.getenv("ASSEMBLY_API_KEY")

LIST_SERVICE = "nzmimeepazxkubdpn"      # 의안 목록 (collect_bills.py 와 같음)
SUMMARY_SERVICE = "BPMBILLSUMMARY"     # 제안이유 (collect_summaries.py 와 같음)
BASE = "https://open.assembly.go.kr/portal/openapi/"

# filter_bills.py 와 같은 범위 (21대 환경노동위원회는 22대 기후에너지환경노동위원회의 전신)
TARGET = {"국토교통위원회", "행정안전위원회", "환경노동위원회", "기후에너지환경노동위원회"}
INCLUDE = [
    "건축", "주택", "공동주택", "주거환경", "소규모주택정비", "빈집", "재건축", "재개발",
    "도시재생", "국토의 계획 및 이용", "집합건물", "임대주택", "주차장",
    "소방", "화재", "승강기", "다중이용업소", "초고층",
    "시설물의 안전", "재난 및 안전관리", "지진", "내진", "건설기술",
    "편의증진", "녹색건축물", "석면",
]
EXCLUDE = ["공무원", "고용", "광역교통", "분산에너지", "인공지능", "선거", "지방재정", "자동차", "화물"]

PASS = {"원안가결", "수정가결", "대안반영폐기", "수정안반영폐기"}
FAIL = {"임기만료폐기", "철회", "부결", "폐기"}


def in_scope(r):
    name = r.get("BILL_NAME") or ""
    return (r.get("COMMITTEE") in TARGET and any(k in name for k in INCLUDE) and not any(k in name for k in EXCLUDE))


def proposer_kind(p):
    p = p or ""
    if "정부" in p:
        return "정부"
    if "위원장" in p:
        return "위원장"
    return "의원"


def proposer_count(p):
    m = re.search(r"등\s*(\d+)\s*인", p or "")
    return int(m.group(1)) if m else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--age", type=int, default=21)
    ap.add_argument("--no-summary", action="store_true")
    a = ap.parse_args()
    if not KEY:
        print("ASSEMBLY_API_KEY 없음: 수집을 건너뜀")
        return

    rows, page = [], 1
    while True:
        params = {"KEY": KEY, "TYPE": "json", "pIndex": page, "pSize": 1000, "AGE": a.age}
        body = get_json(BASE + LIST_SERVICE, params, label=f"{a.age}대 목록 {page}페이지")
        if LIST_SERVICE not in body:
            print("응답 이상:", {k: v for k, v in body.items() if k != "KEY"})
            break
        part = body[LIST_SERVICE][1]["row"]
        total = body[LIST_SERVICE][0]["head"][0]["list_total_count"]
        rows.extend(part)
        print(f"{page}페이지: 누적 {len(rows)} / {total}")
        if not part or len(rows) >= total:
            break
        page += 1
        time.sleep(0.3)

    out = []
    for r in rows:
        res = r.get("PROC_RESULT") or ""
        if not in_scope(r) or (res not in PASS and res not in FAIL):
            continue
        out.append({
            "BILL_NO": r["BILL_NO"], "BILL_NAME": r["BILL_NAME"], "COMMITTEE": r["COMMITTEE"],
            "PROPOSE_DT": r.get("PROPOSE_DT") or "", "PROPOSER_KIND": proposer_kind(r.get("PROPOSER")),
            "PROPOSER_N": proposer_count(r.get("PROPOSER")), "PROC_RESULT": res, "PASSED": 1 if res in PASS else 0,
            "SUMMARY": "",
        })
    print(f"범위 안 처리 확정 법안: {len(out)}건 (통과 {sum(o['PASSED'] for o in out)}건)")

    if not a.no_summary:
        miss = 0
        for i, o in enumerate(out, 1):
            try:
                body = get_json(BASE + SUMMARY_SERVICE, {"KEY": KEY, "TYPE": "json", "pIndex": 1, "pSize": 5, "BILL_NO": o["BILL_NO"]},
                                label=f"제안이유 {o['BILL_NO']}")
                row = body.get(SUMMARY_SERVICE, [{}, {"row": []}])[1]["row"] if SUMMARY_SERVICE in body else []
                o["SUMMARY"] = re.sub(r"\s+", " ", (row[0].get("SUMMARY") or "") if row else "").strip()
            except (ApiError, KeyError, IndexError):
                pass
            if not o["SUMMARY"]:
                miss += 1
            if i % 200 == 0:
                print(f"  제안이유 {i}/{len(out)}")
            time.sleep(0.15)
        print(f"제안이유 없는 법안: {miss}건")

    path = DATA / f"bills_history_{a.age}.csv"
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
        w.writeheader()
        w.writerows(out)
    print("저장 완료:", path.relative_to(ROOT))


if __name__ == "__main__":
    main()
