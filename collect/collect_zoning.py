# -*- coding: utf-8 -*-
"""사창동 건물에 용도지역 붙이기 (브이월드 2D 데이터 API)

건물마다 부르지 않고, 사창동 건물 범위(bbox) 하나로 용도지역 도형을 몇 번만 받아
건물 중심점이 어느 도형 안에 있는지 여기서 계산한다.

받는 레이어
  LT_C_UQ111 도시지역 용도지역 (주거·상업·공업·녹지)
  LT_C_UQ112 관리지역, LT_C_UQ113 농림지역, LT_C_UQ114 자연환경보전지역
  LT_C_UD801 개발제한구역, LT_C_UPISUQ161 지구단위계획구역 (있으면 '기타구역' 칸에 적음)

키는 GitHub Secret VWORLD_KEY 로만 쓴다. 키가 없으면 아무것도 하지 않고 끝난다.
브이월드는 키를 등록한 도메인을 domain 파라미터와 Referer 로 확인한다.
주소와 예외 글에는 키가 들어 있으므로 찍지 않는다.

결과: data/zoning_사창동.csv (pnu, 건물수, 용도지역, 출처레이어, 기타구역)
"""
import csv
import io
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from http_retry import get_json, ApiError  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        _s.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "data")
SRC = os.path.join(DATA, "bldginfo_사창동.csv")
OUT = os.path.join(DATA, "zoning_사창동.csv")

ENDPOINT = "https://api.vworld.kr/req/data"
DOMAIN = os.environ.get("VWORLD_DOMAIN", "https://cbnu-lawmap.github.io")
ZONE_LAYERS = ["LT_C_UQ111", "LT_C_UQ112", "LT_C_UQ113", "LT_C_UQ114"]
EXTRA_LAYERS = ["LT_C_UD801", "LT_C_UPISUQ161"]
SIZE = 1000
MAX_PAGES = 20


def load_buildings():
    rows = list(csv.DictReader(io.open(SRC, encoding="utf-8-sig")))
    pts = []
    for r in rows:
        try:
            pts.append((r["pnu"], float(r["lon"]), float(r["lat"])))
        except (KeyError, ValueError):
            pass
    return pts


def fetch_layer(layer, box, key, session):
    """한 레이어의 bbox 안 도형을 모두 받는다. 오류면 (None, 오류글)."""
    feats, page = [], 1
    while page <= MAX_PAGES:
        params = {
            "service": "data", "request": "GetFeature", "version": "2.0", "data": layer,
            "key": key, "domain": DOMAIN, "format": "json", "crs": "EPSG:4326",
            "geomFilter": "BOX(%f,%f,%f,%f)" % box, "size": str(SIZE), "page": str(page),
            "geometry": "true", "attribute": "true",
        }
        try:
            js = get_json(ENDPOINT, params, label=layer, session=session)
        except ApiError as e:
            return None, str(e)
        resp = js.get("response", {}) if isinstance(js, dict) else {}
        status = resp.get("status")
        if status == "NOT_FOUND":
            break
        if status != "OK":
            err = resp.get("error") or {}
            return None, "status=%s code=%s text=%s" % (status, err.get("code"), err.get("text"))
        got = ((resp.get("result") or {}).get("featureCollection") or {}).get("features") or []
        feats.extend(got)
        total_pages = int((resp.get("page") or {}).get("total") or 1)
        if page >= total_pages or not got:
            break
        page += 1
    return feats, ""


def inside(x, y, geom):
    if not geom:
        return False
    if geom["type"] == "Polygon":
        polys = [geom["coordinates"]]
    elif geom["type"] == "MultiPolygon":
        polys = geom["coordinates"]
    else:
        return False
    for poly in polys:
        hit = False
        for ring in poly:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
                if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                    hit = not hit
        if hit:
            return True
    return False


def name_of(props):
    for k in ("uname", "UNAME", "dgm_nm", "prpos_area_dstrc_nm", "name"):
        v = props.get(k)
        if v:
            return str(v).strip()
    return ""


def main():
    key = os.environ.get("VWORLD_KEY")
    if not key:
        print("VWORLD_KEY 가 없어 건너뜀")
        return
    pts = load_buildings()
    xs = [p[1] for p in pts]
    ys = [p[2] for p in pts]
    m = 0.002
    box = (min(xs) - m, min(ys) - m, max(xs) + m, max(ys) + m)
    print("건물 %d동, bbox %.4f,%.4f,%.4f,%.4f" % ((len(pts),) + box))

    session = requests.Session()
    session.headers["Referer"] = DOMAIN + "/"

    layers = {}
    errors = []
    for layer in ZONE_LAYERS + EXTRA_LAYERS:
        feats, err = fetch_layer(layer, box, key, session)
        if feats is None:
            print("  %s 오류: %s" % (layer, err))
            errors.append(layer)
            continue
        print("  %s 도형 %d개" % (layer, len(feats)))
        if feats:
            print("    첫 도형 속성 이름: %s" % sorted((feats[0].get("properties") or {}).keys()))
        layers[layer] = feats

    if not any(layers.get(l) for l in ZONE_LAYERS):
        raise SystemExit("용도지역 도형을 하나도 받지 못함 (오류 레이어: %s)" % ", ".join(errors))

    by_pnu = {}
    for pnu, x, y in pts:
        d = by_pnu.setdefault(pnu, {"n": 0, "zone": [], "layer": [], "extra": []})
        d["n"] += 1
        for layer in ZONE_LAYERS:
            for f in layers.get(layer) or []:
                if inside(x, y, f.get("geometry")):
                    nm = name_of(f.get("properties") or {})
                    if nm and nm not in d["zone"]:
                        d["zone"].append(nm)
                        d["layer"].append(layer)
                    break
        for layer in EXTRA_LAYERS:
            for f in layers.get(layer) or []:
                if inside(x, y, f.get("geometry")):
                    nm = name_of(f.get("properties") or {}) or layer
                    tag = "%s:%s" % (layer, nm)
                    if tag not in d["extra"]:
                        d["extra"].append(tag)
                    break

    with io.open(OUT, "w", encoding="utf-8-sig", newline="") as fp:
        w = csv.writer(fp)
        w.writerow(["pnu", "건물수", "용도지역", "출처레이어", "기타구역"])
        for pnu in sorted(by_pnu):
            d = by_pnu[pnu]
            w.writerow([pnu, d["n"], "|".join(d["zone"]), "|".join(d["layer"]), "|".join(d["extra"])])

    cnt = {}
    for pnu, x, y in pts:
        z = "|".join(by_pnu[pnu]["zone"]) or "(없음)"
        cnt[z] = cnt.get(z, 0) + 1
    print("\n[건물 기준 용도지역 분포]")
    for z, c in sorted(cnt.items(), key=lambda t: -t[1]):
        print("  %-24s %5d" % (z, c))
    print("저장: %s (필지 %d개)" % (OUT, len(by_pnu)))


if __name__ == "__main__":
    main()
