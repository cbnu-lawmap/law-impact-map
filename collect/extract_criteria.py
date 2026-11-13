# -*- coding: utf-8 -*-
"""법안 요약문에서 숫자 기준 문장("연면적 1만㎡ 이상", "30년 이상")을 골라내고 단위를 바꾼다.

입력 : data/bills_summary.csv   (BILL_NO, BILL_NAME, SUMMARY 열)
출력 : data/criteria_rule.csv   (기준 1개 = 1행)

사용법 (저장소 맨 위 폴더에서):
    python collect/extract_criteria.py

원칙
- CONTEXT: 문장이 현행 법 설명이면 현행, 법안이 바꾸려는 내용이면 개정, 애매하면 미분류(사람이 확인).
- 숫자는 원문에 적힌 그대로만 읽는다. 원문 구간(VALUE_RAW)과 문장(SENTENCE)을 함께 저장한다.
- 규칙 기반이라 놓치는 문장이 있다(= AI 추출과 비교할 기준선). 틀린 값을 만드느니 놓치는 쪽을 택한다.
"""
import csv
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "bills_summary.csv"
OUT = ROOT / "data" / "criteria_rule.csv"

# ---- 숫자 읽기: "1만5천", "30만", "1,000", "2.5" -> 숫자 ----
NUM = r"\d[\d,]*(?:\.\d+)?(?:\s?(?:억|만|천))*(?:\s?\d[\d,]*(?:\s?(?:천|백))?)?"
UNIT_MULT = {"억": 1e8, "만": 1e4, "천": 1e3, "백": 1e2}


def to_number(text):
    """'1만5천' -> 15000, '30만' -> 300000, '1,000' -> 1000. 못 읽으면 None."""
    t = text.replace(",", "").replace(" ", "")
    total, cur = 0.0, ""
    for ch in t:
        if ch.isdigit() or ch == ".":
            cur += ch
        elif ch in UNIT_MULT:
            total += (float(cur) if cur else 1) * UNIT_MULT[ch]
            cur = ""
        else:
            return None
    if cur:
        total += float(cur)
    return int(total) if total == int(total) else total


# ---- 비교 표현 ----
OPS = {"이상": ">=", "초과": ">", "이하": "<=", "미만": "<", "이내": "<=", "넘는": ">", "넘을": ">", "넘어": ">"}
OP_RE = r"(이상|초과|이하|미만|이내|넘는|넘을|넘어)"

# ---- 기준 종류별 규칙: (속성, 단위, 정규식) ----
AREA = r"(?:㎡|m²|제곱미터|평방미터|평)"
RULES = [
    ("면적", "㎡", re.compile(rf"(?P<n>{NUM})\s?(?P<u>{AREA})\s?(?:의\s)?{OP_RE}")),
    ("층수", "층", re.compile(rf"(?P<n>{NUM})\s?(?P<u>층)\s?(?:의\s)?{OP_RE}")),
    ("높이", "m", re.compile(rf"(?P<n>{NUM})\s?(?P<u>미터|m)\s?(?:의\s)?{OP_RE}")),
    ("세대수", "세대", re.compile(rf"(?P<n>{NUM})\s?(?P<u>세대)\s?(?:의\s)?{OP_RE}")),
    # 연한: "30년 이상 경과", "30년이 지난" (건축물 문맥일 때만)
    ("경과연수", "년", re.compile(rf"(?P<n>{NUM})\s?(?P<u>년)\s?(?:{OP_RE}\s?(?:이\s)?(?:경과|지난|된)|(?:이|가)\s?(?:경과|지난))")),
]

# 면적 앞에 붙는 말로 세부 종류를 구분한다.
AREA_KINDS = ["연면적", "바닥면적", "대지면적", "건축면적", "전용면적", "부지면적", "면적"]
# 경과연수가 건축물 이야기인지 확인할 단어
BUILDING_WORDS = ["건축물", "건물", "사용승인", "준공", "노후", "시설물"]
# 문장이 지금 법(현행)을 설명하는지, 법안이 바꾸려는 내용(개정)인지 가르는 단어
CURRENT_WORDS = ["현행", "현재", "그런데", "있으나", "하고 있음", "하고 있는"]
PROPOSED_WORDS = ["하도록 함", "하도록 하", "신설", "개정", "도록 하려는", "하려는 것", "추가", "상향", "하향", "완화", "강화", "확대"]
# 징역·벌금·임기 등은 건축물 기준이 아니다
EXCLUDE_WORDS = ["징역", "금고", "벌금", "과태료", "임기", "공소시효", "형을 선고"]


