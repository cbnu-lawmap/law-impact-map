# 열린국회정보 API 목록 (수집 대상)

호출: `https://open.assembly.go.kr/portal/openapi/{서비스ID}` (KEY, TYPE=json, pIndex, pSize)

| 용도 | API | 서비스ID | 주요 요청 인자 | 현황 |
| --- | --- | --- | --- | --- |
| 법안 목록 | 국회의원 발의법률안 | nzmimeepazxkubdpn | AGE, BILL_NAME, COMMITTEE, PROC_RESULT | 22대 20,396건 수집 (2026-11-03) |
| 법안 본문 | 법률안 제안이유 및 주요내용 | BPMBILLSUMMARY | BILL_NO | 후보 678건 중 676건 확보 |
| 보조 | 의안정보 통합 | ALLBILLV2 | ERACO (예: 제21대) | 상정일 교차 확인 (`collect_process.py`) |
| 보조 | 법률안 심사 및 처리 | TVBPMBILL11 | AGE | 상정일 교차 확인 (`collect_process.py`) |
| 통과 예측 특징 | 국회의원 발의법률안 (같은 API) | nzmimeepazxkubdpn | AGE | 회부일·상정일, 공동발의 인원, 대표·공동발의 의원 코드(RST_MONA_CD, PUBL_MONA_CD) |
| 통과 예측 특징 | 역대 국회의원 위원회 경력 | nqbeopthavwwfbekw | PROFILE_UNIT_CD (예: 100021) | 의원 코드별 위원회·기간(FRTO_DATE) → 제안일에 소관 위원회 위원인지 |
| 통과 예측 특징 | 국회의원 위원회 경력 (지금 의원) | nyzrglyvagmrypezq | 없음 | 위와 같음, 지금 의원의 모든 대수 경력 |
| 참고 | 의안 제안자 정보 | BILLINFOPPSR | BILL_ID | 대표/공동 구분(REP_DIV). 발의법률안 API로 충분해 쓰지 않음 |

`collect_process.py` 결과(`data/bills_process_21.csv`, `_22.csv`)에는 의원 이름·정당·코드를 남기지 않고 숫자·0/1·날짜만 남긴다.
소위원회 회부일과 대안 의안번호는 위 API들에서 찾지 못해 수집하지 않았다. ALLNAMEMBER 의 소속 위원회(BLNG_CMIT_NM)는 가장 최근 대수 것만 있어 지난 대수 소속 판정에 쓸 수 없다.

출처: 열린국회정보(open.assembly.go.kr), 수집일 2026-11-03
