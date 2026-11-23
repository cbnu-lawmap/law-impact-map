# -*- coding: utf-8 -*-
"""비슷한 법안 찾기 비교: 단어 유사도(TF-IDF) vs 의미 검색(임베딩)

질문: 어떤 법안의 "가장 비슷한 법안 3개" 안에 같은 법률을 고치는 다른 법안이 들어 있는가?
      (예: 건축법 일부개정법률안이면 이웃 3개 중에 다른 건축법 개정안이 있는가)
대상: 같은 법률의 법안이 2건 이상인 법안만 (혼자인 법률은 맞힐 답이 없음)
지표: 위 조건을 만족하는 법안의 비율 (top-3 적중률). top-1 적중률과 무작위로 3개를 고를 때의 기대값도 함께 적는다.

두 방법 모두 같은 글(제안이유 전문, 없으면 bills.json 요약)만 보고 법안명은 보지 않는다.
  - TF-IDF: web/tfidf.js 와 같은 방식 (sklearn TfidfVectorizer char_wb 2~3그램, sublinear tf, l2)
  - 임베딩: collect/embed_bills.py 의 paraphrase-multilingual-MiniLM-L12-v2 (--emb 로 저장 파일을 주거나 여기서 계산)

출력: docs/similar_compare.md (숫자는 이 스크립트가 쓴다. 손으로 고치지 말 것)

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
K = 3


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


def evaluate(S, laws, nos):
    cnt = Counter(laws)
    n = len(laws)
    idx = [i for i in range(n) if cnt[laws[i]] >= 2]
    hit3 = hit1 = 0
    rand = 0.0
    for i in idx:
        nb = neighbors(S, i, K)
        same = [laws[j] == laws[i] for j in nb]
        hit3 += any(same)
        hit1 += same[0]
        m = cnt[laws[i]] - 1  # 같은 법률의 다른 법안 수
        rand += 1 - comb(n - 1 - m, K) / comb(n - 1, K)
    return {"n": len(idx), "hit3": hit3 / len(idx), "hit1": hit1 / len(idx), "rand3": rand / len(idx), "hit3_count": hit3}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--emb", help="embed_bills.py --save 로 저장한 .npz")
    ap.add_argument("--tfidf-only", action="store_true")
    args = ap.parse_args()

    docs = load_docs()
    nos = [d[0] for d in docs]
    laws = [d[1] for d in docs]
    texts = [d[2] for d in docs]
    res = {"tfidf": evaluate(tfidf_matrix(texts), laws, nos)}

    if not args.tfidf_only:
        if args.emb:
            z = np.load(args.emb, allow_pickle=False)
            pos = {str(no): i for i, no in enumerate(z["nos"])}
            E = np.stack([z["emb"][pos[no]] for no in nos])
        else:
            E = embed(texts)
        E = E / np.linalg.norm(E, axis=1, keepdims=True)
        res["emb"] = evaluate(E @ E.T, laws, nos)

    for k, r in res.items():
        print(f"{k}: 대상 {r['n']}건, top-3 적중 {r['hit3']:.3f}, top-1 {r['hit1']:.3f}, 무작위 기대 top-3 {r['rand3']:.3f}")
    if args.tfidf_only:
        return

    multi = Counter(laws)
    n_laws = sum(1 for c in multi.values() if c >= 2)
    bills = json.loads((ROOT / "web" / "data" / "bills.json").read_text(encoding="utf-8"))["bills"]
    last = max(b["date"] for b in bills)
    t, e = res["tfidf"], res["emb"]
    better = "의미 검색(임베딩)" if e["hit3"] > t["hit3"] else "단어 유사도(TF-IDF)" if t["hit3"] > e["hit3"] else "두 방법이 같음"
    pct = lambda x: f"{x * 100:.1f}%"  # noqa: E731
    lines = [
        "# 비슷한 법안 찾기 비교: 단어 유사도(TF-IDF) vs 의미 검색(pgvector 임베딩)",
        "",
        "> 이 문서의 숫자는 `collect/compare_similar.py` 가 만든다 (GitHub Actions `embed-bills.yml`). 손으로 고치지 않는다.",
        "",
        "## 무엇을 쟀나",
        "",
        f"- 법안 {len(docs)}건 (계류 법안 목록, 마지막 제안일 {last}), 같은 법률을 고치는 법안이 2건 이상인 법률 {n_laws}개에 속한 법안 **{t['n']}건**이 평가 대상",
        f"- 법안마다 가장 비슷한 법안 {K}개를 고르고, 그 안에 **같은 법률의 다른 법안**이 있으면 적중",
        "- 두 방법 모두 제안이유 글만 보고 법안명(법률명)은 보지 않는다. 법률명은 정답을 매길 때만 쓴다",
        "- 단어 유사도: 글자 2~3개 묶음 TF-IDF + 코사인 (`web/tfidf.js`, 서버 대체 방법과 같은 계산)",
        f"- 의미 검색: `{MODEL}` 384차원 임베딩 + 코사인 (Supabase `similar_bills` 와 같은 순서). 이 모델은 글 앞부분 128토큰까지만 본다",
        "",
        "## 결과",
        "",
        "| 방법 | top-3 적중률 | top-1 적중률 |",
        "| :--- | ---: | ---: |",
        f"| 단어 유사도(TF-IDF) | {pct(t['hit3'])} ({t['hit3_count']}/{t['n']}) | {pct(t['hit1'])} |",
        f"| 의미 검색(임베딩) | {pct(e['hit3'])} ({e['hit3_count']}/{e['n']}) | {pct(e['hit1'])} |",
        f"| 무작위로 3개 고를 때 기대값 | {pct(t['rand3'])} | |",
        "",
        f"이 지표로는 **{better}** 쪽이 같은 법률의 법안을 더 잘 찾는다.",
        "",
        "## 읽을 때 주의",
        "",
        "- \"같은 법률\"은 비슷함의 한 가지 대리 지표일 뿐이다. 다른 법률이라도 내용이 비슷한 법안(예: 건축법과 건축물관리법의 같은 주제)은 오답으로 센다.",
        "- 같은 법률 개정안은 제안이유에 법률 특유의 낱말이 반복되므로 글자 단위 TF-IDF 에 유리할 수 있다. 의미 검색은 표현이 달라도 주제가 같은 법안을 찾는 데 강점이 있지만 이 지표에는 잘 드러나지 않는다.",
        "- 화면과 서버는 의미 검색을 먼저 쓰고, Supabase 키가 없거나 실패하면 단어 유사도로 대신한다. 어느 방법을 썼는지 화면에 표시한다.",
        "",
    ]
    OUT.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    print(f"{OUT.relative_to(ROOT)} 를 썼습니다")


if __name__ == "__main__":
    main()
