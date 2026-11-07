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
| `cheongju_emd.geojson` | 바람의 지도 프로젝트에서 복사 (원 출처 확인 필요) | 2026-10-31 복사 | 청주 행정동 43개 경계 |
| `cheongju_buildings_footprint.geojson` | 출처 확인 필요 | 2026-10-31 복사 | 13,166동, 높이(`h`)만. 청주 전체가 아님 (사창동 경계 안 150동) |

점검 결과는 [docs/data_check.md](../docs/data_check.md) 참고.

웹 시제품용 경량 데이터는 `collect/build_web_data.py`로 `web/data/`에 생성한다 (건물명 등 이름 필드 제외, `cheongju_buildings_footprint.geojson`은 출처 불명이라 사용하지 않음).
