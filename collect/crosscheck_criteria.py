# -*- coding: utf-8 -*-
"""
기준 교차 확인: 같은 법안의 적용 기준을 세 출처에서 비교한다.

  A. 우리 AI 추출   web/data/demo_rules.json (판정 시범 26건, build_web_data.py 의 DEMO_RULES·AI_RULES)
  B. 규칙 기반      data/criteria_rule.csv (extract_criteria.py, PR #18)
  C. 팀원 AI 추출   data/ai_feature_extraction.csv (PR #20)
                    파일이 없으면 git show origin/feature/ai-feature-extraction:data/ai_feature_extraction.csv 로 읽는다
  D. 원문 정규식    (--docs 를 줄 때만) data/bill_docs/<의안번호>_원문.txt 의 개정 부분(개정문 안의 새 글만.
                    제안이유·정의 조문·부칙·대비표 제외)에 server/lib/criteria.js 의 뽑기를 돌린 것
                    (node server/scripts/compare-bill-docs.js --rules, criteria.js 의 extractFromDoc). 이때는 기본 출력 파일을 건드리지 않고
                    data/criteria_crosscheck_docs.csv 만 쓰고, 원문 출처를 넣기 전후 판정 수를 출력한다

기준 종류(ATTRIBUTE): 용도 / 연면적 / 층수 / 연도(경과연수·사용승인) / 기타(세대수·높이·바닥면적 등)

판정(STATUS), 법안 × 기준 종류마다
  교차 확인됨  2개 이상 출처에 같은 기준·같은 수치가 있음 (미만/이하처럼 경계 표현만 다르면 NOTE 에 "경계 표현 다름")
  확인 필요    기준이 있는 출처끼리 수치가 다름. 용도는 출처끼리 같아도 법안 글의 시설 이름을
               별표1 분류(data/building_use_codes.csv)로 옮긴 것과 하나도 겹치지 않으면 확인 필요
               (예: 물류터미널을 두 출처가 모두 운수시설로 뽑아도 18호 창고시설이므로 확인 필요)
  단일 출처    한 출처에만 있음
교차 확인됨은 사람이 확인했다는 뜻이 아니다. 출처 셋 다 자동 추출이다.

만드는 파일
  data/criteria_crosscheck.csv   법안 × 기준 종류 1행 (utf-8-sig)
  web/data/crosscheck.json       웹 화면용 (출처 중 하나라도 있는 법안만)

노후 후보(--candidates): 경과연수 기준을 사창동 사용승인일(useapr_day)로 판정하면 몇 동인지 계산만 한다.
판정 시범(demo_rules.json)에는 넣지 않는다.

사용법 (law-impact-map 폴더에서):
  python collect/crosscheck_criteria.py
  python collect/crosscheck_criteria.py --team 경로/ai_feature_extraction.csv
  python collect/crosscheck_criteria.py --candidates      # 노후 후보 표(마크다운)도 출력
  python collect/crosscheck_criteria.py --docs data/bill_docs   # 원문 정규식을 넷째 출처로 넣어 비교
"""
import argparse
import csv
import io
import json
import os
import re
import subprocess
import sys
from collections import Counter, OrderedDict

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
WEB = os.path.join(ROOT, "web", "data")
TEAM_REF = "origin/feature/ai-feature-extraction:data/ai_feature_extraction.csv"

sys.path.insert(0, HERE)
from build_web_data import REF_DATE, judge, STATUSES  # noqa: E402  (같은 판정 규칙을 쓴다)

