"""통과 예측 특징용: 법안 심사 경과·공동발의 정보 수집

    python collect/collect_process.py          # 21대 학습용 + 22대 지금 법안

대상: data/bills_history_21.csv (21대, 학습) 와 data/bills_summary.csv (22대, 지금 계류 법안)
결과: data/bills_process_21.csv, data/bills_process_22.csv (utf-8-sig)

쓰는 API (열린국회정보, docs/열린국회_API_목록.md)
- nzmimeepazxkubdpn (국회의원 발의법률안): 회부일·상정일·위원회 처리일, 대표발의자·공동발의자 의원 코드(MONA_CD)
- TVBPMBILL11 (법률안 심사 및 처리): 상정일 교차 확인, 빈 값 채우기
- ALLBILLV2 (의안정보 통합): 상정일(JRCMIT_PRSNT_DT) 교차 확인, 빈 값 채우기
- nqbeopthavwwfbekw (역대 국회의원 위원회 경력, 대수별) + nyzrglyvagmrypezq (지금 의원 위원회 경력):
  의원 코드별 위원회 경력과 기간. **제안일에** 소관 위원회 위원이었는지 본다 (제안 시점에 알 수 있는 정보).
  ALLNAMEMBER 의 소속 위원회(BLNG_CMIT_NM)는 가장 최근 대수 것만 있어 21대 소속을 알 수 없으므로 쓰지 않는다.

저장 원칙
- 의원 이름·정당은 저장하지도 찍지도 않는다. 의원 코드는 메모리 안에서 위원회 소속을 맞추는 데만 쓰고 버린다.
  CSV 에는 숫자·0/1 값만 남긴다 (공동발의자 수, 소관 위원회 소속 여부·인원 등).
- 소위원회 회부일은 위 API 어디에도 없어 수집하지 않는다.
- 대안반영 관계는 결과(정답)와 이어진 정보라 특징으로 쓰지 않고 설명용 0/1 (ALT_REFLECTED) 만 남긴다.
  어느 대안에 반영됐는지(대안 의안번호)는 이 API들에 따로 열이 없어 남기지 않는다.
- 키(ASSEMBLY_API_KEY)가 없으면 조용히 건너뛴다. 호출은 http_retry.get_json (키가 든 주소를 찍지 않음).
"""
import csv
import os
import re
import sys
import time
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
sys.path.insert(0, str(Path(__file__).resolve().parent))
from http_retry import ApiError, get_json  # noqa: E402

load_dotenv()
KEY = os.getenv("ASSEMBLY_API_KEY")
BASE = "https://open.assembly.go.kr/portal/openapi/"

# 22대에 환경노동위원회가 기후에너지환경노동위원회로 이름이 바뀌었다: 같은 위원회로 본다
SAME_CMT = {"기후에너지환경노동위원회": "환경노동위원회"}
PRESENT_WINDOW = 90   # "제안 뒤 90일 안에 상정" 표시 기준 (현재 단계 반영 특징)


def fetch_all(service, params, label):
    rows, page = [], 1
    while True:
        body = get_json(BASE + service, {"KEY": KEY, "TYPE": "json", "pIndex": page, "pSize": 1000, **params},
                        label=f"{label} {page}페이지")
        if service not in body:
            res = body.get("RESULT") or {}
            print(f"  {label}: 응답 이상 ({res.get('CODE')})")
            break
        head = body[service][0]["head"]
        part = body[service][1]["row"] if len(body[service]) > 1 else []
        total = head[0]["list_total_count"]
        rows.extend(part)
        if page == 1 or len(rows) >= total:
            print(f"  {label}: {len(rows)} / {total}")
        if not part or len(rows) >= total:
            break
        page += 1
        time.sleep(0.3)
    return rows


def cmt(name):
    n = (name or "").replace(" ", "")
    return SAME_CMT.get(n, n)


def d(s):
    s = (s or "").strip()[:10]
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


def days(a, b):
    return (b - a).days if a and b else ""


