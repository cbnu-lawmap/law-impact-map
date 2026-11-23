# -*- coding: utf-8 -*-
"""법안 요약문 임베딩을 만들어 Supabase bill_embeddings 표(pgvector)에 넣는다.

입력 : web/data/summaries.json (제안이유 전문), web/data/bills.json (법안명, 전문이 없을 때 요약)
출력 : Supabase public.bill_embeddings (bill_no, law, embedding vector(384), model, text_hash)
       --save 경로를 주면 전체 임베딩을 .npz 로도 저장 (collect/compare_similar.py 가 읽음)

모델 : sentence-transformers paraphrase-multilingual-MiniLM-L12-v2 (384차원, 한국어 포함 다국어, API 키 불필요)
       글 앞부분 128토큰까지만 본다 (모델 최대 길이).

갱신 : 표에 이미 있는 법안 중 요약문 해시(text_hash)가 같은 것은 건너뛰고, 새 법안·바뀐 법안만 넣는다.
       --all 이면 전부 다시 넣는다. text_hash 열이 없는 DB(마이그레이션 002 전)는 "표에 없는 법안만" 넣는다.

환경변수 (GitHub Actions secrets 에만 둔다. 값은 출력하지 않는다)
    SUPABASE_URL               없으면 시연 프로젝트 주소를 쓴다
    SUPABASE_SERVICE_ROLE_KEY  없으면 DB 에 넣지 않고 끝낸다 (--save 는 그대로 한다)

사용법 (저장소 맨 위 폴더에서):
    python collect/embed_bills.py            # 새·바뀐 법안만
    python collect/embed_bills.py --all      # 전부 다시
    python collect/embed_bills.py --save /tmp/emb.npz --no-upload
"""
import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

import requests

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web" / "data"
MODEL = "paraphrase-multilingual-MiniLM-L12-v2"
DIM = 384
DEFAULT_URL = "https://bfwgwdcfdydwyiysrflm.supabase.co"
BATCH = 100


def law_of(name):
    """web/tfidf.js 의 lawOf 와 같은 규칙: 개정·폐지안은 고치는 법률 이름, 제정안은 끝의 '안'만 뗀다."""
    s = re.sub(r"\s*\([^)]*\)\s*$", "", str(name or "").strip())
    m = re.match(r"^(.*?)\s*(일부개정|전부개정|폐지)법률안$", s)
    if m:
        return m.group(1).strip()
    return re.sub(r"안$", "", s).strip()


def load_docs():
    """[(bill_no, law, text)] 법안 목록 순서대로. 텍스트는 전문, 없으면 bills.json 요약."""
    bills = json.loads((WEB / "bills.json").read_text(encoding="utf-8"))["bills"]
    full = {}
    p = WEB / "summaries.json"
    if p.exists():
        full = json.loads(p.read_text(encoding="utf-8")).get("summaries", {})
    out = []
    for b in bills:
        text = (full.get(b["no"]) or b.get("summary") or "").strip()
        if text:
            out.append((b["no"], law_of(b["name"]), text))
    return out


def count_full(docs):
    """제안이유 전문(summaries.json)으로 만든 법안 수"""
    p = WEB / "summaries.json"
    full = json.loads(p.read_text(encoding="utf-8")).get("summaries", {}) if p.exists() else {}
    return sum(1 for no, _, _ in docs if (full.get(no) or "").strip())


def text_hash(text):
    return hashlib.sha256((MODEL + "\n" + text).encode("utf-8")).hexdigest()


def embed(texts):
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(MODEL)
    vecs = model.encode(texts, batch_size=32, show_progress_bar=False, normalize_embeddings=True, convert_to_numpy=True)
    assert vecs.shape[1] == DIM, vecs.shape
    return vecs