ATTRS = ["용도", "연면적", "층수", "연도", "기타"]
SOURCES = [("ours", "우리 AI"), ("rule", "규칙 기반"), ("team", "팀원 AI")]
ST_OK, ST_CHECK, ST_ONE = "교차 확인됨", "확인 필요", "단일 출처"
OP_WORD = {">=": "이상", "<=": "이하", ">": "초과", "<": "미만", "=": ""}
WORD_OP = {"이상": ">=", "이하": "<=", "초과": ">", "미만": "<", "이내": "<=", "넘는": ">"}
USE_NAMES = {}
# 법령 분류 대조용: 시설 이름(별표1 호 이름 + 하위 시설 예) → 주용도 코드. 예) 물류터미널 → 18000
LEGAL_TERMS = {}
with open(os.path.join(DATA, "building_use_codes.csv"), encoding="utf-8-sig") as _f:
    for _r in csv.DictReader(_f):
        USE_NAMES[_r["code"]] = _r["name"]
        _terms = [_r["name"], _r["law_name"]] + re.split(r"[,，]", _r["examples"])
        for _t in _terms:
            _t = re.sub(r"\(.*?\)|등$|\s+", "", _t.strip())
            if len(_t) >= 2:
                LEGAL_TERMS.setdefault(_t, set()).add(_r["code"])
# 코드표 예시에 없지만 법안에 자주 나오는 이름 (별표1 호 내용 기준으로 사람이 보탬)
LEGAL_ALIASES = {
    "주택": {"01000", "02000"},           # 1호 단독주택·2호 공동주택을 함께 부르는 말
    "여객터미널": {"08000"},               # 8호 운수시설 (여객자동차터미널·공항·항만의 여객시설)
    "물류시설": {"18000"},                 # 18호 다목 물류터미널, 라목 집배송 시설
    "근린생활시설": {"03000", "04000"},     # 3호·4호를 함께 부르는 말
    "전시시설": {"05000"},                 # 5호 라목 전시장
    "위험물": {"19000"},                   # 19호 위험물 저장 및 처리 시설
}  # server/scripts/sync-use-terms.js 의 ALIASES 와 같게 둘 것
for _t, _cs in LEGAL_ALIASES.items():
    LEGAL_TERMS.setdefault(_t, set()).update(_cs)
SUMMARY = {}
with open(os.path.join(DATA, "bills_summary.csv"), encoding="utf-8-sig") as _f:
    for _r in csv.DictReader(_f):
        SUMMARY[_r["BILL_NO"]] = _r["SUMMARY"]


def legal_codes(text):
    """법안 글에 나온 시설 이름을 별표1 분류(주용도 코드)로 옮긴다. {코드: [찾은 이름]}"""
    t = re.sub(r"\s+", "", text or "")
    found = {}
    # 긴 이름부터 찾고 지워서 "물류터미널" 안의 다른 이름이 또 걸리지 않게 한다
    for term in sorted(LEGAL_TERMS, key=len, reverse=True):
        if term in t:
            for c in LEGAL_TERMS[term]:
                found.setdefault(c, []).append(term)
            t = t.replace(term, " ")
    return found

# 팀원 AI 의 용도 글 → 주용도 코드. 위에서부터 찾고, 찾은 글자는 지운 뒤 다음을 찾는다
USE_WORDS = [
    (r"공동주택|아파트|주택단지", ["02000"]),
    (r"단독주택", ["01000"]),
    (r"임대주택|공공주택|(?<![가-힣])주택|주거용 건축물|[가-힣]*주택", ["01000", "02000"]),
    (r"물류터미널|물류시설|집배송", ["18000"]),
    (r"공장", ["17000"]),
    (r"창고", ["18000"]),
    (r"생활숙박|숙박시설", ["15000"]),
    (r"노유자", ["11000"]),
    (r"의료시설", ["09000"]),
    (r"위험물", ["19000"]),
    (r"체육시설|운동시설", ["13000"]),
    (r"업무시설|오피스텔", ["14000"]),
    (r"주차장", ["20000"]),
]


def num_label(v):
    return f"{int(v):,}" if float(v) == int(v) else f"{v:g}"


def unit_of(attr, sub):
    if attr == "연면적" or "면적" in sub:
        return "㎡"
    return {"층수": "층", "연도": "년"}.get(attr) or {"세대수": "세대", "호수": "호", "높이": "m", "기간": "년"}.get(sub, "")


