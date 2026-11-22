# -*- coding: utf-8 -*-
"""
의안정보시스템(likms.assembly.go.kr)에서 의안 원문·검토보고서 PDF 를 받아 글만 뽑는다.

  1. 상세 페이지 /bill/bi/billDetailPage.do?billId=... 의 숨은 입력값(billId, billNo, billKindCd …)을 읽고
  2. 같은 값으로 /bill/bi/bill/detail/billInfo.do 에 POST 하면 "심사정보" 조각 HTML 이 온다
  3. 그 안의 a.icon_pdf 링크(title 에 "의안원문" / "검토보고서")가 /filegate/servlet/FileGate?bookId=...&type=1
     로그인·세션 없이 받힌다.
PDF 원본은 --raw 폴더(저장소 밖)에만 두고, 저장소에는 뽑은 글과 index.csv 만 넣는다.
받은 파일은 믿지 않는 자료로 다룬다: 법안마다 따로 폴더에 두고, pypdf 로 글만 읽는다.

사용법 (law-impact-map 폴더에서, pypdf 필요):
  python collect/fetch_bill_docs.py --raw <저장소 밖 폴더> 2220631 2220895 ...
  python collect/fetch_bill_docs.py --raw <폴더> --demo          # 판정 시범 26건
결과: data/bill_docs/<의안번호>_원문.txt, <의안번호>_검토보고서.txt, index.csv (있던 행은 의안번호·종류로 덮어씀)
"""
import argparse
import csv
import datetime
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "bill_docs")
BASE = "https://likms.assembly.go.kr"
UA = {"User-Agent": "Mozilla/5.0"}
KINDS = ("원문", "검토보고서")
FIELDS = ["BILL_NO", "kind", "source_url", "pages", "chars", "extracted_at", "note"]


def get(url, data=None, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(10 * (i + 1))


def find_links(bill_id):
    """{종류: PDF 받는 주소}"""
    page = get(f"{BASE}/bill/bi/billDetailPage.do?billId={bill_id}").decode("utf-8", "replace")
    form = re.search(r'<input type="hidden" id="billId".*?name="stageMemo"[^>]*>', page, re.S).group(0)
    fields = re.findall(r'name="([^"]+)" value="([^"]*)"', form)
    frag = get(BASE + "/bill/bi/bill/detail/billInfo.do", urllib.parse.urlencode(fields).encode()).decode("utf-8", "replace")
    links = {}
    for href, title in re.findall(r'<a class="icon_pdf" href="([^"]+)" title="([^"]+)"', frag):
        m = re.search(r"(/filegate/servlet/FileGate\?bookId=[^&']+&type=\d)", html.unescape(href))
        kind = "원문" if "의안원문" in title else "검토보고서" if "검토보고서" in title else None
        if m and kind and kind not in links:
            links[kind] = BASE + m.group(1)
    return links


def pdf_text(path):
    from pypdf import PdfReader
    r = PdfReader(path)
    return "\n".join((p.extract_text() or "") for p in r.pages).strip(), len(r.pages)


def main():
    ap = argparse.ArgumentParser(description="의안 원문·검토보고서 글 뽑기")
    ap.add_argument("bills", nargs="*", help="의안번호")
    ap.add_argument("--demo", action="store_true", help="web/data/demo_rules.json 의 26건")
    ap.add_argument("--raw", required=True, help="PDF 원본을 둘 폴더 (저장소 밖)")
    a = ap.parse_args()
    with open(os.path.join(ROOT, "web", "data", "bills.json"), encoding="utf-8") as f:
        bills = {b["no"]: b for b in json.load(f)["bills"]}
    nos = list(a.bills)
    if a.demo:
        with open(os.path.join(ROOT, "web", "data", "demo_rules.json"), encoding="utf-8") as f:
            nos += [d["bill_no"] for d in json.load(f)["demos"]]
    os.makedirs(OUT, exist_ok=True)
    idx_path = os.path.join(OUT, "index.csv")
    rows = {}
    if os.path.exists(idx_path):
        with open(idx_path, encoding="utf-8-sig") as f:
            rows = {(r["BILL_NO"], r["kind"]): r for r in csv.DictReader(f)}
    today = datetime.date.today().isoformat()
    for no in dict.fromkeys(nos):
        try:
            bill_id = re.search(r"billId=([^&]+)", bills[no]["link"]).group(1)
            links = find_links(bill_id)
            err = ""
        except Exception as e:
            links, err = {}, repr(e)[:120]
        for kind in KINDS:
            row = {"BILL_NO": no, "kind": kind, "source_url": links.get(kind, ""), "pages": "", "chars": "",
                   "extracted_at": today, "note": ""}
            if err:
                row["note"] = "실패: " + err
            elif kind not in links:
                row["note"] = f"문서 없음 (상세 페이지에 {kind} PDF 링크가 없음)"
            else:
                try:
                    folder = os.path.join(a.raw, no, kind)
                    os.makedirs(folder, exist_ok=True)
                    path = os.path.join(folder, "file.pdf")
                    body = get(links[kind])
                    if body[:5] != b"%PDF-":
                        raise ValueError("PDF 아님")
                    with open(path, "wb") as f:
                        f.write(body)
                    text, pages = pdf_text(path)
                    with open(os.path.join(OUT, f"{no}_{kind}.txt"), "w", encoding="utf-8", newline="\n") as f:
                        f.write(text + "\n")
                    row.update(pages=pages, chars=len(text), note="PDF 텍스트 추출(pypdf)"
                               + (" / 글자가 거의 없음(스캔본 의심)" if len(text) < 200 else ""))
                except Exception as e:
                    row["note"] = "실패: " + repr(e)[:120]
                time.sleep(3)
            rows[(no, kind)] = row
            print(no, kind, row["pages"], row["chars"], row["note"], flush=True)
        time.sleep(3)
    with open(idx_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        w.writerows(rows.values())


if __name__ == "__main__":
    main()
