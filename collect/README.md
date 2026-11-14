# collect

열린국회정보 Open API로 법안을 수집하고 후보를 거르는 Python 스크립트 모음입니다.
모든 스크립트는 파일 위치를 기준으로 `data/` 폴더를 찾으므로 어느 폴더에서 실행해도 됩니다.

## 준비

```
pip install -r collect/requirements.txt
```

저장소 맨 위 폴더에 `.env` 파일을 만들고 열린국회정보 인증키를 넣습니다. (`.env.example` 참고, `.env`는 커밋하지 않습니다.)

```
ASSEMBLY_API_KEY=발급받은키
```

## 법안 수집·전처리 (순서대로 실행)

| 순서 | 명령 | 읽는 파일 | 만드는 파일 |
| :---: | --- | --- | --- |
| 1 | `python collect/collect_bills.py` | (API) | `data/bills_raw.csv` 22대 법안 전체 (약 2만 건, 저장소에는 올리지 않음) |
| 2 | `python collect/filter_bills.py` | `bills_raw.csv` | `data/bills_candidates_v2.csv` 계류·건축 관련 후보 (저장소에는 올리지 않음) |
| 3 | `python collect/collect_summaries.py` | `bills_candidates_v2.csv` | `data/bills_summary.csv` 제안이유·주요내용 |
| 4 | `python collect/make_sample.py` | `bills_summary.csv` | `data/sample_bills.csv` 검토용 샘플 |

- 1단계는 `bills_raw.csv`가 이미 있어도 새로 받아 덮어씁니다. (몇 분 걸림)
- `filter_bills.py`의 키워드 목록(`INCLUDE`/`EXCLUDE`)이 후보 법안 범위를 정합니다.
- 3단계에서 제안이유가 없는 법안은 `SUMMARY`가 비어 있습니다.

## 건물 데이터·웹 데이터

| 명령 | 설명 |
| --- | --- |
| `python collect/fetch_cheongju_buildings.py --emd 사창동` | 브이월드에서 동별 건물 속성 수집 → `data/bldginfo_<동>.csv` |
| `python collect/build_web_data.py` | 법안·건물 데이터로 웹 화면용 파일 생성 → `web/data/` |

## 분석 (법안 요약문 기준)

| 명령 | 설명 |
| --- | --- |
| `python collect/add_review_stage.py <bills_raw.csv 경로>` | 법안별 심사 단계 → `data/bills_stage.csv` (PR #17) |
| `python collect/extract_criteria.py` | 숫자 기준 문장 추출 → `data/criteria_rule.csv` (PR #18) |

위 두 스크립트는 각 PR이 머지된 뒤에 사용할 수 있습니다.