def split_list(s):
    return [x.strip() for x in (s or "").split(",") if x.strip()]


LOOK = ("국토교통위원회", "행정안전위원회", "환경노동위원회")


def dot_date(s):
    try:
        y, m, dd = (int(x) for x in s.strip().split("."))
        return date(y, m, dd)
    except (ValueError, AttributeError):
        return None


def committee_spells(age):
    """의원 코드 -> [(위원회 이름, 시작일, 끝일)] (그 대수). 이름은 쓰지 않는다.
    nqbeopthavwwfbekw (역대 의원 위원회 경력, 대수별) + nyzrglyvagmrypezq (지금 의원 위원회 경력, 모든 대수)
    PROFILE_SJ = 위원회 이름(앞에 '제21대' 가 붙기도 함), FRTO_DATE = 'YYYY.MM.DD ~ YYYY.MM.DD' (끝이 비면 지금도 위원)"""
    unit = f"1000{age}"
    rows = fetch_all("nqbeopthavwwfbekw", {"PROFILE_UNIT_CD": unit}, f"역대 의원 위원회 경력 {age}대")
    rows += [r for r in fetch_all("nyzrglyvagmrypezq", {}, "지금 의원 위원회 경력") if str(r.get("PROFILE_UNIT_CD")) == unit]
    out, seen = {}, set()
    for r in rows:
        name = re.sub(r"^제\d+대", "", (r.get("PROFILE_SJ") or "").replace(" ", ""))
        fr, _, to = (r.get("FRTO_DATE") or "").partition("~")
        key = (r.get("MONA_CD"), name, fr.strip(), to.strip())
        if not key[0] or not name or key in seen:
            continue
        seen.add(key)
        out.setdefault(key[0], []).append((name, dot_date(fr), dot_date(to) if to.strip() else date.max))
    n = sum(len(v) for v in out.values())
    print(f"  {age}대 위원회 경력 {n}건, 의원 {len(out)}명, 날짜 못 읽은 경력 {sum(1 for v in out.values() for x in v if not x[1])}건, "
          "위원회별 의원 수: " + ", ".join(f"{k} {sum(any(k in x[0] for x in v) for v in out.values())}명" for k in LOOK))
    return out


def in_committee(spells, code, committee, when):
    """제안일(when)에 그 의원이 소관 위원회 위원이었으면 1, 아니면 0, 경력 자료가 없으면 None.
    22대 기후에너지환경노동위원회는 이름 안에 환경노동위원회가 들어 있어 부분 일치로 같은 위원회로 본다."""
    if code not in spells:
        return None
    base = committee[:-1] if committee.endswith("회") else committee   # '국토교통위원장' 같은 이름도 잡는다
    for name, fr, to in spells[code]:
        if base and base in name and (when is None or fr is None or fr <= when <= to):
            return 1
    return 0


