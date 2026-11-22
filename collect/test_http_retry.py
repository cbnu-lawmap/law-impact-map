"""열린국회 API 재시도 시험 (네트워크 없이 가짜 연결로): python collect/test_http_retry.py"""
import contextlib
import io
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from http_retry import ApiError, get_json  # noqa: E402

SECRET = "TESTKEY1234567890"


class Res:
    def __init__(self, status=200, data=None, bad_json=False):
        self.status_code, self._data, self._bad = status, data, bad_json

    def json(self):
        if self._bad:
            raise ValueError("bad json")
        return self._data


class FakeSession:
    """차례대로 돌려줄 것: 예외 클래스면 그 예외를 던지고, Res 면 응답으로 준다"""
    def __init__(self, script):
        self.script, self.calls = list(script), 0

    def get(self, url, params=None, timeout=None):
        self.calls += 1
        x = self.script.pop(0)
        if isinstance(x, type) and issubclass(x, Exception):
            raise x(f"Max retries exceeded with url: {url}?KEY={params['KEY']}")
        return x


def run(script):
    s, waits, out = FakeSession(script), [], io.StringIO()
    with contextlib.redirect_stdout(out):
        try:
            result = get_json("https://open.assembly.go.kr/portal/openapi/x", {"KEY": SECRET}, "시험",
                              sleep=waits.append, session=s)
            err = None
        except ApiError as e:
            result, err = None, str(e)
    return result, err, s.calls, waits, out.getvalue()


def check(name, ok):
    print(("통과  " if ok else "실패  ") + name)
    return ok


def main():
    r = []
    res, err, calls, waits, log = run([requests.exceptions.ConnectTimeout, requests.exceptions.ReadTimeout, Res(200, {"ok": 1})])
    r.append(check("시간 초과 두 번 뒤 세 번째에 성공", res == {"ok": 1} and calls == 3 and waits == [5, 15]))
    r.append(check("기록에 인증키가 없음", SECRET not in log))

    res, err, calls, waits, log = run([Res(502), Res(200, None, bad_json=True), Res(200, {"ok": 2})])
    r.append(check("5xx·깨진 JSON 도 다시 시도", res == {"ok": 2} and calls == 3))

    res, err, calls, waits, log = run([requests.exceptions.ConnectionError] * 4)
    r.append(check("네 번 모두 실패하면 ApiError", err is not None and calls == 4 and waits == [5, 15, 30]))
    r.append(check("실패 메시지·기록에 인증키가 없음", SECRET not in (err or "") and SECRET not in log))

    res, err, calls, waits, log = run([Res(200, {"ok": 3})])
    r.append(check("한 번에 성공하면 쉬지 않음", res == {"ok": 3} and calls == 1 and waits == []))

    print("모두 통과" if all(r) else "실패 있음")
    sys.exit(0 if all(r) else 1)


if __name__ == "__main__":
    main()
