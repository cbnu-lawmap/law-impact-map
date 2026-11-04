# 열린국회정보 API 목록 (수집 대상)

호출: `https://open.assembly.go.kr/portal/openapi/{서비스ID}` (KEY, TYPE=json, pIndex, pSize)

| 용도 | API | 서비스ID | 주요 요청 인자 | 현황 |
| --- | --- | --- | --- | --- |
| 법안 목록 | 국회의원 발의법률안 | nzmimeepazxkubdpn | AGE, BILL_NAME, COMMITTEE, PROC_RESULT | 22대 20,396건 수집 (2026-11-03) |
| 법안 본문 | 법률안 제안이유 및 주요내용 | BPMBILLSUMMARY | BILL_NO | 후보 678건 중 676건 확보 |
| 보조 | 의안정보 통합 | ALLBILLV2 | ERACO | 활용 예정 |
| 보조 | 법률안 심사 및 처리 | TVBPMBILL11 | AGE | 활용 예정 |

출처: 열린국회정보(open.assembly.go.kr), 수집일 2026-11-03
