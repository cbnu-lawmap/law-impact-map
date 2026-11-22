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
- 3단계에서 제안이유가 없는 법안은 `SUMMARY`가 비어 있습니다. 이미 받아 둔 제안이유는 다시 받지 않고, 후보에서 빠진 법안도 목록에 남깁니다.
- 키(`ASSEMBLY_API_KEY`)가 없으면 1·3단계는 한 줄만 남기고 건너뜁니다.

## 매일 자동 수집 (`.github/workflows/daily-collect.yml`)

매일 06:30(한국 시간)에 GitHub Actions가 아래를 차례로 돌립니다. 바뀐 것이 있으면 main에 커밋하고 바로 Pages에 배포합니다.
저장소 비밀값 `ASSEMBLY_API_KEY`가 없으면 아무것도 하지 않고 성공으로 끝납니다.

1. `collect_bills.py` → `filter_bills.py` → `collect_summaries.py` → `add_review_stage.py data/bills_raw.csv`
2. `python collect/classify_new_bills.py`: `bills_field_pred.csv`에 없는 새 법안만 분야를 붙여 맨 끝에 덧붙입니다.
   `labels_300.csv`(사람이 붙인 분야)로 배우는 간단한 나이브 베이즈라 노트북 모델보다 약합니다.
   그래서 확신도를 0.5 이하로 적어 화면에 "분류 확인 필요"가 뜹니다. 기존 줄은 바꾸지 않습니다.
3. `build_web_data.py`: `data/bills_seen.csv`에 법안을 처음 본 날을 남기고, `bills.json`에 `added`로 넣습니다.
   처음 만들 때 있던 법안은 날짜가 비어 있어 "새로 들어온 법안"에 나오지 않습니다.

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
| `python collect/crosscheck_criteria.py` | 기준 교차 확인(우리 AI · 규칙 기반 · 팀원 AI) → `data/criteria_crosscheck.csv`, `web/data/crosscheck.json`. `--candidates` 를 붙이면 노후(경과연수) 후보 동수 표도 출력 |

`crosscheck_criteria.py` 는 `web/data/demo_rules.json`(먼저 `build_web_data.py` 실행), `data/criteria_rule.csv`, 팀원 AI 추출 `data/ai_feature_extraction.csv` 를 읽습니다. 팀원 파일이 저장소에 없으면 `git fetch origin` 뒤 `origin/feature/ai-feature-extraction` 브랜치에서 읽고, 다른 곳에 있으면 `--team 경로` 로 지정합니다. 교차 확인됨은 출처끼리 수치가 같다는 뜻이고 사람이 확인했다는 뜻이 아닙니다.

위 두 스크립트는 각 PR이 머지된 뒤에 사용할 수 있습니다.
