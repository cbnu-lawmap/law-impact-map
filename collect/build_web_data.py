# -*- coding: utf-8 -*-
"""
웹 지도(web/)용 데이터를 가볍게 만들어 web/data/ 에 저장한다.

  web/data/buildings.geojson  사창동 건물 (판정용 속성 6개만, 좌표 소수 6자리)
                              값 출처 순서: ① 브이월드 건물통합정보 → ② 건축물대장 표제부
                              (data/bldg_register_사창동.csv, 있을 때만. 필지에 대장 한 줄·건물 한 동이면 대장 값 우선, 바꾼 속성 이름을 reg 에 남김.
                              세대수 hhld_cnt 는 대장에만 있어 이렇게 맞춘 건물에만 붙음)
                              → ③ 그래도 빈 속성에만 신경망 추정 est_area·est_area_p (연면적),
                              est_year·est_year_p (사용승인 연대), est_flr·est_p (지상층수). 추정은 참고용, 판정에 안 씀
  web/data/boundary.geojson   사창동 행정동 경계
  web/data/bills.json         법안 목록 (bills_summary + bills_field_pred + bills_stage + bills_pass_pred, BILL_NO 기준)
                              건물 기준 후보가 있는 법안은 has_criteria: true (criteria_bill_sets 참고)
  web/data/demo_rules.json    판정 시범(사람 추출 2건 + AI 추출·원문 대조) 규칙과 결과 동수

개인정보 보호: 건물명(bld_nm), 동명(dong_nm) 등 이름이 섞일 수 있는 필드는 넣지 않는다.
cheongju_buildings_footprint.geojson 은 출처가 불명이라 사용하지 않는다.

사용법 (law-impact-map 폴더에서):
  python collect/build_web_data.py
"""
import csv
import json
import os
import re
import sys
from collections import Counter

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(ROOT, "web", "data")

EMD = "사창동"
KEEP = ["pnu", "usability", "totalarea", "grnd_flr", "useapr_day", "strct_cd"]
FIELD_NAMES = {
    1: "소방·화재", 2: "재난·안전관리", 3: "건축물 안전·노후·유지관리",
    4: "주택 공급·임대·금융", 5: "공동주택 관리·주거환경", 6: "정비사업·도시재생",
    7: "도시계획·건축규제", 8: "주차·보행·교통", 9: "건설산업·기술·기타",
}
SUMMARY_LEN = 300


def round_coords(c):
    if isinstance(c, (int, float)):
        return round(c, 6)
    return [round_coords(x) for x in c]


REVIEW_DEFAULT = 0.6   # 모델 파일에 review_threshold 가 없을 때 (이전 고정값)


def read_model(name):
    path = os.path.join(OUT, "models", name)
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def pass_tier(p, tiers):
    """통과 가능성 구간 이름: 각 구간은 [min, max) 이고 마지막 구간은 max 를 포함 (web/admin.js passTier 와 같게)"""
    for t in tiers:
        if p < t["max"]:
            return t["name"]
    return tiers[-1]["name"]


def dump(obj, name):
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  {name}: {os.path.getsize(path) / 1024:,.0f} KB")


# ---------------------------------------------------------------- 판정 (web/judge.js 와 같은 규칙)
NEAR_RATIO = 0.10   # 수치 기준 ±10%
NEAR_YEARS = 1      # 연도 기준 ±1년


def empty(v):
    return v is None or v == "" or v == 0


def judge(p, rule):
    """대상 / 경계선 / 비대상 / 판정불가"""
    need = {"용도": "usability", "연면적": "totalarea", "층수": "grnd_flr", "사용승인": "useapr_day"}
    for k, attr in need.items():
        if k in rule and empty(p.get(attr)):
            return "판정불가"
    near = False
    if "용도" in rule and p["usability"] not in rule["용도"]:
        return "비대상"
    # 세대수는 건축물대장 표제부를 맞춘 건물에만 있어(브이월드에 없음) 용도를 먼저 본다.
    # 비었거나 0 이면 판정불가 (공동주택 0 은 미기재, 단독주택은 대부분 0 이라 실제 값으로 믿지 않음)
    if "세대수" in rule and empty(p.get("hhld_cnt")):
        return "판정불가"
    for k, attr in (("연면적", "totalarea"), ("층수", "grnd_flr"), ("세대수", "hhld_cnt")):
        if k not in rule:
            continue
        v, r = float(p[attr]), rule[k]
        if "min" in r and v < r["min"]:
            if v >= r["min"] * (1 - NEAR_RATIO):
                near = True
            else:
                return "비대상"
        if "max" in r and v > r["max"]:
            if v <= r["max"] * (1 + NEAR_RATIO):
                near = True
            else:
                return "비대상"
    if "사용승인" in rule:
        d = str(p["useapr_day"])[:8]
        before = str(rule["사용승인"]["before"]).replace("-", "")
        y = int(before[:4])
        if d >= before:
            if d < f"{y + NEAR_YEARS}{before[4:]}":
                near = True
            else:
                return "비대상"
    if rule.get("위임"):
        # 법률 기준은 충족하지만 나머지 기준을 시행령에 위임 → 확정할 수 없음
        return "판정불가"
    return "경계선" if near else "대상"


