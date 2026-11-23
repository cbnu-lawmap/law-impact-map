"""주별 의원 발의 법안 수 (21대·22대): RNN 발의량 예측 노트북(notebooks/bill_volume_rnn.ipynb)용

    python collect/collect_volume.py

- 열린국회 의안 목록(nzmimeepazxkubdpn)을 AGE=21, 22 로 모두 받아 **주별 건수만** 저장한다.
  법안 이름·의원 이름은 저장하지 않는다 (정치 중립, 집계만 남김).
- 의원 발의만 센다: 제안자(PROPOSER)에 '정부'나 '위원장'이 들어간 법안은 뺀다 (collect_history.py 의 proposer_kind 와 같은 규칙).
- 주는 월요일 시작 (week_start = 그 주 월요일). 제안일(PROPOSE_DT)이 없는 법안은 뺀다.
- 위원회(COMMITTEE)는 '소관 위원회'다. 막 낸 법안은 아직 위원회에 회부되지 않아 비어 있을 수 있다.
  그래서 국토교통위원회 건수는 **수집한 날 기준으로 소관 위원회가 정해진 법안만** 센다.
  최근 몇 주는 회부가 덜 끝나 실제보다 적게 나올 수 있다 (committee_empty 열로 빈 칸 수를 함께 남긴다).
- 범위(scope): filter_bills.py·collect_history.py 와 같은 위원회 + 법안 이름 낱말 규칙 (처리 결과는 따지지 않음).
- 22대 범위 법안은 data/bills_field_pred.csv 의 FIELD_PRED(1~9)로 분야별 건수도 센다 (예측 파일에 없는 법안은 field_na).
- 키(ASSEMBLY_API_KEY)가 없으면 조용히 건너뛴다. 결과: data/bill_volume_weekly.csv
"""
import csv
import datetime as dt
import os
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from http_retry import get_json  # noqa: E402

load_dotenv()
KEY = os.getenv("ASSEMBLY_API_KEY")

LIST_SERVICE = "nzmimeepazxkubdpn"
BASE = "https://open.assembly.go.kr/portal/openapi/"
AGES = (21, 22)
MOLIT = "국토교통위원회"

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
FIELDS = range(1, 10)   # collect/build_web_data.py FIELD_NAMES


def in_scope(r):
    name = r.get("BILL_NAME") or ""
    return r.get("COMMITTEE") in TARGET and any(k in name for k in INCLUDE) and not any(k in name for k in EXCLUDE)


def is_member_bill(r):
    p = r.get("PROPOSER") or ""
    return "정부" not in p and "위원장" not in p


def week_start(d):
    day = dt.date.fromisoformat(d[:10])
    return day - dt.timedelta(days=day.weekday())


def fetch(age):
    rows, page = [], 1
    while True:
        params = {"KEY": KEY, "TYPE": "json", "pIndex": page, "pSize": 1000, "AGE": age}
        body = get_json(BASE + LIST_SERVICE, params, label=f"{age}대 목록 {page}페이지")
        if LIST_SERVICE not in body:
            print("응답 이상:", {k: v for k, v in body.items() if k != "KEY"})
            break
        part = body[LIST_SERVICE][1]["row"]
        total = body[LIST_SERVICE][0]["head"][0]["list_total_count"]
        rows.extend(part)
        print(f"{age}대 {page}페이지: 누적 {len(rows)} / {total}")
        if not part or len(rows) >= total:
            break
        page += 1
        time.sleep(0.3)
    return rows


def load_fields():
    p = DATA / "bills_field_pred.csv"
    if not p.exists():
        return {}
    with open(p, encoding="utf-8-sig") as f:
        return {r["BILL_NO"]: int(r["FIELD_PRED"]) for r in csv.DictReader(f) if r.get("FIELD_PRED")}


def main():
    if not KEY:
        print("ASSEMBLY_API_KEY 없음: 수집을 건너뜀")
        return
    fields = load_fields()
    cols = ["total", "committee_empty", MOLIT, "scope", "scope_molit"] + [f"field_{k}" for k in FIELDS] + ["field_na"]
    out = []
    for age in AGES:
        rows = fetch(age)
        cnt = defaultdict(Counter)
        skipped = Counter()
        for r in rows:
            if not is_member_bill(r):
                skipped["정부·위원장"] += 1
                continue
            d = r.get("PROPOSE_DT") or ""
            if len(d) < 10:
                skipped["제안일 없음"] += 1
                continue
            c = cnt[week_start(d)]
            c["total"] += 1
            comm = r.get("COMMITTEE") or ""
            if not comm:
                c["committee_empty"] += 1
            if comm == MOLIT:
                c[MOLIT] += 1
            if in_scope(r):
                c["scope"] += 1
                if comm == MOLIT:
                    c["scope_molit"] += 1
                if age == 22:
                    k = fields.get(str(r.get("BILL_NO")))
                    c[f"field_{k}" if k in FIELDS else "field_na"] += 1
        print(f"{age}대: 전체 {len(rows)}건, 의원 발의 {sum(c['total'] for c in cnt.values())}건, 뺀 것 {dict(skipped)}")
        if not cnt:
            continue
        # 빈 주(발의 0건)도 0으로 채워 주가 빠지지 않게 한다
        w, last = min(cnt), max(cnt)
        while w <= last:
            out.append({"week_start": w.isoformat(), "age": age, **{k: cnt[w][k] for k in cols}})
            w += dt.timedelta(days=7)

    if not out:
        print("모은 것이 없음")
        return
    path = DATA / "bill_volume_weekly.csv"
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        wr = csv.DictWriter(f, fieldnames=["week_start", "age"] + cols)
        wr.writeheader()
        wr.writerows(out)
    print(f"저장 완료: {path.relative_to(ROOT)} ({len(out)}주)")


if __name__ == "__main__":
    main()
