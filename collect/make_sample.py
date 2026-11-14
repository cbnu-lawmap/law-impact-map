import csv

from pathlib import Path

# 어느 폴더에서 실행해도 저장소의 data/ 폴더를 쓰도록 이 파일 위치를 기준으로 경로를 정한다
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

with open(DATA / "bills_summary.csv", encoding="utf-8-sig") as f:
    rows = [r for r in csv.DictReader(f) if r["SUMMARY"]]

PICKS = [
    ("연면적이 10만㎡ 이상", "수치 기준: 연면적", 1),
    ("5만제곱미터 이상", "수치 기준: 면적·세대수", 1),
    ("85제곱미터 이하", "수치 기준: 주택 규모", 1),
    ("500세대 이상", "수치 기준: 세대수", 1),
    ("10년이 경과", "수치 기준: 경과 연수", 1),
    ("1.2미터 이상", "수치 기준: 높이", 1),
    ("데이터센터", "용도 기준", 1),
    ("캡슐호텔", "용도 기준", 1),
    ("대통령령으로 정하는 규모", "기준을 시행령에 위임", 2),
    ("일정 규모", "규모만 언급, 숫자 없음", 2),
]

sample, seen = [], set()
for phrase, label, limit in PICKS:
    n = 0
    for r in rows:
        if r["BILL_NO"] in seen:
            continue
        if phrase in r["SUMMARY"]:
            sample.append({**r, "선정이유": label, "매칭문구": phrase})
            seen.add(r["BILL_NO"])
            n += 1
            if n >= limit:
                break

fields = ["BILL_NO", "BILL_ID", "BILL_NAME", "COMMITTEE", "PROPOSE_DT",
          "선정이유", "매칭문구", "DETAIL_LINK", "SUMMARY"]
with open(DATA / "sample_bills.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=fields)
    w.writeheader()
    w.writerows([{k: s[k] for k in fields} for s in sample])

print("샘플 법안 수:", len(sample))
for s in sample:
    print(" -", s["선정이유"], "|", s["BILL_NAME"], s["BILL_NO"])