def split_sentences(text):
    """요약문을 문장 덩어리로 나눈다(줄바꿈, '다.' 뒤, 항목 기호 앞)."""
    text = text.replace("\r", "")
    parts = re.split(r"\n+|(?<=[다음함임])\.\s+|\s(?=[가-하]\.\s)", text)
    return [p.strip() for p in parts if p and p.strip()]


def area_kind(sentence, start):
    """숫자 앞쪽 30자 안에서 가장 가까운 면적 종류를 찾는다. 못 찾으면 '면적'."""
    window = sentence[max(0, start - 30):start]
    best, pos = "면적", -1
    for kind in AREA_KINDS[:-1]:  # '면적'만 있는 경우는 연면적 같은 말 안에도 들어 있어서 따로 본다
        i = window.rfind(kind)
        if i > pos:
            best, pos = kind, i
    return best


def sentence_context(sentence):
    """문장이 현행 설명이면 '현행', 개정 내용이면 '개정', 둘 다 아니면 '미분류'."""
    cur = any(w in sentence for w in CURRENT_WORDS)
    prop = any(w in sentence for w in PROPOSED_WORDS)
    if cur and not prop:
        return "현행"
    if prop and not cur:
        return "개정"
    return "미분류"


def extract(sentence):
    found = []
    if any(w in sentence for w in EXCLUDE_WORDS):
        # 벌칙 문장에서는 숫자를 뽑지 않는다 (예: 2년 이하의 징역)
        return found
    for attr, unit, rx in RULES:
        for m in rx.finditer(sentence):
            value = to_number(m.group("n"))
            if value is None:
                continue
            if "당" in sentence[max(0, m.start() - 3):m.start()]:
                continue  # "연면적 120㎡당 2㎡ 이하" 같은 비율은 건물 기준이 아니다
            op_word = m.group(m.lastindex) if m.lastindex else ""
            op = OPS.get(op_word)
            if attr == "경과연수":
                if not any(w in sentence for w in BUILDING_WORDS):
                    continue
                op = ">="
            if op is None:
                continue
            kind = attr
            if attr == "면적":
                kind = area_kind(sentence, m.start())
                if kind == "면적":
                    kind = "면적(종류미상)"
                if m.group("u") == "평":
                    value = round(value * 3.3058, 2)
            found.append({
                "ATTRIBUTE": kind,
                "OPERATOR": op,
                "VALUE": value,
                "UNIT": unit,
                "VALUE_RAW": m.group(0),
            })
    return found


def main():
    with open(SRC, encoding="utf-8-sig", newline="") as f:
        bills = list(csv.DictReader(f))

    rows = []
    for b in bills:
        for sent in split_sentences(b.get("SUMMARY") or ""):
            deleg = "Y" if "대통령령" in sent else "N"
            for c in extract(sent):
                rows.append({"BILL_NO": b["BILL_NO"], "BILL_NAME": b["BILL_NAME"], **c,
                             "CONTEXT": sentence_context(sent), "DELEGATED": deleg, "SENTENCE": sent})

    cols = ["BILL_NO", "BILL_NAME", "ATTRIBUTE", "OPERATOR", "VALUE", "UNIT", "VALUE_RAW", "CONTEXT", "DELEGATED", "SENTENCE"]
    with open(OUT, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)

    nb = len({r["BILL_NO"] for r in rows})
    print(f"법안 {len(bills)}건 중 {nb}건에서 기준 {len(rows)}개 추출 → {OUT.name}")
    from collections import Counter
    uniq = {(r["BILL_NO"], r["ATTRIBUTE"], r["OPERATOR"], r["VALUE"]) for r in rows}
    print(f"  (같은 법안의 같은 기준을 합치면 {len(uniq)}개)")
    for k, n in Counter(r["ATTRIBUTE"] for r in rows).most_common():
        print(f"  {k:<14}{n:>5}")
    print("문장 성격:", dict(Counter(r["CONTEXT"] for r in rows)))
    print("대통령령 위임 문장:", sum(1 for r in rows if r["DELEGATED"] == "Y"), "개")


if __name__ == "__main__":
    main()
