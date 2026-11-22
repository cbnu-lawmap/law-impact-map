"""법안 심사 경과·공동발의 정보 수집 (통과 예측 특징용) - 탐색판"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from http_retry import ApiError, get_json  # noqa: E402

KEY = os.getenv("ASSEMBLY_API_KEY")
BASE = "https://open.assembly.go.kr/portal/openapi/"
SAFE = ("DT", "CMIT", "COMMITTEE", "KIND", "RESULT", "AGE", "ERACO", "DIV", "GBN", "CD", "BILL_NO", "BILL_ID",
        "UNIT", "CNT", "STATUS", "JOB", "DEPT", "ELECT", "REELE", "SE")


def probe(service, extra):
    params = {"KEY": KEY, "TYPE": "json", "pIndex": 1, "pSize": 3, **extra}
    try:
        body = get_json(BASE + service, params, label=service, waits=(3,))
    except ApiError as e:
        print(service, "실패", e)
        return
    if service not in body:
        print(service, extra, "응답:", body.get("RESULT"))
        return
    head = body[service][0]["head"]
    rows = body[service][1]["row"] if len(body[service]) > 1 else []
    print(f"== {service} {extra} total={head[0].get('list_total_count')} result={head[1].get('RESULT') if len(head) > 1 else ''}")
    if rows:
        for k, v in rows[0].items():
            show = v if any(s in k for s in SAFE) else ("(값 있음)" if v not in (None, "") else "(비어 있음)")
            if isinstance(show, str) and len(show) > 80:
                show = show[:80]
            print(f"   {k}: {show}")


if __name__ == "__main__":
    if not KEY:
        print("ASSEMBLY_API_KEY 없음: 건너뜀")
        raise SystemExit(0)
    bid = "PRC_AF70CF74C420463FBD57700717DA07"
    probe("nzmimeepazxkubdpn", {"AGE": 21, "BILL_NO": "2126601"})
    probe("TVBPMBILL11", {"AGE": 21, "BILL_NO": "2126601"})
    probe("ALLBILLV2", {"ERACO": "제21대", "BILL_NO": "2126601"})
    probe("ALLBILLV2", {"BILL_NO": "2126601"})
    for s in ["BILLINFOPPSR", "BILLINFODETAIL", "BPMBILLPPSR", "nzpltgfqabtcpsmai", "ncocpgfiaoituanbr"]:
        probe(s, {"BILL_ID": bid})
    for s in ["nwvrqwxyaytdsfvhu", "ALLNAMEMBER", "nktulghcadyhmiqxi", "nprlapfmaufmqytet", "npffdutiapkzbfyvr",
              "nxrvzonlafugpqjuh"]:
        probe(s, {})