DEMO_RULES = [
    {
        "bill_no": "2220631",
        "title": "소방시설법 개정안: 연면적 10만㎡ 이상 물류터미널",
        "source_text": "연면적이 10만㎡ 이상인 물류터미널에도 강화된 소방시설 기준을 적용",
        "rule": {"용도": ["18000"], "연면적": {"min": 100000}},
        "rule_note": "물류터미널은 건축법 시행령 별표1 18호 창고시설이므로 주용도 18000 (data/building_use_codes.csv)",
        "conclusion": "사창동 최대 연면적이 {max_totalarea:,}㎡라 대상 {대상}동, 경계선(9만~10만㎡) {경계선}동",
    },
    {
        "bill_no": "2220895",
        "title": "건축법 개정안: 2층 이상 노대 난간 1.2m",
        "source_text": "대통령령으로 정하는 용도 및 규모의 건축물의 2층 이상인 층에 있는 노대(露臺)에 높이 1.2미터 이상의 난간 설치",
        "rule": {"층수": {"min": 2}, "위임": ["용도", "연면적"]},
        "rule_note": "용도·규모를 시행령에 위임했으므로 2층 이상 건물도 판정불가(후보)로 둠",
        "conclusion": "2층 이상 {candidates_2f_plus:,}동이 후보지만 용도·규모를 시행령에 위임했으므로 판정불가",
    },
]
for _d in DEMO_RULES:
    _d["method"] = "사람 추출"

