# -*- coding: utf-8 -*-
"""새로 들어온 법안만 분야를 자동으로 붙인다 (매일 수집용, 외부 패키지 없음).

입력 : data/bills_summary.csv   (대상 법안 목록)
       data/bills_field_pred.csv (이미 분류한 법안, 노트북 결과)
       data/labels_300.csv       (사람이 붙인 분야 300건, 학습용)
출력 : data/bills_field_pred.csv 맨 끝에 새 법안 줄만 덧붙인다. 이미 있는 줄은 건드리지 않는다.

방법: 법안 이름과 제안이유를 글자 2개씩 끊어(바이그램) 나이브 베이즈로 분야를 고른다.
노트북 모델보다 약하므로 확신도(CONF)를 0.5 이하, 그리고 화면 기준값보다 낮게 적는다.
그러면 화면에 "분류 확인 필요"가 뜬다 (기준값은 field_classifier.json 의 review_threshold,
build_web_data.py 가 bills.json 의 review_threshold 로 옮겨 web/admin.js·web/app.js 가 읽는다).

사용법 (저장소 맨 위 폴더에서):
    python collect/classify_new_bills.py
"""
import csv
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SUMMARY = DATA / "bills_summary.csv"
PRED = DATA / "bills_field_pred.csv"
LABELS = DATA / "labels_300.csv"

FIELD_NAMES = {
    1: "소방·화재", 2: "재난·안전관리", 3: "건축물 안전·노후·유지관리",
    4: "주택 공급·임대·금융", 5: "공동주택 관리·주거환경", 6: "정비사업·도시재생",
    7: "도시계획·건축규제", 8: "주차·보행·교통", 9: "건설산업·기술·기타",
}
MODEL = ROOT / "web" / "data" / "models" / "field_classifier.json"


def conf_cap():
    """자동 분류 확신도 상한: 0.5, 그리고 화면의 "분류 확인 필요" 기준값(review_threshold)보다 0.01 낮게.
    그래서 이 임시 분류기가 붙인 법안은 기준값이 바뀌어도 늘 "분류 확인 필요"로 보인다."""
    review = 0.6
    try:
        import json
        with open(MODEL, encoding="utf-8") as f:
            review = float(json.load(f).get("review_threshold", review))
    except (OSError, ValueError):
        pass
    return round(min(0.5, review - 0.01), 2)


CONF_CAP = conf_cap()   # 자동 분류 확신도 상한 (화면 기준값보다 낮게)
NAME_WEIGHT = 3     # 법안 이름은 짧지만 분야를 잘 드러내므로 세 번 센다
TEXT_LEN = 600      # 제안이유는 앞부분만 쓴다


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def tokens(name, summary):
    def grams(s):
        s = re.sub(r"[^가-힣A-Za-z0-9]+", " ", s or "")
        out = []
        for w in s.split():
            out += [w[i:i + 2] for i in range(len(w) - 1)] or [w]
        return out
    name = re.sub(r"\s*(일부|전부)개정법률안|\s*폐지법률안|법률안", "", name or "")
    summary = re.sub(r"^\s*제안이유(\s*및\s*주요내용)?", "", summary or "")[:TEXT_LEN]
    return grams(name) * NAME_WEIGHT + grams(summary)


class NaiveBayes:
    def __init__(self, docs):
        """docs: [(분야 번호, 토큰 목록)]"""
        self.prior = Counter(y for y, _ in docs)
        self.n = len(docs)
        self.cnt = defaultdict(Counter)
        for y, toks in docs:
            self.cnt[y].update(toks)
        self.vocab = {t for c in self.cnt.values() for t in c}
        self.total = {y: sum(c.values()) for y, c in self.cnt.items()}

    def predict(self, toks):
        V = len(self.vocab)
        score = {}
        for y in self.prior:
            s = math.log(self.prior[y] / self.n)
            for t in toks:
                if t in self.vocab:
                    s += math.log((self.cnt[y][t] + 1) / (self.total[y] + V))
            score[y] = s
        m = max(score.values())
        z = sum(math.exp(v - m) for v in score.values())
        best = max(score, key=score.get)
        return best, math.exp(score[best] - m) / z


def train():
    docs = [(int(r["LABEL"]), tokens(r["BILL_NAME"], r["SUMMARY"]))
            for r in read_csv(LABELS)
            if r.get("LABEL", "").strip() and r.get("EXCLUDE", "N") != "Y"]
    return NaiveBayes(docs)


def main():
    with open(PRED, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        header = reader.fieldnames
        done = {r["BILL_NO"] for r in reader}
    new = [r for r in read_csv(SUMMARY) if r["BILL_NO"] not in done]
    if not new:
        print("새로 분류할 법안 없음")
        return

    model = train()
    rows = []
    for r in new:
        field, p = model.predict(tokens(r["BILL_NAME"], r["SUMMARY"]))
        rows.append({
            "BILL_NO": r["BILL_NO"], "BILL_NAME": r["BILL_NAME"],
            "FIELD_PRED": field, "FIELD_NAME": FIELD_NAMES[field],
            "CONF": round(min(p, 1.0) * CONF_CAP, 3), "FIELD_LABEL": "",
        })

    # 덧붙이기만 한다 (기존 줄은 바이트 그대로)
    with open(PRED, "rb") as f:
        raw = f.read()
    eol = "\r\n" if b"\r\n" in raw else "\n"   # 파일이 쓰던 줄바꿈을 따른다
    with open(PRED, "a", encoding="utf-8", newline="") as f:
        if raw and not raw.endswith(b"\n"):
            f.write(eol)
        w = csv.DictWriter(f, fieldnames=header, lineterminator=eol, extrasaction="ignore")
        w.writerows(rows)
    print(f"새 법안 {len(rows)}건 자동 분류 (확신도 {CONF_CAP} 이하, 화면에 '분류 확인 필요' 표시)")
    for r in rows[:10]:
        print(f"  {r['BILL_NO']} {r['FIELD_NAME']} ({r['CONF']}) {r['BILL_NAME']}")


if __name__ == "__main__":
    main()
