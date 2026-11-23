# -*- coding: utf-8 -*-
"""비슷한 법안 찾기 비교: 단어 유사도(TF-IDF) vs 의미 검색(임베딩) vs 둘의 결합(RRF)

질문: 어떤 법안의 "가장 비슷한 법안 3개" 안에 같은 법률을 고치는 다른 법안이 들어 있는가?
      (예: 건축법 일부개정법률안이면 이웃 3개 중에 다른 건축법 개정안이 있는가)
대상: 같은 법률의 법안이 2건 이상인 법안만 (혼자인 법률은 맞힐 답이 없음)
지표: 위 조건을 만족하는 법안의 비율 (top-3 적중률). top-1 적중률과 무작위로 3개를 고를 때의 기대값도 함께 적는다.

두 방법 모두 같은 글(제안이유 전문, 없으면 bills.json 요약)만 보고 법안명은 보지 않는다.
  - TF-IDF: web/tfidf.js 와 같은 방식 (sklearn TfidfVectorizer char_wb 2~3그램, sublinear tf, l2)
  - 임베딩: collect/embed_bills.py 의 paraphrase-multilingual-MiniLM-L12-v2 (--emb 로 저장 파일을 주거나 여기서 계산)
  - 결합: TF-IDF 상위 20 과 임베딩 상위 20 을 reciprocal rank fusion 으로 합침 (점수 = Σ 1/(60 + 순위)).
          server/lib/similar.js 의 hybrid 와 같은 계산 (RRF_K, POOL 이 같아야 함)

정하기 (손이 아니라 코드로): 결합 top-3 적중률 ≥ TF-IDF top-3 적중률 이면 hybrid, 아니면 tfidf 를 기본 방법으로 쓴다.

출력: docs/similar_compare.md (숫자는 이 스크립트가 쓴다. 손으로 고치지 말 것)
      web/data/similar_method.json (서버 server/lib/similar.js 가 읽는 기본 방법과 숫자)

사용법 (저장소 맨 위 폴더에서):
    python collect/compare_similar.py --emb /tmp/emb.npz   # embed_bills.py --save 결과 사용
    python collect/compare_similar.py                      # sentence-transformers 가 있으면 여기서 계산
    python collect/compare_similar.py --tfidf-only         # 임베딩 없이 TF-IDF 만 (확인용, 문서는 쓰지 않음)
"""
import argparse
import json
import sys
from collections import Counter
from math import comb
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from embed_bills import MODEL, embed, load_docs  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "similar_compare.md"
METHOD_OUT = ROOT / "web" / "data" / "similar_method.json"
K = 3
RRF_K = 60   # server/lib/similar.js RRF_K
POOL = 20    # server/lib/similar.js POOL (두 방법에서 각각 가져오는 후보 수)


def tfidf_matrix(texts):
    from sklearn.feature_extraction.text import TfidfVectorizer

    v = TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 3), lowercase=True, sublinear_tf=True, norm="l2", smooth_idf=True)
    X = v.fit_transform(texts)
    return (X @ X.T).toarray()


def neighbors(S, i, k):
    """자기 자신을 뺀 상위 k (점수 내림차순, 같으면 앞 번호). web/tfidf.js neighbors 와 같은 순서."""
    s = S[i].copy()
    s[i] = -np.inf
    order = sorted(range(len(s)), key=lambda j: (-s[j], j))
    return order[:k]


def rrf(lists, nos, k=RRF_K):
    """순위 목록(앞이 1위) 여럿을 합친 순서. 점수 = Σ 1/(k + 순위), 같으면 의안번호 순 (server/lib/similar.js rrf 와 같음)"""
    score = {}
    for lst in lists:
        for r, j in enumerate(lst, 1):
            score[j] = score.get(j, 0.0) + 1.0 / (k + r)
    return sorted(score, key=lambda j: (-score[j], nos[j]))