# AI 추출 규칙: source_text 는 SUMMARY(공백 정리) 원문에서 그대로 복사한 구절이어야 하고(원문 대조),
# rule 의 수치는 모두 source_text 에 나와야 한다. conclusion 은 main() 에서 동수로 만든다.
# subject: 결론 문장에 쓰는 대상 이름
AI_METHOD = "AI 추출(Claude) · 원문 대조 통과 · 담당자 검토 전"
AI_RULES = [
    # ---- 대상·경계선이 나올 수 있는 법안
    {
        "bill_no": "2211666",
        "title": "소방시설법 개정안: 기존 공동주택도 스프링클러",
        "source_text": "공동주택의 모든 층에 스프링클러설비 또는 간이스프링클러설비 의무를 법률로 규정하고, 기존의 공동주택에는 이 법 시행 후 2년이 경과된 날까지 설치하도록",
        "rule": {"용도": ["02000"]},
        "rule_note": "공동주택 → 주용도 02000(공동주택). 기존 건물에도 적용되므로 사용승인일 조건 없음. 이미 설비가 있는 건물인지는 자료에 없음",
        "subject": "공동주택",
    },
    {
        "bill_no": "2217364",
        "title": "소방시설법 개정안: 기존 공동주택 자동확산소화기",
        "source_text": "공동주택(기존의 공동주택 포함)의 모든 층에 자동확산소화기 등을 설치하도록 하고, 강화된 화재안전기준을 적용할 수 있는 특정소방대상물에 공동주택을 추가",
        "rule": {"용도": ["02000"]},
        "rule_note": "공동주택 → 주용도 02000(공동주택). 기존 공동주택 포함이므로 사용승인일 조건 없음",
        "subject": "공동주택",
    },
    {
        "bill_no": "2208341",
        "title": "공동주택관리법 개정안: 실태조사·보수비 보조",
        "source_text": "공동주택실태조사를 실시할 수 있게 하고, 그 결과에 따라 보수ㆍ개량 비용의 전부 또는 일부를 보조ㆍ융자할 수 있도록",
        "rule": {"용도": ["02000"]},
        "rule_note": "공동주택 → 주용도 02000. 제안이유의 '준공 후 20년'은 통계 설명이라 기준으로 쓰지 않음. 실제 보조 대상은 실태조사 결과에 따라 정해짐",
        "subject": "공동주택",
    },
    {
        "bill_no": "2206436",
        "title": "건축물관리법 개정안: 200㎡ 미만·2층 이하 해체 간소화",
        "source_text": "연면적 200제곱미터 미만, 2층 이하 소규모 건축물 등은 건축사 등 전문가 검토를 생략하고 허가권자가 검토하도록 함",
        "rule": {"연면적": {"max": 200}, "층수": {"max": 2}},
        "rule_note": "'200㎡ 미만'을 판정 규칙의 max(이하)로 표현해 정확히 200㎡인 건물도 대상에 들어감. 해체 신고 대상인지(해체 계획 여부)는 자료에 없으며, 해체할 때 적용되는 절차 완화임",
        "subject": "연면적 200㎡ 미만·2층 이하 건물",
    },
    {
        "bill_no": "2200032",
        "title": "건축법 개정안: 85㎡ 이하 주거용 이행강제금 감경",
        "source_text": "이행강제금 감경 대상 건축물의 범위를 연면적이 85제곱미터 이하인 주거용 건축물로 확대",
        "rule": {"용도": ["01000", "02000"], "연면적": {"max": 85}},
        "rule_note": "주거용 건축물 → 주용도 01000(단독주택)·02000(공동주택). 위반건축물 여부는 자료에 없으므로 '위반이 있으면 감경 대상이 되는 건물' 수임",
        "subject": "연면적 85㎡ 이하 주택",
    },
    {
        "bill_no": "2207658",
        "title": "주택법 개정안: 품질점검단 점검대상 30세대 이상 공동주택",
        "source_text": "품질점검단의 점검대상을 30세대 이상 공동주택으로 확대하는 한편",
        "rule": {"용도": ["02000"], "세대수": {"min": 30}},
        "rule_note": "공동주택 → 주용도 02000, 세대수는 건축물대장 표제부(동별) 값. 법안 기준은 단지(사업) 전체 세대수라 "
                     "여러 동 단지의 한 동은 30세대 미만으로 나와 비대상이 될 수 있음. 세대수가 비었거나 0 이면 판정불가. "
                     "점검은 사용검사 전 신축 단지에 하므로 기존 건물은 '같은 규모로 새로 지으면 대상'이라는 뜻",
        "subject": "30세대 이상 공동주택",
    },
    {
        "bill_no": "2200958",
        "title": "소방기본법 개정안: 노유자시설 소방차 전용구역",
        "source_text": "소방본부장이나 소방서장이 노유자시설의 관계인에게 전용구역의 설치를 권고할 수 있도록",
        "rule": {"용도": ["11000"]},
        "rule_note": "노유자시설 → 주용도 11000. 의무가 아니라 권고 대상",
        "subject": "노유자시설",
    },
    {
        "bill_no": "2208175",
        "title": "소방시설법 개정안: 의료·노유자시설 강화기준 비용 지원",
        "source_text": "화재안전기준 등이 강화된 기준을 적용하는 경우 의료시설 및 노유자시설 등에 해당 비용의 일부를 지원",
        "rule": {"용도": ["09000", "11000"]},
        "rule_note": "의료시설 09000, 노유자시설 11000. '등'에 들어갈 다른 용도는 판단하지 않음(하한)",
        "subject": "의료·노유자시설",
    },
    {
        "bill_no": "2205867",
        "title": "소방시설법 개정안: 숙박시설 등 스프링클러 의무",
        "source_text": "숙박시설 등 화재발생 시 피해가 큰 특정소방대상물에도 스프링클러설비 등의 설치 의무를 법률로 규정하고, 그 설치 비용을 국가 또는 지방자치단체가 지원",
        "rule": {"용도": ["15000"]},
        "rule_note": "숙박시설 → 주용도 15000. 요약에 규모 기준이 없어 숙박시설 전체를 대상으로 봄. 법률안 본문에 규모 기준이 있으면 줄어들 수 있고, '등'의 다른 용도는 판단하지 않음",
        "subject": "숙박시설",
    },
    {
        "bill_no": "2220379",
        "title": "건축물관리법 개정안: 공장·창고 화재위험등급",
        "source_text": "공장ㆍ창고ㆍ물류시설 등의 건축물에 대해서는 화재위험도를 종합적으로 평가하여 화재위험등급을 설정",
        "rule": {"용도": ["17000", "18000"]},
        "rule_note": "공장 17000, 창고·물류시설 18000 (물류터미널·집배송 시설은 별표1 18호 창고시설, data/building_use_codes.csv)",
        "subject": "공장·창고·물류시설",
    },
    {
        "bill_no": "2219223",
        "title": "소방시설법 개정안: 위험물 취급 시설 소방시설 의무",
        "source_text": "「위험물안전관리법」에 따른 위험물을 제조ㆍ저장 또는 취급하는 시설을 ‘위험시설’로 정의하고, 해당 시설에 대하여 대통령령으로 정하는 소방시설의 설치ㆍ관리를 의무화",
        "rule": {"용도": ["19000"]},
        "rule_note": "위험물 제조·저장·취급 시설 → 주용도 19000(위험물저장및처리시설). 시행령에 넘긴 것은 소방시설 종류이고 대상 시설은 법률에 정함. 다른 용도 건물 안의 위험물 취급 여부는 자료에 없음(하한)",
        "subject": "위험물저장및처리시설",
    },
    # ---- 사창동에 해당 용도가 없거나 규모 미달인 법안
    {
        "bill_no": "2218807",
        "title": "화재예방법 개정안: 1만㎡ 이상 물류·냉동창고",
        "source_text": "연면적 1만제곱미터 이상의 물류ㆍ냉동 창고와 가연성 외장재를 사용한 대통령령으로 정하는 규모 이상의 창고 등의 소방안전관리자 겸직을 금지",
        "rule": {"용도": ["18000"], "연면적": {"min": 10000}},
        "rule_note": "물류·냉동 창고 → 주용도 18000(창고시설). 물류·냉동 여부는 세부용도라 자료에 없음. 가연성 외장재 창고(시행령 위임)는 판정하지 않음",
        "subject": "연면적 1만㎡ 이상 창고",
    },
    {
        "bill_no": "2217767",
        "title": "건축물관리법 개정안: 공장 정기점검·화재안전 보강",
        "source_text": "건축물 정기점검 및 기존 건축물 화재안전성능보강 대상에 공장을 추가",
        "rule": {"용도": ["17000"]},
        "rule_note": "공장 → 주용도 17000. 정기점검 대상의 규모 기준은 요약에 없음",
        "subject": "공장",
    },
    {
        "bill_no": "2220440",
        "title": "소방시설법 개정안: 화재위험 공장 기초 소방시설",
        "source_text": "화재위험성이 높은 공정이 이루어지는 공장 및 가설건축물 등의 시설에 대해서는 소화기구, 자동소화장치, 옥외소화전설비, 단독경보형 감지기",
        "rule": {"용도": ["17000"]},
        "rule_note": "공장 → 주용도 17000. 공정의 화재위험성은 자료에 없어 공장 전체를 상한으로 봄. 가설건축물은 건축물대장 자료에 없음",
        "subject": "공장",
    },
    {
        "bill_no": "2204049",
        "title": "화재예방법 개정안: 리튬이온전지 공장 강화지구",
        "source_text": "화재예방강화지구에 리튬이온전지를 생산하는 공장을 추가하는 한편",
        "rule": {"용도": ["17000"]},
        "rule_note": "공장 → 주용도 17000. 생산 품목은 자료에 없어 공장 전체를 상한으로 봄. 지구 지정은 시·도지사가 함",
        "subject": "공장",
    },
    {
        "bill_no": "2206177",
        "title": "소방시설법 개정안: 여객터미널 등 방연마스크",
        "source_text": "불특정 다수인이 이용하는 여객터미널 등 특정소방대상물과 대중교통차량의 관계인에게 방연마스크를 설치 및 관리하도록",
        "rule": {"용도": ["08000"]},
        "rule_note": "여객터미널 → 주용도 08000(운수시설). '등'의 다른 특정소방대상물은 판단하지 않음(하한)",
        "subject": "운수시설(여객터미널)",
    },
    {
        "bill_no": "2212824",
        "title": "지진재해대책법 개정안: 대형 전시시설 내진설계",
        "source_text": "전국의 대형 전시시설들도 현행법상 중앙행정기관의 장이 ‘관계 법령 등에 내진설계기준을 정하고 그 이행에 필요한 조치를 취하여야’ 할 대상에 명시적으로 포함",
        "rule": {"용도": ["05000"]},
        "rule_note": "전시시설 → 주용도 05000(문화및집회시설, 전시장 포함)으로 가정. '대형'의 규모 기준은 요약에 없음",
        "subject": "문화및집회시설",
    },
    # ---- 시행령 위임 → 판정불가
    {
        "bill_no": "2204029",
        "title": "소방시설법 개정안: 숙박시설 등 스프링클러(시행령)",
        "source_text": "숙박시설 등 다중이 이용하여 화재발생 시 그 피해가 큰 건축물로서 대통령령으로 정하는 특정소방대상물도 스프링클러설비 또는 간이스프링클러설비의 설치 의무를 법률로 규정",
        "rule": {"용도": ["15000"], "위임": ["용도", "규모"]},
        "rule_note": "숙박시설 15000을 후보로 두되, 대상 특정소방대상물을 대통령령에 위임했으므로 판정불가",
        "subject": "숙박시설",
    },
    {
        "bill_no": "2203169",
        "title": "소방시설법 개정안: 숙박시설 등 2027년까지 스프링클러",
        "source_text": "대통령령에 의한 숙박시설 등 특정소방대상물의 관계인은 대통령령으로 정하는 바에 따라 스프링클러설비 등의 소방시설을 오는 2027년 12월 31일까지 신속하게 설치ㆍ관리",
        "rule": {"용도": ["15000"], "위임": ["용도", "규모"]},
        "rule_note": "숙박시설 15000을 후보로 두되, 설치 대상의 종류를 대통령령에 위임했으므로 판정불가. 2027년은 설치 기한이라 판정 기준이 아님",
        "subject": "숙박시설",
    },
    {
        "bill_no": "2217424",
        "title": "건축법 개정안: 기존 건축물 비상문자동개폐장치",
        "source_text": "현행 시행령은 피난 용도의 옥상을 설치하여야 하는 신규 건축물 중 다중이용 건축물 및 연면적 1천 제곱미터 이상인 공동주택은 옥상으로 통하는 출입문에 비상문자동개폐장치를 설치",
        "rule": {"용도": ["02000"], "연면적": {"min": 1000}, "위임": ["용도", "연면적"]},
        "rule_note": "개정안은 대상 건축물을 대통령령에 위임하므로, 현행 시행령 기준(연면적 1천㎡ 이상 공동주택)을 후보로만 사용. 다중이용 건축물은 판정하지 않음",
        "subject": "연면적 1천㎡ 이상 공동주택",
    },
    {
        "bill_no": "2203510",
        "title": "소방기본법 개정안: 공동주택 충전시설 소방차 진입로",
        "source_text": "대통령령으로 정하는 공동주택의 경우에는 환경친화적 자동차 충전시설 등으로의 소방자동차 진입로 확보를 의무화",
        "rule": {"용도": ["02000"], "위임": ["규모"]},
        "rule_note": "공동주택 02000을 후보로 두되, 대상 공동주택을 대통령령에 위임했으므로 판정불가. 충전시설 유무는 자료에 없음",
        "subject": "공동주택",
    },
    {
        "bill_no": "2219390",
        "title": "건축법 개정안: 노후 지붕 누수 방지 증축 신고",
        "source_text": "지붕의 노후화로 인하여 발생하는 누수ㆍ결로 방지를 위한 지붕의 증축 등 대통령령으로 정하는 요건을 갖춘 증축의 경우에는 건축허가가 아닌 건축신고를 할 수 있도록",
        "rule": {"용도": ["01000", "02000"], "위임": ["노후 요건", "증축 요건"]},
        "rule_note": "'노후 주택 소유자' 부담 완화가 취지라 주택(01000·02000)을 후보로 둠. 노후·증축 요건을 대통령령에 위임했으므로 판정불가",
        "subject": "주택",
    },
    {
        "bill_no": "2218278",
        "title": "주차장법 개정안: 판매·근생 화물 하역 주차기준",
        "source_text": "판매시설, 근린생활시설 등 화물의 하역이 필요한 시설물에 대해서는 화물자동차의 크기 및 하역 작업을 위한 공간 등을 고려하여 별도의 부설주차장 설치기준을 대통령령으로 정하도록",
        "rule": {"용도": ["03000", "04000", "07000"], "위임": ["설치기준", "규모"]},
        "rule_note": "판매시설 07000, 근린생활시설 03000·04000(1·2종). 설치기준을 대통령령에 위임했고, 기존 건물 소급 여부도 요약에 없어 판정불가",
        "subject": "판매·근린생활시설",
    },
    {
        "bill_no": "2219272",
        "title": "건축물관리법 개정안: 노후 건축물 정기점검",
        "source_text": "구조안전 또는 화재안전 등이 대통령령으로 정하는 기준에 해당하는 노후화된 건축물의 경우에도 정기점검을 받도록 의무화",
        "rule": {"위임": ["노후 기준", "용도", "규모"]},
        "rule_note": "노후 여부(사용승인 경과연수 등)와 구조·화재안전 기준을 모두 대통령령에 위임해 모든 건물이 후보이면서 판정불가",
        "subject": "건물",
    },
    {
        "bill_no": "2201658",
        "title": "건축법 개정안: 침수 우려 지역 침수방지설비",
        "source_text": "방재지구와 자연재해위험개선지구 등 대통령령으로 정하는 상습적으로 침수되거나 침수 우려가 있는 지역으로 확대",
        "rule": {"위임": ["지역"]},
        "rule_note": "의무 부과 지역을 대통령령에 위임했고, 사창동이 해당 지구인지는 자료에 없어 모든 건물이 판정불가",
        "subject": "건물",
    },
]
for _d in AI_RULES:
    _d["method"] = AI_METHOD