class Rest:
    def __init__(self, url, key):
        self.base = url.rstrip("/") + "/rest/v1/"
        self.h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}

    def existing(self):
        """{bill_no: text_hash 또는 None}. text_hash 열이 없으면 bill_no 만 읽는다."""
        for cols in ("bill_no,text_hash", "bill_no"):
            out, start, ok = {}, 0, True
            while True:
                r = requests.get(self.base + "bill_embeddings", params={"select": cols, "order": "bill_no"},
                                 headers=dict(self.h, Range=f"{start}-{start + 999}"), timeout=30)
                if r.status_code >= 400:
                    ok = False
                    break
                rows = r.json()
                for x in rows:
                    out[x["bill_no"]] = x.get("text_hash")
                if len(rows) < 1000:
                    break
                start += 1000
            if ok:
                return out, cols.endswith("text_hash")
        raise RuntimeError("bill_embeddings 를 읽지 못했습니다 (HTTP %s)" % r.status_code)

    def upsert(self, rows):
        r = requests.post(self.base + "bill_embeddings", params={"on_conflict": "bill_no"}, data=json.dumps(rows),
                          headers=dict(self.h, Prefer="resolution=merge-duplicates,return=minimal"), timeout=60)
        if r.status_code >= 400:
            # 응답 본문에는 키가 없지만 길이를 잘라 남긴다
            raise RuntimeError("넣기 실패 HTTP %s: %s" % (r.status_code, r.text[:200]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="이미 있는 법안도 다시 넣기")
    ap.add_argument("--save", help="전체 임베딩을 저장할 .npz 경로 (비교용)")
    ap.add_argument("--no-upload", action="store_true", help="DB 에 넣지 않기")
    args = ap.parse_args()

    docs = load_docs()
    print(f"법안 {len(docs)}건 (요약문 있는 것), 그중 제안이유 전문이 없어 300자 요약을 쓴 법안 {len(docs) - count_full(docs)}건")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    url = os.environ.get("SUPABASE_URL", "").strip() or DEFAULT_URL
    upload = not args.no_upload
    if upload and not key:
        print("SUPABASE_SERVICE_ROLE_KEY 가 없어 DB 에 넣지 않습니다")
        upload = False

    todo = list(range(len(docs)))
    rest = None
    has_hash = False
    if upload:
        rest = Rest(url, key)
        have, has_hash = rest.existing()
        if not args.all:
            # 표에 없는 법안 + 해시가 다른 법안 (예: 전문이 없어 300자 요약으로 넣었다가 summaries.json 에 전문이 생긴 법안)
            todo = [i for i, (no, _, t) in enumerate(docs)
                    if no not in have or (has_hash and have[no] != text_hash(t))]
        changed = sum(1 for i in todo if docs[i][0] in have)
        print(f"DB 에 있는 법안 {len(have)}건, 넣을 법안 {len(todo)}건 (새 법안 {len(todo) - changed}, 글이 바뀐 법안 {changed})"
              + ("" if has_hash else " (text_hash 열 없음: 없는 법안만)"))

    need = range(len(docs)) if args.save else todo
    if not need:
        print("새로 넣을 법안이 없습니다")
        return
    import numpy as np

    vecs = embed([docs[i][2] for i in need])
    vec_of = {i: vecs[j] for j, i in enumerate(need)}

    if args.save:
        np.savez_compressed(args.save, nos=np.array([d[0] for d in docs]), laws=np.array([d[1] for d in docs]),
                            emb=np.stack([vec_of[i] for i in range(len(docs))]).astype("float32"), model=MODEL)
        print(f"임베딩 저장: {args.save}")

    if upload and todo:
        from datetime import datetime, timezone

        now = datetime.now(timezone.utc).isoformat()
        rows = []
        for i in todo:
            no, law, text = docs[i]
            row = {"bill_no": no, "law": law, "model": MODEL, "updated_at": now,
                   "embedding": "[" + ",".join("%.6f" % x for x in vec_of[i]) + "]"}
            if has_hash:
                row["text_hash"] = text_hash(text)
            rows.append(row)
        for s in range(0, len(rows), BATCH):
            rest.upsert(rows[s:s + BATCH])
        print(f"{len(rows)}건 넣음")


if __name__ == "__main__":
    main()