def main():
    if not KEY:
        print("ASSEMBLY_API_KEY 없음: 수집을 건너뜀")
        return

    targets = {
        21: [r["BILL_NO"] for r in csv.DictReader(open(DATA / "bills_history_21.csv", encoding="utf-8-sig"))],
        22: [r["BILL_NO"] for r in csv.DictReader(open(DATA / "bills_summary.csv", encoding="utf-8-sig"))],
    }
    for age, nos in targets.items():
        era = f"제{age}대"
        print(f"== {era}: 대상 {len(nos)}건")
        want = set(nos)
        lst = {r["BILL_NO"]: r for r in fetch_all("nzmimeepazxkubdpn", {"AGE": age}, "발의법률안") if r["BILL_NO"] in want}
        tv = {r["BILL_NO"]: r for r in fetch_all("TVBPMBILL11", {"AGE": age}, "심사 및 처리") if r["BILL_NO"] in want}
        try:
            allb = {r["BILL_NO"]: r for r in fetch_all("ALLBILLV2", {"ERACO": era}, "의안정보 통합") if r["BILL_NO"] in want}
        except ApiError as e:
            print("  ALLBILLV2 실패, 건너뜀:", e)
            allb = {}
        spells = committee_spells(age)

        out, agree, disagree, filled, coded, matched = [], 0, 0, 0, 0, 0
        for no in nos:
            a, t, b = lst.get(no), tv.get(no), allb.get(no)
            if not a and not t:
                continue
            g = lambda k: (a or {}).get(k) or (t or {}).get(k) or ""   # noqa: E731
            prop = d(g("PROPOSE_DT"))
            refer = d(g("COMMITTEE_DT"))
            pres_l, pres_t, pres_b = d((a or {}).get("CMT_PRESENT_DT")), d((t or {}).get("CMT_PRESENT_DT")), d((b or {}).get("JRCMIT_PRSNT_DT"))
            for x in (pres_t, pres_b):
                if pres_l and x:
                    agree, disagree = (agree + 1, disagree) if x == pres_l else (agree, disagree + 1)
            present = pres_l or pres_t or pres_b
            if present and not pres_l:
                filled += 1
            cmt_proc = d(g("CMT_PROC_DT"))
            committee = cmt(g("COMMITTEE") or g("CURR_COMMITTEE"))

            publ = split_list((a or {}).get("PUBL_PROPOSER"))
            publ_codes = split_list((a or {}).get("PUBL_MONA_CD"))
            rep = g("RST_MONA_CD")
            r_in = in_committee(spells, rep, committee, prop)
            rep_in = "" if r_in is None else r_in
            flags = [in_committee(spells, c, committee, prop) for c in publ_codes]
            known = [x for x in flags if x is not None]
            coded += len(publ_codes)
            matched += len(known)
            in_n = sum(known)
            res = (g("CMT_PROC_RESULT_CD") or "") + " " + (g("PROC_RESULT") or "")
            dp = days(prop, present)
            out.append({
                "BILL_NO": no,
                "PROPOSE_DT": prop.isoformat() if prop else "",
                # 제안 시점에 아는 것 (A)
                "COSPONSOR_N": len(publ) if a else "",
                "REP_IN_CMT": rep_in,
                "COSPONSOR_CODED_N": len(known) if a else "",
                "COSPONSOR_IN_CMT_N": in_n if a else "",
                "COSPONSOR_IN_CMT_SHARE": round(in_n / len(known), 4) if known else "",
                # 제안 뒤에 생기는 것 (B, 현재 단계 반영)
                "COMMITTEE_DT": refer.isoformat() if refer else "",
                "CMT_PRESENT_DT": present.isoformat() if present else "",
                "CMT_PROC_DT": cmt_proc.isoformat() if cmt_proc else "",
                "DAYS_TO_REFER": days(prop, refer),
                "DAYS_TO_PRESENT": dp,
                "PRESENTED": int(bool(present)),
                f"PRESENTED_{PRESENT_WINDOW}D": int(dp != "" and dp <= PRESENT_WINDOW),
                # 설명용 (정답과 이어져 특징으로 쓰지 않음)
                "ALT_REFLECTED": int("대안반영" in res),
            })
        rep_known = sum(o["REP_IN_CMT"] != "" for o in out)
        print(f"  저장 {len(out)}건 / 대상 {len(nos)}건, 상정일 있음 {sum(o['PRESENTED'] for o in out)}건"
              f" (다른 API로 채움 {filled}건, 교차 확인 일치 {agree} 불일치 {disagree})")
        print(f"  대표발의자 위원회 소속 판정 {rep_known}건 (소속 {sum(o['REP_IN_CMT'] == 1 for o in out)}건),"
              f" 공동발의자 코드 {coded}개 중 소속 확인 {matched}개, 대안반영 {sum(o['ALT_REFLECTED'] for o in out)}건")
        path = DATA / f"bills_process_{age}.csv"
        with open(path, "w", newline="", encoding="utf-8-sig") as f:
            w = csv.DictWriter(f, fieldnames=list(out[0].keys()))
            w.writeheader()
            w.writerows(out)
        print("  저장 완료:", path.relative_to(ROOT))


if __name__ == "__main__":
    main()
