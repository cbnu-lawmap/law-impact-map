import os, csv, sys, time
from dotenv import load_dotenv

from pathlib import Path

# 어느 폴더에서 실행해도 저장소의 data/ 폴더를 쓰도록 이 파일 위치를 기준으로 경로를 정한다
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from http_retry import get_json  # noqa: E402  (시간 초과 재시도)
DATA = ROOT / "data"

load_dotenv()
KEY = os.getenv("ASSEMBLY_API_KEY")
if not KEY:
    # 키가 없으면 조용히 건너뛴다 (매일 수집 워크플로에서 비밀값이 없을 때)
    print("ASSEMBLY_API_KEY 없음: 수집을 건너뜀")
    raise SystemExit(0)
SERVICE = "nzmimeepazxkubdpn"
URL = f"https://open.assembly.go.kr/portal/openapi/{SERVICE}"
PSIZE = 100

DATA.mkdir(exist_ok=True)
rows = []
page = 1

while True:
    params = {"KEY": KEY, "TYPE": "json", "pIndex": page, "pSize": PSIZE, "AGE": 22}
    body = get_json(URL, params, label=f"법안 목록 {page}페이지")
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
    with open(DATA / "bills_raw.csv", "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print("저장 완료: data/bills_raw.csv")
