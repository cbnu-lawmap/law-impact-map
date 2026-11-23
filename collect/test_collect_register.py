"""건축물대장 표제부 수집 시험 (네트워크 없이): python collect/test_collect_register.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from collect_register import ApiError, fetch, items_of, make_pnu  # noqa: E402

SECRET = "TESTKEY+abc/123=="


class Res:
    def __init__(self, status, text):
        self.status_code, self.text = status, text


class Session:
    def __init__(self, res):
        self.res = res

    def get(self, url, params=None, timeout=None):
        assert params["serviceKey"] == SECRET
        return self.res


# PNU: 대지(platGbCd 0) → 1, 산(1) → 2, 번·지는 4자리
assert make_pnu({"sigunguCd": "43112", "bjdongCd": "10200", "platGbCd": "0", "bun": "0156", "ji": "0005"}) == "4311210200101560005"
assert make_pnu({"sigunguCd": "43112", "bjdongCd": "10200", "platGbCd": "1", "bun": "12", "ji": ""}) == "4311210200200120000"
assert make_pnu({"sigunguCd": "43112", "bjdongCd": "10200", "platGbCd": "2", "bun": "1", "ji": "1"}) is None  # 블록은 PNU 없음

# 한 줄이면 item 이 dict 로 온다
assert items_of({"items": {"item": {"a": 1}}}) == [{"a": 1}]
assert items_of({"items": ""}) == []

# 인증 오류 XML: 다시 시도하지 않고 바로 알리며, 키가 메시지에 들어가지 않는다
xml = ("<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg>"
       "<returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode>"
       f"<echo>{SECRET}</echo></cmmMsgHeader></OpenAPI_ServiceResponse>")
try:
    fetch({}, "시험", SECRET, session=Session(Res(200, xml)), sleep=lambda s: None)
    raise AssertionError("오류가 나야 함")
except ApiError as e:
    msg = str(e)
    assert "SERVICE_KEY_IS_NOT_REGISTERED_ERROR" in msg and SECRET not in msg, msg

body = fetch({}, "시험", SECRET, session=Session(Res(200, '{"response":{"header":{"resultCode":"00"},"body":{"totalCount":1}}}')))
assert body["totalCount"] == 1
print("collect_register 시험 통과")
