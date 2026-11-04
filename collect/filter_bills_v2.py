import csv
from collections import Counter

with open("data/bills_raw.csv", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
    rows = list(reader)
    fields = reader.fieldnames

TARGET = {"국토교통위원회", "행정안전위원회", "기후에너지환경노동위원회"}

INCLUDE = [
    "건축", "주택", "공동주택", "주거환경", "소규모주택정비", "빈집", "재건축", "재개발",
    "도시재생", "국토의 계획 및 이용", "집합건물", "임대주택", "주차장",
    "소방", "화재", "승강기", "다중이용업소", "초고층",
    "시설물의 안전", "재난 및 안전관리", "지진", "내진", "건설기술",
    "편의증진", "녹색건축물", "석면",
]
EXCLUDE = [
    "공무원", "고용", "광역교통", "분산에너지", "인공지능", "선거",
    "지방재정", "자동차", "화물",
]

def ok(r):
    name = r["BILL_NAME"]
    return (
        not r["PROC_RESULT"]
        and r["COMMITTEE"] in TARGET
        and any(k in name for k in INCLUDE)
        and not any(k in name for k in EXCLUDE)
    )

cands = [r for r in rows if ok(r)]
print("2차 후보 건수:", len(cands))
print(Counter(r["COMMITTEE"] for r in cands))

def law(name):
    for s in [" 일부개정법률안", " 전부개정법률안", " 폐지법률안", "법률안"]:
        name = name.replace(s, "")
    return name.strip()

print("\n[법 이름별 건수 상위 40개]")
for n, c in Counter(law(r["BILL_NAME"]) for r in cands).most_common(40):
    print(f"  {n}: {c}")

with open("data/bills_candidates_v2.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=fields)
    w.writeheader()
    w.writerows(cands)
print("\n저장 완료: data/bills_candidates_v2.csv")