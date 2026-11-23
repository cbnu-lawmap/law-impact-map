# -*- coding: utf-8 -*-
"""사창동 건물의 건축물대장 표제부 받기 (공공데이터포털 국토교통부 건축HUB 건축물대장정보 서비스)

API: https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo
     serviceKey, sigunguCd(시군구 5자리), bjdongCd(법정동 5자리), platGbCd, bun, ji, _type=json, numOfRows, pageNo

필지마다 부르지 않고 법정동 하나(sigunguCd + bjdongCd)를 통째로 쪽(pageNo)을 넘기며 받는다.
법정동 코드는 data/bldginfo_사창동.geojson 의 pnu 앞 10자리(시군구 5 + 법정동 5)에서 뽑는다.
받은 줄 중 사창동 건물 pnu 에 있는 필지만 남긴다.

PNU 만들기 (19자리): 시군구 5 + 법정동 5 + 대지구분 1 + 번 4 + 지 4
  표제부 platGbCd 는 0=대지, 1=산, 2=블록이고 PNU 대지구분은 1=일반, 2=산 이므로 PNU 자리 = platGbCd + 1
  (bldginfo 의 pnu 는 모두 11번째 자리가 1). bun·ji 는 4자리로 앞을 0으로 채운다.

남기는 열 (표제부에는 소유자 칸이 없고, 건물명 bldNm·동명 dongNm 처럼 이름이 섞일 수 있는 칸은 넣지 않는다)
  pnu, mgm_bldrgst_pk(대장 번호), main_purps_cd, main_purps_nm, totalarea(연면적 totArea),
  useapr_day(사용승인일 useAprDay), grnd_flr(지상층수 grndFlrCnt), hhld_cnt(세대수 hhldCnt)

키는 환경변수 DATA_GO_KR_KEY (GitHub Secret, 일반 인증키 Decoding) 로만 받는다. 없으면 아무것도 하지 않는다.
요청 주소와 예외 글에는 키가 들어 있으므로 찍지 않는다.

결과: data/bldg_register_사창동.csv
"""
import csv
import json
import os
import re
import sys
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from http_retry import WAITS, TIMEOUT, ApiError  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "data")
SRC = os.path.join(DATA, "bldginfo_사창동.geojson")
OUT = os.path.join(DATA, "bldg_register_사창동.csv")

ENDPOINT = "https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo"
ROWS = 100          # 한 쪽에 받을 줄 수
SLEEP = 0.3         # 쪽 사이 쉬는 시간(초)
MAX_PAGES = 300
COLS = ["pnu", "mgm_bldrgst_pk", "main_purps_cd", "main_purps_nm", "totalarea", "useapr_day", "grnd_flr", "hhld_cnt"]
API = {"mgm_bldrgst_pk": "mgmBldrgstPk", "main_purps_cd": "mainPurpsCd", "main_purps_nm": "mainPurpsCdNm",
       "totalarea": "totArea", "useapr_day": "useAprDay", "grnd_flr": "grndFlrCnt", "hhld_cnt": "hhldCnt"}


def make_pnu(it):
    """표제부 한 줄 → 19자리 PNU. 만들 수 없으면 None"""
    sgg, bjd = str(it.get("sigunguCd", "")).strip(), str(it.get("bjdongCd", "")).strip()
    gb, bun, ji = str(it.get("platGbCd", "")).strip(), str(it.get("bun", "")).strip(), str(it.get("ji", "")).strip()
    if len(sgg) != 5 or len(bjd) != 5 or gb not in ("0", "1") or not bun.isdigit():
        return None
    ji = ji if ji.isdigit() else "0"
    return f"{sgg}{bjd}{int(gb) + 1}{int(bun):04d}{int(ji):04d}"


def api_error_text(text):
    """JSON 이 아닌 응답(게이트웨이 XML 오류 등)에서 오류 이름만 뽑는다"""
    found = re.findall(r"<(returnAuthMsg|errMsg|resultMsg|returnReasonCode|resultCode)>([^<]*)<", text)
    return ", ".join(f"{k}={v}" for k, v in found) or re.sub(r"\s+", " ", text[:200])


