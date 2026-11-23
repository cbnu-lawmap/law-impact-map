# data
CSV 데이터 보관 폴더

- 저장소에는 샘플 데이터만 올림 (GitHub 파일당 100MB 제한)
- 전체 원본은 별도 공유 드라이브에 보관하고 이 문서에 링크 기록

| 데이터 | 출처 | 수집 일자 | 비고 |
| --- | --- | --- | --- |
| 법안 | 열린국회정보 Open API | | |
| 건축물대장 | 건축데이터 개방 | | 1차 판정은 아래 건물통합정보로 충분, 세대수·층별용도가 필요할 때 보완 |
| 건물 도형 | 브이월드(V-WORLD) | | |
| `bldginfo_사창동.csv` / `.geojson` | 브이월드 WFS `lt_c_bldginfo` (건물통합정보) | 2026-10-31 | 사창동(행정동) 경계 안 2,448동, 건물명(`bld_nm`) 제외. CSV는 속성, geojson은 지도용 도형 (`collect/fetch_cheongju_buildings.py`로 재생성) |
| `bldg_register_사창동.csv` (아직 없음) | 공공데이터포털 건축물대장 표제부 | | 받으면 이 이름으로 둔다. 열: `pnu`(19자리), `totalarea`·`useapr_day`·`grnd_flr`·`hhld_cnt`·`main_purps_cd` (API 이름 `totArea`·`useAprDay`·`grndFlrCnt`·`hhldCnt`·`mainPurpsCd` 도 됨). `collect/build_web_data.py` 와 `notebooks/building_imputation.ipynb` 가 브이월드에서 **빈 칸만** 채운다 (그 PNU 에 표제부 한 줄, 건물도 한 동일 때만). 없으면 아무것도 바뀌지 않는다 |
| `cheongju_emd.geojson` | 바람의 지도 프로젝트에서 복사 (원 출처 확인 필요) | 2026-10-31 복사 | 청주 행정동 43개 경계 |
| `cheongju_buildings_footprint.geojson` | 출처 확인 필요 | 2026-10-31 복사 | 13,166동, 높이(`h`)만. 청주 전체가 아님 (사창동 경계 안 150동) |

`bills_process_21.csv` / `bills_process_22.csv`: 열린국회 API로 모은 법안별 심사 경과·공동발의 특징 (`collect/collect_process.py`, Actions `Collect bill process`로 수집). 열: 공동발의 인원(`COSPONSOR_N`), 제안일에 대표발의 의원이 소관 위원회 위원인지(`REP_IN_CMT`), 공동발의 의원 중 소관 위원회 위원 수·비율, 회부·상정·위원회 처리일과 제안일로부터 일수(`DAYS_TO_REFER`, `DAYS_TO_PRESENT`), 상정 여부(`PRESENTED`, `PRESENTED_90D`), 대안반영 여부(`ALT_REFLECTED`, 설명용, 정답과 이어져 특징으로 쓰지 않음). 의원 이름·정당은 없다.

점검 결과는 [docs/data_check.md](../docs/data_check.md) 참고.

웹 시제품용 경량 데이터는 `collect/build_web_data.py`로 `web/data/`에 생성한다 (건물명 등 이름 필드 제외, `cheongju_buildings_footprint.geojson`은 출처 불명이라 사용하지 않음).

`bill_docs/`: 의안정보시스템(likms)에서 받은 의안 원문·검토보고서 PDF 에서 뽑은 글 (판정 시범 26건 + 위원회 상정 10건, 2026-11-23). PDF 원본은 저장소에 넣지 않는다. 받은 주소·쪽수·글자 수는 `bill_docs/index.csv`, 다시 받기는 `collect/fetch_bill_docs.py`, 분석은 [docs/bill_docs_analysis.md](../docs/bill_docs_analysis.md).

`building_imputation_pred.csv`: `notebooks/building_imputation.ipynb` 가 만든 빈칸 추정 (참고용, 판정에 안 씀). 열: `idx`(bldginfo geojson 안 순서), `pnu`, 대상(`area` 연면적, `year` 사용승인 연대, `flr` 지상층수)마다 `est_<대상>_class`·`est_<대상>`·`est_<대상>_p`·`p_<대상>_<번호>`. 그 속성이 있는 건물은 칸이 비어 있다.
