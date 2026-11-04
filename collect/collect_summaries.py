import os, csv, re, time, requests
from dotenv import load_dotenv

load_dotenv()
KEY = os.getenv("ASSEMBLY_API_KEY")
URL = "https://open.assembly.go.kr/portal/openapi/BPMBILLSUMMARY"

with open("data/bills_candidates_v2.csv", encoding="utf-8-sig") as f:
    cands = list(csv.DictReader(f))

out = []
fail = []
for i, r in enumerate(cands, 1):
    params = {"KEY": KEY, "TYPE": "json", "pIndex": 1, "pSize": 5, "BILL_NO": r["BILL_NO"]}
    summary = ""
    try:
        body = requests.get(URL, params=params, timeout=30).json()
        if "BPMBILLSUMMARY" in body:
            rowlist = body["BPMBILLSUMMARY"][1]["row"]
            summary = rowlist[0].get("SUMMARY", "") if rowlist else ""
    except Exception as e:
        fail.append(r["BILL_NO"])
    if not summary:
        fail.append(r["BILL_NO"])
    out.append({
        "BILL_ID": r["BILL_ID"], "BILL_NO": r["BILL_NO"], "BILL_NAME": r["BILL_NAME"],
        "COMMITTEE": r["COMMITTEE"], "PROPOSE_DT": r["PROPOSE_DT"],
        "DETAIL_LINK": r["DETAIL_LINK"], "SUMMARY": summary,
    })
    if i % 50 == 0:
        print(f"{i} / {len(cands)}")
    time.sleep(0.2)

with open("data/bills_summary.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
    w.writeheader()
    w.writerows(out)

print("\n저장 완료: data/bills_summary.csv")
print("제안이유가 비어 있는 법안:", len(set(fail)))

PATTERN = re.compile(r"\d[\d,\.]*\s*(제곱미터|㎡|층|년|미터|세대|명|퍼센트|%|세|개월|일)")
have = [o for o in out if PATTERN.search(o["SUMMARY"])]
print("숫자 기준(단위 포함)이 보이는 법안:", len(have), "/", len(out))
for o in have[:8]:
    m = PATTERN.search(o["SUMMARY"])
    s = max(0, m.start() - 40)
    snippet = o["SUMMARY"][s:m.end() + 40].replace("\n", " ")
    print(" -", o["BILL_NAME"], "|", snippet)