DEMO_RULES += AI_RULES

STATUSES = ("대상", "경계선", "비대상", "판정불가")
REF_DATE = "2026-11-01"   # "N년 경과" 기준을 사용승인일로 바꿀 때의 기준일


def norm_text(s):
    return re.sub(r"\s+", " ", s or "").strip()


def number_forms(n):
    """규칙 수치가 원문에 나타날 수 있는 표기 (1000 → 1000, 1,000, 1천)"""
    n = int(n) if float(n) == int(n) else n
    forms = {str(n), f"{n:,}"}
    if isinstance(n, int):
        if n >= 10000 and n % 10000 == 0:
            forms.add(f"{n // 10000}만")
        if n >= 1000 and n % 1000 == 0 and n < 10000:
            forms.add(f"{n // 1000}천")
    return forms


def check_source(d, summary):
    """원문 대조: source_text 가 요약 원문에 그대로 있고, 규칙 수치가 모두 source_text 에 나오는지"""
    src = d["source_text"]
    if not 30 <= len(src) <= 160:
        raise ValueError(f"[{d['bill_no']}] source_text 길이 {len(src)}자 (30~160자여야 함)")
    if src not in norm_text(summary):
        raise ValueError(f"[{d['bill_no']}] source_text 가 법안 요약 원문에 없음: {src}")
    rule = d["rule"]
    for k in ("연면적", "층수", "세대수"):
        for b in ("min", "max"):
            if k in rule and b in rule[k]:
                v = rule[k][b]
                if not any(re.search(r"(?<![\d,])" + re.escape(f) + r"(?![\d,])", src)
                           for f in number_forms(v)):
                    raise ValueError(f"[{d['bill_no']}] 규칙 수치 {k}.{b}={v} 가 source_text 에 없음")
    if "사용승인" in rule:
        # "준공 후 N년 이상" → before = 기준일(REF_DATE) - N년. 원문에는 N 이 있어야 함
        before = rule["사용승인"]["before"]
        years = int(REF_DATE[:4]) - int(before[:4])
        if before[4:] != REF_DATE[4:] or not re.search(rf"(?<!\d){years}\s*년", src):
            raise ValueError(f"[{d['bill_no']}] 사용승인 {before} 가 기준일 {REF_DATE} - N년 이 아니거나 "
                             f"source_text 에 '{years}년' 이 없음")