def item_text(it):
    """화면·CSV에 보일 글: 예) 200㎡ 미만, 세대수 500세대 이상, 공동주택"""
    if it["attr"] == "용도":
        return "·".join(USE_NAMES.get(c, c) for c in it["codes"]) if it["codes"] else it["raw"]
    s = num_label(it["value"]) + unit_of(it["attr"], it["sub"])
    w = OP_WORD.get(it["op"], "")
    s = (s + " " + w) if w else s
    if it["attr"] == "연도" and it.get("src") == "ours":
        s = "사용승인 " + s + " 경과"
    if it["sub"]:
        s = it["sub"] + " " + s
    return s


def mk(attr, op=None, value=None, sub="", codes=None, raw="", ctx="", deleg=False):
    return {"attr": attr, "op": op, "value": value, "sub": sub, "codes": codes, "raw": raw, "ctx": ctx, "deleg": deleg}


# ---------------------------------------------------------------- A. 우리 AI 추출
def load_ours():
    with open(os.path.join(WEB, "demo_rules.json"), encoding="utf-8") as f:
        demos = json.load(f)["demos"]
    out, info = {}, {}
    for d in demos:
        r, items = d["rule"], []
        if r.get("용도"):
            items.append(mk("용도", codes=sorted(r["용도"])))
        for k in ("연면적", "층수"):
            for b, op in (("min", ">="), ("max", "<=")):
                if k in r and b in r[k]:
                    items.append(mk(k, op, float(r[k][b])))
        if "사용승인" in r:
            before = str(r["사용승인"]["before"])
            items.append(mk("연도", ">=", float(int(REF_DATE[:4]) - int(before[:4]))))
        for it in items:
            it["src"] = "ours"
        out[d["bill_no"]] = items
        info[d["bill_no"]] = {"title": d.get("title", ""), "method": d["method"], "deleg": r.get("위임", [])}
    return out, info


# ---------------------------------------------------------------- B. 규칙 기반
RULE_ATTR = {"연면적": ("연면적", ""), "층수": ("층수", ""), "경과연수": ("연도", "")}


