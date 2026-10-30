# -*- coding: utf-8 -*-
"""
청주 시범 동의 건물통합정보(브이월드 WFS lt_c_bldginfo)를 '전체 속성'으로 받아
data/ 에 CSV(속성) + GeoJSON(도형)으로 저장한다.

사각119 scripts/fetch_buildings.py 를 바탕으로 수정:
  - 높이·층수만 남기던 것을 모든 속성 유지로 변경 (PNU, 용도, 사용승인일, 구조 등 확인용)
  - 대상: data/cheongju_emd.geojson 의 동 경계 bbox
  - 브이월드는 bbox당 2,000건까지만 넘겨주므로, 넘으면 bbox를 4등분해서 다시 받음
  - ufid 기준 중복 제거 후 동 경계 안(건물 중심점 기준) 건물만 저장
  - bld_nm(건물명)은 개인 이름이 섞여 있어 저장하지 않음

사용법 (law-impact-map 폴더에서):
  python collect/fetch_cheongju_buildings.py
  python collect/fetch_cheongju_buildings.py --emd 사창동 "성화·개신·죽림동"

인증키: 환경변수 VWORLD_KEY → law-impact-map/.env 의 VWORLD_KEY
        → 바탕화면 sagak119/.env.local 의 NEXT_PUBLIC_VWORLD_KEY 순서로 찾는다.
브이월드는 Referer 헤더로 등록 도메인을 검사한다 (기본 http://localhost:3400).
"""
import argparse
import csv
import io
import json
import os
import sys
import urllib.parse
import urllib.request

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")
EMD = os.path.join(DATA, "cheongju_emd.geojson")

ENDPOINT = "https://api.vworld.kr/req/wfs"
TYPENAME = "lt_c_bldginfo"
REFERER = os.environ.get("VWORLD_REFERER", "http://localhost:3400")
PAGE = 1000
MAX_START = 1000  # 브이월드 STARTINDEX 상한 (2000부터는 오류)
DROP = {"bld_nm"}  # 개인 식별 정보가 섞인 필드


def read_env(path, name):
    if os.path.exists(path):
        for line in io.open(path, encoding="utf-8"):
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip()
    return None


def vworld_key():
    k = os.environ.get("VWORLD_KEY")
    k = k or read_env(os.path.join(ROOT, ".env"), "VWORLD_KEY")
    k = k or read_env(os.path.join(os.path.dirname(ROOT), "sagak119", ".env.local"), "NEXT_PUBLIC_VWORLD_KEY")
    if not k:
        raise SystemExit("브이월드 키가 없습니다. law-impact-map/.env 에 VWORLD_KEY=... 를 넣으세요.")
    return k


def bbox_of(geom):
    xs, ys = [], []
    def walk(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0]); ys.append(c[1])
        else:
            for s in c:
                walk(s)
    walk(geom["coordinates"])
    return min(xs), min(ys), max(xs), max(ys)


def get_page(bbox, key, start):
    params = {
        "SERVICE": "WFS", "REQUEST": "GetFeature", "VERSION": "2.0.0",
        "TYPENAME": TYPENAME, "OUTPUT": "application/json", "SRSNAME": "EPSG:4326",
        "BBOX": "%f,%f,%f,%f" % bbox, "COUNT": str(PAGE), "STARTINDEX": str(start), "KEY": key,
    }
    url = ENDPOINT + "?" + urllib.parse.urlencode(params, safe=",:")
    req = urllib.request.Request(url, headers={"Referer": REFERER})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read().decode("utf-8", "replace")
    if not raw.lstrip().startswith("{"):
        raise SystemExit("WFS 오류 응답:\n" + raw[:500])
    return json.loads(raw)


def fetch(bbox, key):
    first = get_page(bbox, key, 0)
    total = first.get("numberMatched")
    if isinstance(total, int) and total > MAX_START + PAGE:
        x0, y0, x1, y1 = bbox
        xm, ym = (x0 + x1) / 2, (y0 + y1) / 2
        out = []
        for b in ((x0, y0, xm, ym), (xm, y0, x1, ym), (x0, ym, xm, y1), (xm, ym, x1, y1)):
            out.extend(fetch(b, key))
        return out
    out = first.get("features") or []
    chunk, start = out, PAGE
    while len(chunk) == PAGE and start <= MAX_START:
        chunk = get_page(bbox, key, start).get("features") or []
        out.extend(chunk)
        start += PAGE
    return out


def centroid(geom):
    x0, y0, x1, y1 = bbox_of(geom)
    return round((x0 + x1) / 2, 6), round((y0 + y1) / 2, 6)


def inside(pt, geom):
    polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
    x, y = pt
    for poly in polys:
        hit = False
        for ring in poly:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
                if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                    hit = not hit
        if hit:
            return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--emd", nargs="*", default=["사창동"])
    args = ap.parse_args()
    key = vworld_key()

    emds = json.load(io.open(EMD, encoding="utf-8"))["features"]
    targets = [f for f in emds if f["properties"]["emd"] in args.emd]
    if not targets:
        raise SystemExit("동 이름을 찾지 못했습니다: %s" % args.emd)

    feats, seen = [], set()
    for t in targets:
        name = t["properties"]["emd"]
        got = fetch(bbox_of(t["geometry"]), key)
        kept = 0
        for f in got:
            p = f.setdefault("properties", {})
            if p.get("ufid") in seen or not f.get("geometry") or not inside(centroid(f["geometry"]), t["geometry"]):
                continue
            seen.add(p.get("ufid"))
            for k in DROP:
                p.pop(k, None)
            p["_emd"] = name
            feats.append(f)
            kept += 1
        print("%s: bbox %d건 → 동 경계 안 %d건" % (name, len(got), kept))

    if not feats:
        raise SystemExit("받은 건물이 없습니다.")

    os.makedirs(DATA, exist_ok=True)
    tag = "_".join(args.emd).replace("·", "")
    gj = os.path.join(DATA, "bldginfo_%s.geojson" % tag)
    with io.open(gj, "w", encoding="utf-8") as fp:
        json.dump({"type": "FeatureCollection", "source": "브이월드 WFS lt_c_bldginfo", "features": feats},
                  fp, ensure_ascii=False, separators=(",", ":"))

    cols = []
    for f in feats:
        for k in f["properties"]:
            if k not in cols:
                cols.append(k)
    cv = os.path.join(DATA, "bldginfo_%s.csv" % tag)
    with io.open(cv, "w", encoding="utf-8-sig", newline="") as fp:
        w = csv.writer(fp)
        w.writerow(cols + ["lon", "lat"])
        for f in feats:
            lon, lat = centroid(f["geometry"]) if f.get("geometry") else ("", "")
            w.writerow([f["properties"].get(c, "") for c in cols] + [lon, lat])

    print("\n[필드 목록과 채워진 비율]")
    n = len(feats)
    for c in cols:
        filled = sum(1 for f in feats if f["properties"].get(c) not in (None, "", " "))
        ex = next((f["properties"][c] for f in feats if f["properties"].get(c) not in (None, "", " ")), "")
        print("  %-20s %5.1f%%   예: %s" % (c, filled * 100.0 / n, str(ex)[:40]))
    print("\n저장: %s\n저장: %s" % (cv, gj))


if __name__ == "__main__":
    main()
