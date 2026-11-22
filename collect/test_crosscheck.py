"""교차 확인 용도 판단 시험: python collect/test_crosscheck.py

두 출처가 같은 오답(물류터미널 → 운수시설 08000)을 내도 법령 분류(별표1 18호 창고시설)와 다르면
"교차 확인됨"이 아니라 "확인 필요"가 되어야 한다.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crosscheck_criteria as cc  # noqa: E402


def use_items(codes):
    return [cc.mk("용도", codes=codes)]


def check(name, got, want):
    ok = got == want
    print(("통과  " if ok else "실패  ") + name + ("" if ok else f" (기대 {want}, 실제 {got})"))
    return ok


def main():
    results = []
    # 2220631 요약에는 "물류터미널"이 나온다
    law = cc.legal_codes(cc.SUMMARY["2220631"])
    results.append(check("2220631 법안 글의 물류터미널은 창고시설(18000)", "18000" in law, True))

    st, notes, _ = cc.compare("2220631", "용도", {"ours": use_items(["08000"]), "rule": [], "team": use_items(["08000"])}, "")
    results.append(check("두 출처가 같은 오답(운수시설)이면 확인 필요", st, cc.ST_CHECK))
    results.append(check("사유에 법령 분류와 다름", any("법령 분류와 다름" in n for n in notes), True))

    st, _, _ = cc.compare("2220631", "용도", {"ours": use_items(["18000"]), "rule": [], "team": use_items(["18000"])}, "")
    results.append(check("두 출처가 창고시설로 같으면 교차 확인됨", st, cc.ST_OK))

    st, _, _ = cc.compare("2220631", "용도", {"ours": use_items(["08000"]), "rule": [], "team": []}, "")
    results.append(check("한 출처만 있어도 법령 분류와 다르면 확인 필요", st, cc.ST_CHECK))

    # 여객터미널은 운수시설 (보탬 이름)
    st, _, _ = cc.compare("2206177", "용도", {"ours": use_items(["08000"]), "rule": [], "team": []}, "")
    results.append(check("2206177 여객터미널 → 운수시설은 법령 분류와 맞음 (단일 출처)", st, cc.ST_ONE))

    print("모두 통과" if all(results) else "실패 있음")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