def subj_particle(word):
    """받침에 따라 이/가"""
    for ch in reversed(word):
        if "가" <= ch <= "힣":
            return "이" if (ord(ch) - 0xAC00) % 28 else "가"
    return "이"


def make_conclusion(d, counts, props):
    """동수로 결론 문장을 만든다 (손으로 숫자를 쓰지 않음)"""
    rule, subj = d["rule"], d["subject"]
    if rule.get("위임"):
        base = {k: v for k, v in rule.items() if k != "위임"}
        cand = sum(1 for p in props if judge(p, base) in ("대상", "경계선"))
        deleg = "·".join(rule["위임"])
        return f"{subj} 후보 {cand:,}동이 있으나 시행령 위임({deleg})으로 판정불가"
    t, n = counts["대상"], counts["경계선"]
    if t == 0 and n == 0:
        return f"사창동에 해당하는 {subj}{subj_particle(subj)} 없어 대상 0동, 경계선 0동"
    s = f"{subj} {t:,}동이 대상"
    if n:
        s += f", 기준 근처 {n:,}동이 경계선"
    return s


EST = os.path.join(DATA, "building_imputation_pred.csv")   # notebooks/building_imputation.ipynb 결과
# (노트북 대상 이름, 건물 속성, 붙일 구간 이름 키, 붙일 확률 키)
EST_TARGETS = (("area", "totalarea", "est_area", "est_area_p"),
               ("year", "useapr_day", "est_year", "est_year_p"),
               ("flr", "grnd_flr", "est_flr", "est_p"))
EST_METHOD_KEY = {"area": "est_area_m", "year": "est_year_m", "flr": "est_flr_m"}   # 쓴 방법 (신경망 / 이웃 8동 다수결)


def load_estimates(features):
    """속성이 빈 건물의 추정 구간 {파일 안 순서: {대상: (구간 이름, 확률)}}. 파일이 없으면 빈 dict.
    열쇠는 bldginfo geojson 안 순서(idx)이고, PNU 가 다르면 건물 순서가 바뀐 것이므로 멈춘다."""
    if not os.path.exists(EST):
        print("  building_imputation_pred.csv 없음: 추정값 없이 만듦")
        return {}
    est = {}
    with open(EST, encoding="utf-8-sig", newline="") as f:
        for r in csv.DictReader(f):
            i = int(r["idx"])
            if i >= len(features) or str(features[i]["properties"].get("pnu")) != r["pnu"]:
                raise ValueError(f"building_imputation_pred.csv idx {i} 의 PNU 가 건물 자료와 다름 (노트북을 다시 실행할 것)")
            for t, _, _, _ in EST_TARGETS:
                if r.get(f"est_{t}") and r.get(f"est_{t}_p"):
                    est.setdefault(i, {})[t] = (r[f"est_{t}"], round(float(r[f"est_{t}_p"]), 2), r.get(f"est_{t}_method") or "신경망")
    return est