def load_rule():
    out, names = {}, {}
    seen = set()
    with open(os.path.join(DATA, "criteria_rule.csv"), encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            no = r["BILL_NO"]
            names[no] = r["BILL_NAME"]
            attr, sub = RULE_ATTR.get(r["ATTRIBUTE"], ("기타", r["ATTRIBUTE"]))
            key = (no, attr, sub, r["OPERATOR"], r["VALUE"], r["CONTEXT"])
            if key in seen:
                continue
            seen.add(key)
            it = mk(attr, r["OPERATOR"], float(r["VALUE"]), sub, raw=r["VALUE_RAW"], ctx=r["CONTEXT"],
                    deleg=r["DELEGATED"] == "Y")
            it["src"] = "rule"
            it["sentence"] = r["SENTENCE"]
            out.setdefault(no, []).append(it)
    return out, names


# ---------------------------------------------------------------- C. 팀원 AI 추출
NUM_RE = re.compile(
    r"(?P<op1>>=|<=|=|>|<|≥|≤)?\s*(?P<num>\d[\d,]*(?:\.\d+)?)\s*(?P<mul>만|천)?\s*"
    r"(?P<unit>제곱미터|㎡|m2|m²|평|층|세대|호|년|미터|m(?![a-z]))\s*(?P<op2>이상|이하|초과|미만|이내|넘는)?")
AGE_RE = re.compile(r"경과|노후|사용승인|준공\s*후|지난")


def to_number(m):
    v = float(m.group("num").replace(",", ""))
    if m.group("mul") == "만":
        v *= 10000
    elif m.group("mul") == "천":
        v *= 1000
    if m.group("unit") == "평":
        v = round(v * 3.3058, 2)
    return v


def number_forms(v):
    """수치가 글에 나올 수 있는 표기 (100000 → 100000, 100,000, 10만)"""
    n = int(v) if float(v) == int(v) else v
    forms = {str(n), f"{n:,}"}
    if isinstance(n, int) and n >= 10000 and n % 10000 == 0:
        forms.add(f"{n // 10000}만")
    if isinstance(n, int) and n >= 1000 and n % 1000 == 0 and n < 10000:
        forms.add(f"{n // 1000}천")
    return forms


def mentioned(text, v, unit_re):
    """text 에 수치 v 가 단위와 함께 나오는지 (팀원 AI 가 '배경 수치'로 뺀 것 찾기)"""
    for f in number_forms(v):
        if re.search(r"(?<![\d,.])" + re.escape(f) + r"\s*" + unit_re, text):
            return True
    return False


UNIT_RE = {"㎡": r"(제곱미터|㎡|m2|m²)", "층": "층", "세대": "세대", "호": "호", "년": "년", "m": r"(m|미터)"}


def parse_team_text(text, column):
    """팀원 AI 의 자유 글 한 칸에서 수치 기준을 뽑는다. 연도는 year 칸에서만 읽는다"""
    items = []
    if not text or text.strip() == "미기재":
        return items
    for seg in re.split(r"[;\n]|\.\s", text):
        for m in NUM_RE.finditer(seg):
            unit = m.group("unit")
            op = m.group("op1") or WORD_OP.get(m.group("op2") or "", "=")
            op = {"≥": ">=", "≤": "<="}.get(op, op)
            v = to_number(m)
            before = seg[:m.start()]
            if unit in ("제곱미터", "㎡", "m2", "m²", "평"):
                if "연면적" in before:
                    attr, sub = "연면적", ""
                elif "바닥면적" in before:
                    attr, sub = "기타", "바닥면적"
                elif "전용면적" in before:
                    attr, sub = "기타", "전용면적"
                else:
                    attr, sub = "기타", "면적(종류미상)"
                ukey = "㎡"
            elif unit == "층":
                attr, sub, ukey = "층수", "", "층"
            elif unit in ("세대", "호"):
                attr, sub, ukey = "기타", "세대수" if unit == "세대" else "호수", unit
            elif unit in ("m", "미터"):
                attr, sub, ukey = "기타", "높이", "m"
            else:  # 년
                if column != "year":
                    continue
                attr, sub = ("연도", "") if AGE_RE.search(seg) else ("기타", "기간")
                ukey = "년"
            it = mk(attr, op, v, sub, raw=seg.strip())
            it["ukey"] = ukey
            items.append(it)
    return items


def team_uses(text):
    # "대통령령으로 정하는 용도" 처럼 위임한 부분은 빼고 읽는다
    t = " ; ".join(x for x in re.split(r"[;；]", text) if not re.search(r"대통령령|시행령", x))
    codes = set()
    for pat, cs in USE_WORDS:
        if re.search(pat, t):
            codes.update(cs)
            t = re.sub(pat, " ", t)
    return sorted(codes)


def read_team(path):
    if path and os.path.exists(path):
        with open(path, encoding="utf-8-sig") as f:
            return list(csv.DictReader(f)), path
    try:
        raw = subprocess.run(["git", "-C", ROOT, "show", TEAM_REF], capture_output=True, check=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        print(f"팀원 AI 파일이 없습니다: {path} (git fetch origin 후 다시 실행하거나 --team 으로 경로 지정)")
        return [], None
    return list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig")))), TEAM_REF


def load_team(path):
    rows, used = read_team(path)
    out, names, excluded = {}, {}, {}
    for r in rows:
        no = r["BILL_NO"]
        names[no] = r["BILL_NAME"]
        excluded[no] = r.get("excluded", "")
        items = []
        use = (r.get("use") or "").strip()
        if use and use != "미기재":
            items.append(mk("용도", codes=team_uses(use), raw=use))
        for col in ("area", "floors", "year", "conditions"):
            for it in parse_team_text(r.get(col, ""), col):
                # 팀원 AI 가 excluded 칸에 '기준이 아니다'라고 적은 수치는 기준으로 세지 않는다
                if mentioned(excluded[no], it["value"], UNIT_RE[it.pop("ukey")]):
                    if col == "year":
                        it["attr"], it["sub"] = "기타", "기간"
                    else:
                        continue
                items.append(it)
        dl = (r.get("delegated") or "").strip()
        for it in items:
            it["src"] = "team"
            it["deleg"] = bool(re.search(r"대통령령|시행령|부령|위임", dl))
        # 같은 기준이 여러 칸에서 나오면 하나만
        uniq, seen = [], set()
        for it in items:
            k = (it["attr"], it["sub"], it["op"], it["value"], tuple(it["codes"] or []), it["raw"] if it["attr"] == "용도" else "")
            if k not in seen:
                seen.add(k)
                uniq.append(it)
        out[no] = uniq
    return out, names, excluded, used


# ---------------------------------------------------------------- D. 원문 정규식 (--docs)
DOC_SOURCE = ("doc", "원문 정규식")


def load_docs(docs_dir):
    """의안 원문의 개정 부분에서 server/lib/criteria.js 로 뽑은 규칙을 우리 AI 와 같은 꼴의 항목으로"""
    raw = subprocess.run(["node", os.path.join(ROOT, "server", "scripts", "compare-bill-docs.js"), "--rules", docs_dir],
                         capture_output=True, check=True).stdout
    out = {}
    for no, r in json.loads(raw.decode("utf-8")).items():
        items = []
        if r.get("용도"):
            items.append(mk("용도", codes=sorted(r["용도"])))
        for k in ("연면적", "층수"):
            for b, op in (("min", ">="), ("max", "<=")):
                if k in r and b in r[k]:
                    items.append(mk(k, op, float(r[k][b])))
        if "사용승인" in r:
            items.append(mk("연도", ">=", float(int(REF_DATE[:4]) - int(str(r["사용승인"]["before"])[:4]))))
        for it in items:
            it["src"] = "ours"  # 표기(사용승인 … 경과)를 우리 AI 와 같게
        out[no] = items
    return out


# ---------------------------------------------------------------- 비교
def legal_check(no, coded, comparable):
    """출처가 뽑은 용도가 법안 글의 시설 이름(별표1 분류)과 하나도 겹치지 않으면 그 출처 이름과 설명을 돌려준다"""
    text = SUMMARY.get(no, "")
    law = legal_codes(text)
    if not law:
        return [], ""
    bad = [s for s in comparable if not (coded[s] & set(law))]
    hint = ", ".join(f"{law[c][0]} → {USE_NAMES.get(c, c)}" for c in sorted(law))
    return bad, hint


def compare(no, attr, by_src, team_excluded):
    """by_src: {src: [items]} (그 기준 종류만). (status, note, matched_srcs) 를 돌려준다"""
    have = [s for s, _ in SOURCES if by_src.get(s)]
    notes = []
    if attr == "용도":
        coded = {s: set().union(*[set(it["codes"] or []) for it in by_src[s]]) for s in have}
        comparable = [s for s in have if coded[s]]
        for s in have:
            if not coded[s] and len(have) >= 2:
                notes.append(f"{dict(SOURCES)[s]} 용도는 글로만 있어 코드로 비교하지 못함")
        # 같은 답이 여러 출처에서 나와도 법령 분류와 다르면 걸러낸다
        bad, hint = legal_check(no, coded, comparable)
        if bad:
            names = "·".join(dict(SOURCES)[s] for s in bad)
            return ST_CHECK, notes + [f"법령 분류와 다름({names}). 법안 글: {hint}"], comparable
        if len(comparable) >= 2:
            common = set.intersection(*[coded[s] for s in comparable])
            if common:
                if any(coded[s] != common for s in comparable):
                    notes.append("용도 일부만 겹침")
                return ST_OK, notes, comparable
            return ST_CHECK, notes + ["용도가 겹치지 않음"], comparable
        if len(have) >= 2:
            return ST_CHECK, notes, have
        return ST_ONE, notes, have

    keys = {s: {(it["sub"], it["value"]) for it in by_src[s]} for s in have}
    for s in have:
        if any(it.get("deleg") for it in by_src[s]) and s == "rule":
            notes.append("규칙 기반 문장에 대통령령 위임")
    # 팀원 AI 가 배경 수치로 뺀 값
    if team_excluded and "rule" in have:
        for it in by_src["rule"]:
            if mentioned(team_excluded, it["value"], UNIT_RE.get(unit_of(it["attr"], it["sub"]) or "년", "")):
                notes.append(f"팀원 AI는 이 수치({item_text(it)})를 건물 기준으로 보지 않음")
                break
    if len(have) < 2:
        return ST_ONE, notes, have
    counter = Counter(k for s in have for k in keys[s])
    shared = {k for k, n in counter.items() if n >= 2}
    if not shared:
        return ST_CHECK, notes + ["출처마다 수치가 다름"], have
    matched = [s for s in have if keys[s] & shared]
    ops = {it["op"] for s in matched for it in by_src[s] if (it["sub"], it["value"]) in shared}
    if len(ops) > 1:
        notes.insert(0, "경계 표현 다름")
    extra = [dict(SOURCES)[s] for s in have if keys[s] - shared]
    if extra:
        notes.append("다른 수치도 있음(" + "·".join(extra) + ")")
    return ST_OK, notes, matched


def cell(items):
    seen, out = set(), []
    for it in items:
        t = item_text(it) + (f" ({it['ctx']})" if it.get("ctx") else "")
        if t not in seen:
            seen.add(t)
            out.append(t)
    return "; ".join(out)


def build(team_path, docs=None):
    ours, ours_info = load_ours()
    rule, rule_names = load_rule()
    team, team_names, team_excl, team_used = load_team(team_path)
    srcs = [("ours", ours), ("rule", rule), ("team", team)] + ([("doc", docs)] if docs is not None else [])
    with open(os.path.join(WEB, "bills.json"), encoding="utf-8") as f:
        bill_names = {b["no"]: b["name"] for b in json.load(f)["bills"]}
    nos = sorted(set(ours) | set(rule) | set(team) | set(docs or {}), key=lambda x: int(x), reverse=True)
    rows = []
    for no in nos:
        name = bill_names.get(no) or rule_names.get(no) or team_names.get(no, "")
        for attr in ATTRS:
            by_src = {s: [it for it in src.get(no, []) if it["attr"] == attr]
                      for s, src in srcs}
            if not any(by_src.values()):
                continue
            status, notes, _ = compare(no, attr, by_src, team_excl.get(no, ""))
            rows.append(OrderedDict([
                ("BILL_NO", no), ("BILL_NAME", name), ("ATTRIBUTE", attr),
                ("OURS", cell(by_src["ours"])), ("RULE_BASED", cell(by_src["rule"])), ("TEAM_AI", cell(by_src["team"])),
            ] + ([("DOC_REGEX", cell(by_src["doc"]))] if docs is not None else []) + [
                ("STATUS", status), ("NOTE", " / ".join(notes)),
            ]))
    return rows, ours, ours_info, rule, team, team_used


def write(rows, ours_info, team_used):
    path = os.path.join(DATA, "criteria_crosscheck.csv")
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"  data/criteria_crosscheck.csv: {len(rows)}행")

    bills = OrderedDict()
    for r in rows:
        b = bills.setdefault(r["BILL_NO"], {"name": r["BILL_NAME"], "demo": r["BILL_NO"] in ours_info, "items": []})
        b["items"].append({"attr": r["ATTRIBUTE"], "ours": r["OURS"], "rule": r["RULE_BASED"], "team": r["TEAM_AI"],
                           "status": r["STATUS"], "note": r["NOTE"]})
    out = {
        "sources": {"ours": "우리 AI 추출 (판정 시범 규칙)", "rule": "규칙 기반 (criteria_rule.csv)",
                    "team": "팀원 AI 추출 (ai_feature_extraction.csv, 미검토)"},
        "statuses": [ST_OK, ST_CHECK, ST_ONE],
        "summary": {s: sum(1 for r in rows if r["STATUS"] == s) for s in (ST_OK, ST_CHECK, ST_ONE)},
        "bills": bills,
    }
    p = os.path.join(WEB, "crosscheck.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  web/data/crosscheck.json: 법안 {len(bills)}건, {os.path.getsize(p) / 1024:,.1f} KB (팀원 AI: {team_used})")
    return bills


# ---------------------------------------------------------------- 노후 후보 (판정 시범에는 넣지 않음)
def before_date(years):
    return f"{int(REF_DATE[:4]) - int(years)}{REF_DATE[4:]}"


def candidates(ours, rule, team):
    with open(os.path.join(WEB, "buildings.geojson"), encoding="utf-8") as f:
        props = [ft["properties"] for ft in json.load(f)["features"]]
    cands = []
    for no, items in rule.items():
        for it in items:
            if it["attr"] != "연도":
                continue
            same = [x for x in items if x.get("sentence") == it["sentence"] and x is not it]
            cands.append(("규칙 기반", no, it, same, it["deleg"], it["ctx"]))
    for no, items in team.items():
        for it in items:
            if it["raw"] and re.search(r"\d+\s*년", it["raw"]) and it["attr"] in ("연도", "기타") and it["sub"] in ("", "기간"):
                cands.append(("팀원 AI", no, it, [], it["deleg"], ""))
    out = []
    for src, no, it, same, deleg, ctx in cands:
        rl = {"사용승인": {"before": before_date(it["value"])}}
        extra = []
        for x in same:
            if x["attr"] in ("연면적", "층수"):
                b = "min" if x["op"] in (">=", ">") else "max"
                rl.setdefault(x["attr"], {})[b] = x["value"]
                extra.append(item_text(x))
            else:
                extra.append(item_text(x) + "(건물 자료에 없어 판정에 못 씀)")
        if any(i["attr"] == "용도" for i in ours.get(no, [])):
            rl["용도"] = [c for i in ours[no] if i["attr"] == "용도" for c in i["codes"]]
            extra.append("용도 " + "·".join(USE_NAMES[c] for c in rl["용도"]) + "(우리 AI)")
        if deleg:
            rl["위임"] = ["대통령령"]
        cnt = Counter(judge(p, rl) for p in props)
        out.append({"src": src, "no": no, "years": int(it["value"]), "raw": it["raw"] or item_text(it), "ctx": ctx,
                    "before": rl["사용승인"]["before"], "extra": extra, "deleg": deleg,
                    "counts": {s: cnt.get(s, 0) for s in STATUSES}})
    out.sort(key=lambda c: (c["src"], c["no"]))
    print("\n| 출처 | 의안번호 | 기준 | 사용승인 기준일 | 함께 건 기준 | 대상 | 경계선 | 비대상 | 판정불가 | 비고 |")
    print("|---|---|---|---|---|---:|---:|---:|---:|---|")
    for c in out:
        k = c["counts"]
        note = ("대통령령 위임: 판정불가 후보" if c["deleg"] else "") + (f" {c['ctx']}" if c["ctx"] else "")
        print(f"| {c['src']} | {c['no']} | {c['raw']} | {c['before']} 이전 | {', '.join(c['extra']) or '-'} | "
              f"{k['대상']:,} | {k['경계선']:,} | {k['비대상']:,} | {k['판정불가']:,} | {note.strip() or '-'} |")
    return out


def main():
    ap = argparse.ArgumentParser(description="기준 교차 확인 (우리 AI · 규칙 기반 · 팀원 AI)")
    ap.add_argument("--team", default=os.path.join(DATA, "ai_feature_extraction.csv"), help="팀원 AI 추출 CSV 경로")
    ap.add_argument("--candidates", action="store_true", help="노후(경과연수) 후보 동수 표를 출력")
    ap.add_argument("--docs", help="의안 원문 글 폴더 (예: data/bill_docs). 주면 원문 정규식을 넷째 출처로 넣어 비교만 한다")
    a = ap.parse_args()

    if a.docs:
        return main_docs(a)

    print("기준 교차 확인")
    rows, ours, ours_info, rule, team, team_used = build(a.team)
    bills = write(rows, ours_info, team_used)

    st = Counter(r["STATUS"] for r in rows)
    print("\n판정별 행 수: " + ", ".join(f"{s} {st.get(s, 0)}" for s in (ST_OK, ST_CHECK, ST_ONE)))
    print(f"출처별 법안 수: 우리 AI {len(ours)}, 규칙 기반 {len(rule)}, 팀원 AI {len(team)}, 합집합 {len(bills)}")
    all_ok, partial = [], []
    for no in ours:
        its = [i for i in bills[no]["items"] if i["ours"]]
        if its and all(i["status"] == ST_OK for i in its):
            all_ok.append(no)
        elif any(i["status"] == ST_OK for i in its):
            partial.append(no)
    print(f"우리 AI 26건 중 기준 전부 교차 확인됨: {len(all_ok)}건 {all_ok}")
    print(f"일부만 교차 확인됨: {len(partial)}건 {partial}")
    print(f"기준이 위임뿐이라 비교할 수치·용도가 없음: {[no for no in ours if not ours[no]]}")
    for no in ours:
        for i in bills[no]["items"]:
            if i["ours"]:
                print(f"  [{no}] {i['attr']}: {i['status']}  우리={i['ours']} | 규칙={i['rule'] or '-'} | 팀원={i['team'] or '-'}"
                      + (f"  ({i['note']})" if i["note"] else ""))
    if a.candidates:
        candidates(ours, rule, team)


def main_docs(a):
    """원문 정규식 출처를 넣기 전후 판정 수 비교. 기본 출력(criteria_crosscheck.csv, crosscheck.json)은 건드리지 않는다"""
    print("기준 교차 확인 (+ 원문 정규식)")
    before, ours, *_ = build(a.team)
    docs = load_docs(os.path.abspath(a.docs))
    SOURCES.append(DOC_SOURCE)
    after, *_ = build(a.team, docs)
    path = os.path.join(DATA, "criteria_crosscheck_docs.csv")
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(after[0].keys()))
        w.writeheader()
        w.writerows(after)
    print(f"  data/criteria_crosscheck_docs.csv: {len(after)}행 (원문 있는 법안 {len(docs)}건)")

    def count(rows, nos=None):
        c = Counter(r["STATUS"] for r in rows if nos is None or r["BILL_NO"] in nos)
        return ", ".join(f"{s} {c.get(s, 0)}" for s in (ST_OK, ST_CHECK, ST_ONE))
    pilot = set(ours)
    print(f"\n판정 시범 26건 행: 전 [{count(before, pilot)}] → 후 [{count(after, pilot)}]")
    print(f"원문 있는 법안 {len(docs)}건 행: 전 [{count(before, set(docs))}] → 후 [{count(after, set(docs))}]")
    print(f"전체 행: 전 [{count(before)}] → 후 [{count(after)}]")
    old = {(r["BILL_NO"], r["ATTRIBUTE"]): r for r in before}
    print("\n바뀐 행 (판정 시범 26건):")
    for r in after:
        k = (r["BILL_NO"], r["ATTRIBUTE"])
        o = old.get(k)
        if r["BILL_NO"] in pilot and (not o or o["STATUS"] != r["STATUS"]):
            print(f"  [{k[0]}] {k[1]}: {o['STATUS'] if o else '(행 없음)'} → {r['STATUS']}  우리={r['OURS'] or '-'} | 규칙={r['RULE_BASED'] or '-'}"
                  f" | 팀원={r['TEAM_AI'] or '-'} | 원문={r['DOC_REGEX'] or '-'}" + (f"  ({r['NOTE']})" if r["NOTE"] else ""))
    print("\n바뀐 행 (추가 후보 법안):")
    for r in after:
        k = (r["BILL_NO"], r["ATTRIBUTE"])
        o = old.get(k)
        if r["BILL_NO"] in docs and r["BILL_NO"] not in pilot and (not o or o["STATUS"] != r["STATUS"]):
            print(f"  [{k[0]}] {k[1]}: {o['STATUS'] if o else '(행 없음)'} → {r['STATUS']}  규칙={r['RULE_BASED'] or '-'}"
                  f" | 팀원={r['TEAM_AI'] or '-'} | 원문={r['DOC_REGEX'] or '-'}" + (f"  ({r['NOTE']})" if r["NOTE"] else ""))


if __name__ == "__main__":
    main()