def evaluate(S, laws, nos, rank=None):
    """rank(i, k) 가 있으면 그 순서로, 없으면 S 의 이웃 순서로 평가"""
    cnt = Counter(laws)
    n = len(laws)
    idx = [i for i in range(n) if cnt[laws[i]] >= 2]
    hit3 = hit1 = 0
    rand = 0.0
    for i in idx:
        nb = rank(i, K) if rank else neighbors(S, i, K)
        same = [laws[j] == laws[i] for j in nb]
        hit3 += any(same)
        hit1 += same[0]
        m = cnt[laws[i]] - 1  # 같은 법률의 다른 법안 수
        rand += 1 - comb(n - 1 - m, K) / comb(n - 1, K)
    return {"n": len(idx), "hit3": hit3 / len(idx), "hit1": hit1 / len(idx), "rand3": rand / len(idx), "hit3_count": hit3}


def decide(res):
    """기본 방법을 코드로 정한다: 결합 top-3 ≥ TF-IDF top-3 이면 hybrid, 아니면 tfidf"""
    return "hybrid" if res["hybrid"]["hit3"] >= res["tfidf"]["hit3"] else "tfidf"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--emb", help="embed_bills.py --save 로 저장한 .npz")
    ap.add_argument("--tfidf-only", action="store_true")
    args = ap.parse_args()

    docs = load_docs()
    nos = [d[0] for d in docs]
    laws = [d[1] for d in docs]
    texts = [d[2] for d in docs]
    T = tfidf_matrix(texts)
    res = {"tfidf": evaluate(T, laws, nos)}

    if not args.tfidf_only:
        if args.emb:
            z = np.load(args.emb, allow_pickle=False)
            pos = {str(no): i for i, no in enumerate(z["nos"])}
            E = np.stack([z["emb"][pos[no]] for no in nos])
        else:
            E = embed(texts)
        E = E / np.linalg.norm(E, axis=1, keepdims=True)
        ES = E @ E.T
        res["emb"] = evaluate(ES, laws, nos)
        res["hybrid"] = evaluate(None, laws, nos, rank=lambda i, k: rrf([neighbors(T, i, POOL), neighbors(ES, i, POOL)], nos)[:k])

    for k, r in res.items():
        print(f"{k}: 대상 {r['n']}건, top-3 적중 {r['hit3']:.3f}, top-1 {r['hit1']:.3f}, 무작위 기대 top-3 {r['rand3']:.3f}")
    if args.tfidf_only:
        return

    multi = Counter(laws)
    n_laws = sum(1 for c in multi.values() if c >= 2)
    bills = json.loads((ROOT / "web" / "data" / "bills.json").read_text(encoding="utf-8"))["bills"]
    last = max(b["date"] for b in bills)
    t, e, h = res["tfidf"], res["emb"], res["hybrid"]
    method = decide(res)
    print(f"기본 방법: {method} (결합 top-3 {h['hit3']:.3f} {'≥' if method == 'hybrid' else '<'} TF-IDF top-3 {t['hit3']:.3f})")
    pct = lambda x: f"{x * 100:.1f}%"  # noqa: E731
    name = {"tfidf": "단어 유사도(TF-IDF)", "hybrid": "단어 + 의미 결합(RRF)"}
    best3 = max(res, key=lambda k: (res[k]["hit3"], k == "tfidf"))
    best_name = {"tfidf": "단어 유사도(TF-IDF)", "emb": "의미 검색(임베딩)", "hybrid": "단어 + 의미 결합(RRF)"}[best3]
    lines = [
        "# 비슷한 법안 찾기 비교: 단어 유사도(TF-IDF) vs 의미 검색(pgvector 임베딩) vs 결합(RRF)",
        "",
        "> 이 문서의 숫자는 `collect/compare_similar.py` 가 만든다 (GitHub Actions `embed-bills.yml`). 손으로 고치지 않는다.",
        "",
        "## 무엇을 쟀나",
        "",
        f"- 법안 {len(docs)}건 (계류 법안 목록, 마지막 제안일 {last}), 같은 법률을 고치는 법안이 2건 이상인 법률 {n_laws}개에 속한 법안 **{t['n']}건**이 평가 대상",
        f"- 법안마다 가장 비슷한 법안 {K}개를 고르고, 그 안에 **같은 법률의 다른 법안**이 있으면 적중",
        "- 세 방법 모두 제안이유 글만 보고 법안명(법률명)은 보지 않는다. 법률명은 정답을 매길 때만 쓴다",
        "- 단어 유사도: 글자 2~3개 묶음 TF-IDF + 코사인 (`web/tfidf.js`, 서버와 같은 계산)",
        f"- 의미 검색: `{MODEL}` 384차원 임베딩 + 코사인 (Supabase `similar_bills` 와 같은 순서). 이 모델은 글 앞부분 128토큰까지만 본다",
        f"- 결합(RRF): TF-IDF 상위 {POOL}개와 임베딩 상위 {POOL}개의 순위를 reciprocal rank fusion 으로 합친다. 점수 = Σ 1/({RRF_K} + 순위) (`server/lib/similar.js` hybrid 와 같은 계산)",
        "",
        "## 결과",
        "",
        "| 방법 | top-3 적중률 | top-1 적중률 |",
        "| :--- | ---: | ---: |",
        f"| 단어 유사도(TF-IDF) | {pct(t['hit3'])} ({t['hit3_count']}/{t['n']}) | {pct(t['hit1'])} |",
        f"| 의미 검색(pgvector 임베딩) | {pct(e['hit3'])} ({e['hit3_count']}/{e['n']}) | {pct(e['hit1'])} |",
        f"| 단어 + 의미 결합(RRF) | {pct(h['hit3'])} ({h['hit3_count']}/{h['n']}) | {pct(h['hit1'])} |",
        f"| 무작위로 3개 고를 때 기대값 | {pct(t['rand3'])} | |",
        "",
        f"top-3 적중률이 가장 높은 방법: **{best_name}**.",
        "",
        "## 서버가 쓰는 방법 (코드로 정함)",
        "",
        "규칙: 결합 top-3 적중률 ≥ TF-IDF top-3 적중률 이면 결합(hybrid), 아니면 단어 유사도(tfidf).",
        f"이번 측정: 결합 {pct(h['hit3'])} {'≥' if method == 'hybrid' else '<'} TF-IDF {pct(t['hit3'])} → **{name[method]}** (`web/data/similar_method.json` 의 method = `{method}`).",
        "",
        "- 비슷한 법안(`/api/similar`)과 Agentic RAG 의 비슷한 법안 규칙(`similar_rules`)이 이 방법을 따른다. 환경변수 `SIMILAR_METHOD` 로 바꿀 수 있다.",
        "- 결합으로 정해져도 Supabase 키가 없거나 pgvector 가 실패하면 단어 유사도로 대신하고, 어느 방법을 썼는지 화면에 표시한다.",
        "",
        "## 읽을 때 주의",
        "",
        "- \"같은 법률\"은 비슷함의 한 가지 대리 지표일 뿐이다. 다른 법률이라도 내용이 비슷한 법안(예: 건축법과 건축물관리법의 같은 주제)은 오답으로 센다.",
        "- 같은 법률 개정안은 제안이유에 법률 특유의 낱말이 반복되므로 글자 단위 TF-IDF 에 유리할 수 있다. 의미 검색은 표현이 달라도 주제가 같은 법안을 찾는 데 강점이 있지만 이 지표에는 잘 드러나지 않는다.",
        "",
    ]
    OUT.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    r3 = lambda r: {"top3": round(r["hit3"], 4), "top1": round(r["hit1"], 4), "top3_count": r["hit3_count"]}  # noqa: E731
    meta = {
        "note": "collect/compare_similar.py 가 쓴다 (손으로 고치지 말 것). server/lib/similar.js 가 method 를 기본 방법으로 읽는다",
        "method": method,
        "rule": "hybrid top3 >= tfidf top3 → hybrid, 아니면 tfidf",
        "rrf_k": RRF_K, "pool": POOL, "bills": len(docs), "evaluated": t["n"], "last_propose_date": last, "model": MODEL,
        "tfidf": r3(t), "emb": r3(e), "hybrid": r3(h), "random_top3": round(t["rand3"], 4),
    }
    METHOD_OUT.write_text(json.dumps(meta, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"{OUT.relative_to(ROOT)}, {METHOD_OUT.relative_to(ROOT)} 를 썼습니다")


if __name__ == "__main__":
    main()