# 건축물대장 표제부 (공공데이터포털, collect/collect_register.py 가 받음). 없으면 아무것도 바꾸지 않는다.
REGISTER = os.path.join(DATA, f"bldg_register_{EMD}.csv")
# 건물 속성 ← 표제부 열 이름 (우리 이름, API 이름). 세대수(hhld_cnt)는 브이월드에 없어 맞춘 건물에만 생긴다.
# 표제부 세대수는 동별 값이라 단지 전체 세대수 기준보다 작게 나올 수 있다 (docs/bldg_register_analysis.md)
REG_COLS = {"totalarea": ("totalarea", "totArea"), "useapr_day": ("useapr_day", "useAprDay"),
            "grnd_flr": ("grnd_flr", "grndFlrCnt"), "usability": ("main_purps_cd", "mainPurpsCd"),
            "hhld_cnt": ("hhld_cnt", "hhldCnt")}


def reg_value(attr, v):
    """표제부 칸 값 → 우리 속성 값. 비었거나 0, 형식이 맞지 않으면 None (그 속성은 브이월드 값을 둔다)"""
    v = (v or "").strip()
    if not v:
        return None
    try:
        if attr == "totalarea":
            return round(float(v), 2) or None
        if attr in ("grnd_flr", "hhld_cnt"):
            return int(float(v)) or None
    except ValueError:
        return None
    if attr == "useapr_day":
        v = v.replace("-", "")[:8]
        return v if re.fullmatch(r"(19|20)\d{6}", v) else None
    if attr == "usability":
        return v if re.fullmatch(r"\d{5}", v) else None
    return v


