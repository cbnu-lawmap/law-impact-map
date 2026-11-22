"""열린국회 API 호출 재시도

GitHub Actions 에서 open.assembly.go.kr 연결이 가끔 시간 초과로 끊긴다 (2026-11-23 첫 매일 수집에서 확인).
연결 오류·시간 초과·5xx·깨진 JSON 은 5초, 15초, 30초 쉬고 다시 부른다 (모두 4번).
기록에는 예외 종류만 남긴다. 예외 글과 주소에는 인증키(KEY 파라미터)가 들어 있으므로 찍지 않는다.
"""
import time

import requests

WAITS = (5, 15, 30)          # 재시도 전 쉬는 시간(초). 시도 횟수 = len(WAITS) + 1
TIMEOUT = (10, 30)           # (연결, 읽기) 초


class ApiError(Exception):
    """재시도를 다 써도 실패. 메시지에 인증키를 넣지 않는다."""


def get_json(url, params, label="", waits=WAITS, sleep=time.sleep, session=requests):
    tries = len(waits) + 1
    last = ""
    for n in range(1, tries + 1):
        try:
            res = session.get(url, params=params, timeout=TIMEOUT)
            if res.status_code >= 500:
                last = f"HTTP {res.status_code}"
            else:
                return res.json()
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            last = type(e).__name__
        except ValueError:          # JSON 이 깨져 옴
            last = "JSON 해석 실패"
        if n < tries:
            print(f"  {label} {n}/{tries}번째 시도 실패 ({last}), {waits[n - 1]}초 뒤 다시 시도")
            sleep(waits[n - 1])
    raise ApiError(f"{label} {tries}번 모두 실패 ({last})")