def fetch(params, label, key, session=requests, sleep=time.sleep):
    """한 쪽 받기. 연결 오류·시간 초과·5xx 는 다시 시도하고, 인증 오류 같은 응답은 바로 알린다"""
    tries = len(WAITS) + 1
    last = ""
    for n in range(1, tries + 1):
        try:
            res = session.get(ENDPOINT, params={"serviceKey": key, **params}, timeout=TIMEOUT)
            text = res.text.replace(key, "***")
            if res.status_code >= 500:
                last = f"HTTP {res.status_code} {api_error_text(text)}"
            else:
                try:
                    data = json.loads(text)
                except ValueError:
                    raise ApiError(f"{label} HTTP {res.status_code} JSON 아님: {api_error_text(text)}")
                head = data.get("response", {}).get("header", {})
                if str(head.get("resultCode", "00")) not in ("00", "0", "000"):
                    raise ApiError(f"{label} 오류 {head.get('resultCode')} {head.get('resultMsg')}")
                return data["response"]["body"]
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            last = type(e).__name__
        if n < tries:
            print(f"  {label} {n}/{tries}번째 시도 실패 ({last}), {WAITS[n - 1]}초 뒤 다시 시도")
            sleep(WAITS[n - 1])
    raise ApiError(f"{label} {tries}번 모두 실패 ({last})")


def items_of(body):
    items = (body.get("items") or {})
    items = items.get("item", []) if isinstance(items, dict) else []
    return [items] if isinstance(items, dict) else list(items)


def main():
    key = os.environ.get("DATA_GO_KR_KEY", "").strip()
    if not key:
        print("DATA_GO_KR_KEY 없음: 건너뜀")
        return 0
    with open(SRC, encoding="utf-8") as f:
        pnus = {str(ft["properties"]["pnu"]) for ft in json.load(f)["features"]}
    prefixes = sorted({p[:10] for p in pnus})
    print(f"사창동 건물 필지 {len(pnus)}개, 법정동 {len(prefixes)}개: {prefixes}")

    out, seen = [], set()
    for pre in prefixes:
        sgg, bjd = pre[:5], pre[5:]
        total, got = None, 0
        for page in range(1, MAX_PAGES + 1):
            body = fetch({"sigunguCd": sgg, "bjdongCd": bjd, "_type": "json", "numOfRows": ROWS, "pageNo": page},
                         f"{pre} {page}쪽", key)
            total = int(body.get("totalCount") or 0)
            its = items_of(body)
            got += len(its)
            for it in its:
                pnu = make_pnu(it)
                pk = str(it.get("mgmBldrgstPk", "")).strip()
                if pnu not in pnus or (pk and pk in seen):
                    continue
                seen.add(pk)
                row = {"pnu": pnu}
                for c, a in API.items():
                    row[c] = str(it.get(a, "") if it.get(a) is not None else "").strip()
                out.append(row)
            if page == 1:
                print(f"  {pre}: 전체 {total}줄")
            if not its or got >= total:
                break
            time.sleep(SLEEP)
        print(f"  {pre}: {got}줄 받음, 사창동 필지에 해당 {sum(1 for r in out if r['pnu'][:10] == pre)}줄")

    if not out:
        print("사창동 필지에 맞는 표제부가 없음: 파일을 만들지 않음")
        return 1
    out.sort(key=lambda r: (r["pnu"], r["mgm_bldrgst_pk"]))
    with open(OUT, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLS)
        w.writeheader()
        w.writerows(out)
    matched = {r["pnu"] for r in out}
    print(f"저장 {os.path.relpath(OUT, os.path.dirname(HERE))}: {len(out)}줄, 필지 {len(matched)}/{len(pnus)}개")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ApiError as e:
        print("수집 실패:", e)
        sys.exit(1)