def read_register():
    """표제부를 PNU 별 줄 목록으로. 파일이 없으면 None"""
    if not os.path.exists(REGISTER):
        return None
    with open(REGISTER, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    by_pnu = {}
    for r in rows:
        by_pnu.setdefault(str(r.get("pnu", "")).strip(), []).append(r)
    return by_pnu


def register_matches(props_list, by_pnu):
    """지도 건물 순번 → 표제부 한 줄. 표제부는 필지(PNU) 단위라 그 PNU 에 표제부 한 줄, 지도 건물도 한 동일 때만 맞춘다"""
    n_bldg = Counter(str(p.get("pnu")) for p in props_list)
    return {i: by_pnu[str(p.get("pnu"))][0] for i, p in enumerate(props_list)
            if n_bldg[str(p.get("pnu"))] == 1 and len(by_pnu.get(str(p.get("pnu")), [])) == 1}


def merge_register(props_list):
    """판정은 대장 값 우선: 맞춘 건물(register_matches)은 표제부에 값이 있는 속성을 표제부 값으로 바꾼다.
    브이월드 빈 칸을 채우거나 다른 값을 바꾼 속성 이름은 props["reg"] 에 남긴다 (같은 값이면 남기지 않음).
    브이월드 원래 값은 공개 파일에 넣지 않는다 (비교 결과는 docs/bldg_register_analysis.md).
    표제부가 비었거나 0 인 속성은 브이월드 값을 그대로 둔다. 파일이 없으면 아무것도 하지 않는다."""
    by_pnu = read_register()
    if by_pnu is None:
        print(f"  {os.path.basename(REGISTER)} 없음: 건축물대장 표제부를 쓰지 않음 (바뀌는 것 없음)")
        return
    match = register_matches(props_list, by_pnu)
    filled, replaced = Counter(), Counter()
    for i, r in match.items():
        p = props_list[i]
        for attr, cols in REG_COLS.items():
            col = next((c for c in cols if c in r), None)
            v = reg_value(attr, r[col]) if col else None
            if empty(v) or p.get(attr) == v:
                continue
            (filled if empty(p.get(attr)) else replaced)[attr] += 1
            p[attr] = v
            p.setdefault("reg", []).append(attr)
    print(f"  건축물대장 표제부 {sum(map(len, by_pnu.values()))}줄, 맞춘 건물 {len(match)}동: "
          f"빈 칸 채움 {dict(filled)}, 다른 값 바꿈 {dict(replaced)}")


SEEN = os.path.join(DATA, "bills_seen.csv")   # 법안을 처음 본 날 (매일 수집 워크플로가 갱신)


def mark_added(bills):
    """처음 보는 법안에 오늘 날짜(한국 시간)를 added 로 붙이고 bills_seen.csv 에 남긴다.
    bills_seen.csv 를 처음 만들 때 있던 법안은 날짜를 비워 '새로 들어온 법안'에 넣지 않는다."""
    from datetime import datetime, timedelta, timezone
    seen = {}
    if os.path.exists(SEEN):
        with open(SEEN, encoding="utf-8-sig", newline="") as f:
            seen = {r["BILL_NO"]: r["FIRST_SEEN"] for r in csv.DictReader(f)}
    first = not seen
    today = datetime.now(timezone(timedelta(hours=9))).strftime("%Y-%m-%d")
    for b in bills:
        if b["no"] not in seen:
            seen[b["no"]] = "" if first else today
        if seen[b["no"]]:
            b["added"] = seen[b["no"]]
    with open(SEEN, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["BILL_NO", "FIRST_SEEN"])
        w.writerows(sorted(seen.items()))
    print(f"  bills_seen.csv: 오늘 새로 들어온 법안 {sum(1 for b in bills if b.get('added') == today)}건")


CRITERIA_TEAM_FIELDS = ("use", "area", "floors", "year", "delegated")


def criteria_bill_sets():
    """건물 기준 후보가 있는 법안 번호를 출처별로 모은다 (bills.json 의 has_criteria, 상황판 "기준 확인 대기").

    셋 중 하나라도 해당하면 "기준 후보 있음"으로 본다. 파일이 없으면 그 출처는 빈 집합.
      rule   data/criteria_rule.csv: 줄이 있는 법안 (속성 ATTRIBUTE 와 값 VALUE 가 비지 않은 줄만 센다.
             지금 파일은 모든 줄이 둘 다 채워져 있음)
      team   data/ai_feature_extraction.csv: use·area·floors·year·delegated 중 하나라도
             "미기재"나 빈칸이 아닌 법안 (conditions·excluded 는 건물 기준이 아니라 설명이라 보지 않음)
      cross  web/data/crosscheck.json: items 가 한 개 이상인 법안 (collect/crosscheck_criteria.py 가
             판정 시범 규칙·rule·team 을 맞춰 본 결과라서 판정한 법안도 여기 들어 있다)
    판정한 법안(demo_rules.json)은 따로 더하지 않는다. tests/test_criteria_wait.py 가 판정한 법안이
    이 합집합 안에 있는지 본다 (빠지면 crosscheck_criteria.py 를 다시 돌려야 한다는 뜻).
    """
    sets = {"rule": set(), "team": set(), "cross": set()}
    p = os.path.join(DATA, "criteria_rule.csv")
    if os.path.exists(p):
        with open(p, encoding="utf-8-sig", newline="") as f:
            sets["rule"] = {r["BILL_NO"] for r in csv.DictReader(f)
                            if (r.get("ATTRIBUTE") or "").strip() and (r.get("VALUE") or "").strip()}
    p = os.path.join(DATA, "ai_feature_extraction.csv")
    if os.path.exists(p):
        with open(p, encoding="utf-8-sig", newline="") as f:
            sets["team"] = {r["BILL_NO"] for r in csv.DictReader(f)
                            if any((r.get(k) or "").strip() not in ("", "미기재") for k in CRITERIA_TEAM_FIELDS)}
    p = os.path.join(OUT, "crosscheck.json")
    if os.path.exists(p):
        with open(p, encoding="utf-8") as f:
            sets["cross"] = {no for no, v in json.load(f).get("bills", {}).items() if v.get("items")}
    return sets


def main():
    os.makedirs(OUT, exist_ok=True)
    print("web/data 생성")

    # 1) 건물
    with open(os.path.join(DATA, f"bldginfo_{EMD}.geojson"), encoding="utf-8") as f:
        src = json.load(f)
    est = load_estimates(src["features"])
    props_list = []
    for ft in src["features"]:
        p = ft["properties"]
        props = {k: p.get(k) for k in KEEP}
        if props["totalarea"] is not None:
            props["totalarea"] = round(float(props["totalarea"]), 2)
        props_list.append(props)
    merge_register(props_list)   # ② 표제부 (파일이 없으면 그대로)
    n_est = Counter()
    for i, props in enumerate(props_list):
        # ③ 그래도 빈 속성에만 신경망 추정 구간 (참고용). judge() 는 est_* 를 읽지 않으므로 판정에 쓰이지 않는다
        for t, attr, k_lab, k_p in EST_TARGETS:
            if t in est.get(i, {}) and empty(props[attr]):
                props[k_lab], props[k_p], props[EST_METHOD_KEY[t]] = est[i][t]
                n_est[t] += 1
    if est:
        print(f"  추정값 (참고용, 판정에 안 씀): 연면적 {n_est['area']}동, 사용승인 연대 {n_est['year']}동, 지상층수 {n_est['flr']}동")
    feats = [{
        "type": "Feature",
        "geometry": {"type": ft["geometry"]["type"],
                     "coordinates": round_coords(ft["geometry"]["coordinates"])},
        "properties": props,
    } for ft, props in zip(src["features"], props_list)]
    dump({"type": "FeatureCollection",
          "source": "브이월드 WFS lt_c_bldginfo (건물명 등 이름 필드 제외)",
          "features": feats}, "buildings.geojson")

    # 2) 동 경계
    with open(os.path.join(DATA, "cheongju_emd.geojson"), encoding="utf-8") as f:
        emd = json.load(f)
    bnd = [ft for ft in emd["features"] if ft["properties"].get("emd") == EMD]
    dump({"type": "FeatureCollection", "features": bnd}, "boundary.geojson")

    # 3) 법안
    with open(os.path.join(DATA, "bills_field_pred.csv"), encoding="utf-8-sig") as f:
        pred = {r["BILL_NO"]: r for r in csv.DictReader(f)}
    # 심사 단계 (docs/review_stage.md). 없는 법안은 stage 를 비워 둔다.
    with open(os.path.join(DATA, "bills_stage.csv"), encoding="utf-8-sig") as f:
        stage = {r["BILL_NO"]: r for r in csv.DictReader(f)}
    # 통과 가능성 (notebooks/pass_prediction.ipynb 가 만든 신경망 추정). 파일이 없거나 없는 법안은 pass_prob 를 넣지 않는다.
    pass_path = os.path.join(DATA, "bills_pass_pred.csv")
    pass_pred = {}
    if os.path.exists(pass_path):
        with open(pass_path, encoding="utf-8-sig") as f:
            pass_pred = {r["BILL_NO"]: round(float(r["PASS_PROB"]), 3) for r in csv.DictReader(f) if r.get("PASS_PROB")}
    bills = []
    summaries = {}
    full = {}   # 서버(검토 에이전트)용 제안이유 전문. 화면용 bills.json 은 300자로 자른다
    with open(os.path.join(DATA, "bills_summary.csv"), encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            summaries[r["BILL_NO"]] = r["SUMMARY"]
            pr = pred.get(r["BILL_NO"], {})
            s = re.sub(r"^\s*제안이유(\s*및\s*주요내용)?\s*", "", r["SUMMARY"] or "")
            s = re.sub(r"\s+", " ", s).strip()
            full[r["BILL_NO"]] = s
            field = int(pr["FIELD_PRED"]) if pr.get("FIELD_PRED") else None
            bills.append({
                "no": r["BILL_NO"],
                "name": r["BILL_NAME"],
                "committee": r["COMMITTEE"],
                "date": r["PROPOSE_DT"],
                "field": field,
                "conf": round(float(pr["CONF"]), 3) if pr.get("CONF") else None,
                "summary": s[:SUMMARY_LEN] + ("…" if len(s) > SUMMARY_LEN else ""),
                "link": r["DETAIL_LINK"],
                "stage": stage.get(r["BILL_NO"], {}).get("STAGE") or None,
                "stage_date": stage.get(r["BILL_NO"], {}).get("STAGE_DATE") or None,
                "in_progress": (stage[r["BILL_NO"]]["IN_PROGRESS"] == "Y"
                                if r["BILL_NO"] in stage else None),
            })
            if r["BILL_NO"] in pass_pred:
                bills[-1]["pass_prob"] = pass_pred[r["BILL_NO"]]
    # 건물 기준 후보가 있는 법안만 has_criteria: true (pass_prob·added 처럼 해당할 때만 넣는다)
    crit_sets = criteria_bill_sets()
    crit = set().union(*crit_sets.values())
    for b in bills:
        if b["no"] in crit:
            b["has_criteria"] = True
    print("  건물 기준 후보:", ", ".join(f"{k} {len(v)}건" for k, v in crit_sets.items()),
          f"→ 합집합 {sum(1 for b in bills if b.get('has_criteria'))}건 / {len(bills)}건")
    bills.sort(key=lambda b: (b["date"], b["no"]), reverse=True)
    mark_added(bills)
    print("  심사 단계:", dict(Counter(b["stage"] for b in bills)))
    print("  통과 가능성 예측:", sum("pass_prob" in b for b in bills), "건")
    # 노트북이 내보낸 모델 파일에서 화면이 쓸 기준만 옮긴다 (가중치 파일은 커서 화면이 직접 읽지 않음)
    #   review_threshold: 분야 자동 분류 확신도가 이 값 미만이면 "분류 확인 필요" (field_classifier.ipynb 9-2절)
    #   pass_tiers: 통과 가능성 3단계 경계와 구간별 실제 반영 비율 (pass_prediction.ipynb 10-3절)
    fm = read_model("field_classifier.json")
    pm = read_model("pass_prediction.json")
    review = float(fm.get("review_threshold", REVIEW_DEFAULT))
    field_model = {k: fm.get("metrics", {}).get(k) for k in ("model", "model_name", "cv_mean", "cv_mean_logreg", "cv_mean_nn")}
    tiers = pm.get("tiers") or []
    n_review = sum(1 for b in bills if b["conf"] is not None and b["conf"] < review)
    print(f"  분류 확인 필요 (확신도 {review} 미만): {n_review}건 / 분야 모델 {field_model.get('model')}")
    if tiers:
        cnt = Counter(pass_tier(b["pass_prob"], tiers) for b in bills if "pass_prob" in b)
        print("  통과 가능성 3단계:", ", ".join(f"{t['name']} {cnt.get(t['name'], 0)}건" for t in tiers))
    dump({"fields": FIELD_NAMES, "review_threshold": review, "field_model": field_model,
          "pass_tiers": tiers, "bills": bills}, "bills.json")
    dump({"note": "제안이유 전문 (머리말 제거, 공백 정리). 검토 에이전트가 기준을 뽑을 때 쓴다", "summaries": full}, "summaries.json")

    # 4) 판정 시범
    props = [ft["properties"] for ft in feats]
    max_area = max(float(p["totalarea"]) for p in props if not empty(p["totalarea"]))
    out = []
    seen = set()
    for d in DEMO_RULES:
        if d["bill_no"] in seen:
            raise ValueError(f"[{d['bill_no']}] 판정 시범에 중복된 법안")
        seen.add(d["bill_no"])
        if d["bill_no"] not in summaries:
            raise ValueError(f"[{d['bill_no']}] bills_summary.csv 에 없는 법안")
        if len(d["title"]) > 40:
            raise ValueError(f"[{d['bill_no']}] title 이 40자를 넘음")
        cnt = Counter(judge(p, d["rule"]) for p in props)
        counts = {k: cnt.get(k, 0) for k in STATUSES}
        assert sum(counts.values()) == len(props)
        d = dict(d)
        if d["method"] == AI_METHOD:
            check_source(d, summaries[d["bill_no"]])
            d["conclusion"] = make_conclusion(d, counts, props)
        d.pop("subject", None)
        extra = {}
        if d["bill_no"] == "2220631":
            extra["max_totalarea"] = round(max_area)
        if d["bill_no"] == "2220895":
            extra["candidates_2f_plus"] = sum(
                1 for p in props if not empty(p["grnd_flr"]) and p["grnd_flr"] >= 2)
        if "{" in d["conclusion"]:   # 사람 추출 결론의 숫자는 데이터에서 센 값으로 채운다
            d["conclusion"] = d["conclusion"].format(**counts, **extra)
        out.append({**d, "counts": counts, **extra})
        print(f"  [{d['bill_no']}] {counts} {extra}")
    dump({"region": EMD, "total": len(props), "demos": out}, "demo_rules.json")


if __name__ == "__main__":
    main()
