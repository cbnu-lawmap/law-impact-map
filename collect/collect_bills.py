import os, csv, time, requests
from dotenv import load_dotenv

load_dotenv()
KEY = os.getenv("ASSEMBLY_API_KEY")
SERVICE = "nzmimeepazxkubdpn"
URL = f"https://open.assembly.go.kr/portal/openapi/{SERVICE}"
PSIZE = 100

os.makedirs("data", exist_ok=True)
rows = []
page = 1

while True:
    params = {"KEY": KEY, "TYPE": "json", "pIndex": page, "pSize": PSIZE, "AGE": 22}
    res = requests.get(URL, params=params, timeout=30)
    body = res.json()
    if SERVICE not in body:
        print("응답 이상:", body)
        break
    head = body[SERVICE][0]["head"]
    part = body[SERVICE][1]["row"]
    total = head[0]["list_total_count"]
    rows.extend(part)
    print(f"{page}페이지: 누적 {len(rows)} / {total}")
    if not part or len(rows) >= total:
        break
    page += 1
    time.sleep(0.3)

if rows:
    with open("data/bills_raw.csv", "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print("저장 완료: data/bills_raw.csv")