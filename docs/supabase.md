# Supabase 설정 (시연용 클라우드 DB)

> 시연용 클라우드 DB입니다. 실제 도입 시에는 기관 내부 DB(PostgreSQL + pgvector)로 바꿉니다.
> 키가 하나도 없으면 사이트는 예전과 똑같이 동작합니다 (진행 기록은 각 브라우저에만 저장, 비슷한 법안은 단어 유사도).

프로젝트 주소: `https://bfwgwdcfdydwyiysrflm.supabase.co` (공개해도 되는 값, `web/config.js` 와 `collect/embed_bills.py` 에 들어 있음)

## 무엇을 저장하나

> 시연용: 로그인 없이 역할을 고르는 방식. 실제 도입 시 기관 통합로그인(SSO)·공무원 인증서(GPKI)와 연동

| 표 | 내용 | 누가 읽나 (브라우저, 공개 키) | 누가 쓰나 |
| :--- | :--- | :--- | :--- |
| `review_progress` | 법안별 진행 상태, 인계 메모(300자), 마지막 수정자(표시 이름)·시각, 승인/반려·결재자·반려 사유(100자) | 누구나 (읽기만) | 서버 `/api/progress` 가 서비스 키로 `progress_set()` · `progress_decide()` 만 |
| `review_log` | 등록·수정·승인·반려 기록 (누가 = "이름 (역할)") | 누구나 (읽기만) | 위 두 함수 안에서만 |
| `bill_embeddings` | 공개 법안 요약문의 임베딩(384차원) | 누구나 | 서비스 키(GitHub Actions)만 |
| `agent_runs` | 검토 에이전트 실행 기록(법안 번호, 단계 수, 토큰 수, 사람 수정 여부) | 직접은 못 읽음, `agent_run_stats()` 집계만 | 서비스 키(Vercel)만 |

수정 시각은 DB 트리거(`rp_stamp`)가 채웁니다. 담당자가 상태나 메모를 바꾸면 승인·반려가 풀려 다시 결재를 받아야 합니다.
진행 상태 값은 `todo`(미검토) · `doing`(검토 중) · `hold`(보류) · `done`(검토 완료) 네 가지이고, 결재자는 `done` 이면서 아직 결재하지 않은 법안만 승인·반려합니다.

## 처음 설정 (한 번)

1. **SQL 실행**: Supabase 대시보드 > SQL Editor 에서 차례로 실행합니다.
   - `supabase/schema.sql` (적용됨)
   - `supabase/migrations/002_approve_guard_and_text_hash.sql` (적용됨)
   - `supabase/migrations/003_no_login.sql`
     - 브라우저(anon / authenticated)는 `review_progress` · `review_log` 를 **읽기만** 합니다. 모든 표에서 insert / update / delete 권한을 거둡니다.
     - 쓰기 함수 `progress_set(p_bill_no, p_status, p_memo, p_actor)`, `progress_decide(p_bill_no, p_decision, p_reason, p_actor)` 를 만들고 실행 권한은 `service_role` 에만 줍니다. 저장과 `review_log` 기록이 한 함수 안에서 함께 일어납니다.
     - 이메일 로그인용 `members` 표, `my_role()`, `approve_review()` 를 지웁니다. `members` 에는 로그인 이메일(개인정보)만 있었고 이제 쓰지 않으므로 남기지 않습니다.
     - 예전 기록에 남은 이메일(수정자·결재자·기록의 누가)은 아이디 앞 두 글자 + `***` 로 가립니다. 이제 누구나 읽는 표이기 때문입니다.
     - 여러 번 실행해도 됩니다. 실시간 발행은 그대로 둡니다.
   - `supabase/migrations/004_demo_reset.sql` (시연 전용, 아래 「시연 초기화」)
     - `progress_reset()` 이 `review_progress` · `review_log` 의 모든 줄을 지우고 `agent_runs.human_edited` 만 false 로 되돌립니다 (`agent_runs` 줄은 남김). `security definer`, 실행 권한은 `service_role` 에만.
2. **Realtime**: `review_progress` 가 `supabase_realtime` 발행에 들어 있는지 Database > Publications 에서 확인합니다.
3. **이메일 로그인은 쓰지 않습니다.** Authentication > Providers > Email 은 꺼도 됩니다.

## 키 넣기

키 값은 저장소에 커밋하지 않습니다. 화면에는 공개(anon/publishable) 키만 들어갑니다.

| 어디 | 이름 | 값 | 쓰는 곳 |
| :--- | :--- | :--- | :--- |
| GitHub > Settings > Secrets > Actions | `SUPABASE_ANON_KEY` | 공개 키 (Project Settings > API 의 anon 또는 publishable) | `pages.yml` 이 배포본의 `web/config.js` 에 넣음 |
| GitHub > Settings > Secrets > Actions | `SUPABASE_SERVICE_ROLE_KEY` | 서비스 키 (service_role 또는 secret) | `embed-bills.yml` 이 임베딩을 넣을 때 |
| GitHub > Settings > Secrets > Actions | `SUPABASE_URL` (선택) | 프로젝트 주소 | 없으면 위 주소를 씀 |
| Vercel > ppaegok-api > Settings > Environment Variables | `SUPABASE_URL` | 프로젝트 주소 | `/api/similar`, 에이전트 실행 기록 |
| Vercel > ppaegok-api > Settings > Environment Variables | `SUPABASE_SERVICE_ROLE_KEY` | 서비스 키 | `server/lib/similar.js`, `server/lib/runs.js`, `server/api/progress.js`(진행 저장·결재) |

- 키를 넣은 뒤 Pages 는 **다시 배포**해야 화면에 반영됩니다 (Actions > Deploy web prototype to GitHub Pages > Run workflow).
- Vercel 은 환경변수를 바꾼 뒤 Redeploy 해야 반영됩니다.
- 임베딩은 Actions > Bill embeddings (pgvector) > Run workflow 에서 `all` 을 켜고 한 번 돌리면 전부 들어갑니다. 그 뒤로는 매일 07:30 에 새·바뀐 법안만 넣습니다.

## 화면에서

- 화면 맨 위(키가 있을 때만)에 "시연용: 로그인 없이 역할을 고르는 방식. 실제 도입 시 기관 통합로그인(SSO)·공무원 인증서(GPKI)와 연동" 안내와 **역할(담당자 / 결재자)** 고르기, **이름**(20자) 칸이 있습니다. 둘 다 이 브라우저(localStorage)에만 남습니다. 이름 칸에는 화면에 보일 이름만 적고 연락처·이메일 같은 개인정보는 넣지 않습니다 (전화번호·주민번호·이메일 모양은 화면과 서버가 모두 거절).
- 역할·이름을 정하기 전에는 함께 보는 기록을 **보기만** 합니다.
- 담당자: 진행 상태·메모를 저장하면 모두에게 바로 보입니다. "이 브라우저 기록 가져오기"로 예전 기록을 50건씩 나눠 올립니다 (클라우드 쪽이 더 최근이면 그대로 둠).
- 결재자: 진행 상태·메모는 바꿀 수 없습니다. 진행 현황의 "승인 대기 목록"(검토 완료 · 결재 전)과 법안 상세에서 승인하거나, 짧은 사유(100자, 선택)와 함께 반려합니다.
- 법안 상세와 진행 현황 표에 "마지막 수정: 누가 · 언제"와 승인/반려가 보입니다.
- Supabase 나 저장 서버(`/api/progress`)에 닿지 않으면 예전처럼 이 브라우저에만 저장하고, 진행 현황에 그렇다고 짧게 표시합니다. 키가 없으면 외부로 아무 요청도 보내지 않습니다.
- 상황판의 "검토 에이전트 초안" 카드는 `agent_run_stats()` 집계만 읽습니다. 기록이 없으면 "기록 없음", 불러오지 못하면 카드를 그리지 않습니다.

## 저장 서버 `/api/progress` (server/api/progress.js)

```text
GET  → { ok }  서버에 서비스 키가 있으면 true
POST { action: "set", role: "담당자", name, bill, status, memo }                 → { ok, row }
POST { action: "set", role: "담당자", name, items: [{ bill, status, memo }] }     → { ok, saved, rows, failed }  (최대 50건)
POST { action: "decide", role: "결재자", name, bill, decision: "승인" | "반려", reason } → { ok, row }
POST { action: "reset", confirm: "초기화" }                                     → { ok, reset: { progress, log, runs_reset } }  (시연 전용)
```

서버가 확인하는 것: 허용한 사이트(`server/lib/common.js` 의 CORS 목록, 아니면 403), IP당 1분 30회(넘으면 429), 이름 1~20자, 메모 300자, 반려 사유 100자, 의안번호 7자리이고 `bills.json` 에 있음, 이름·메모·사유에 전화번호·주민번호·이메일 모양이면 거절, 담당자는 상태·메모만(`set`), 결재자는 승인·반려만(`decide`). DB 함수도 같은 길이·값·순서(검토 완료된 법안만, 한 번만 결재)를 다시 확인합니다.

## 시연 초기화 (시연 전용)

발표·시연 전에 진행 기록과 결재 기록을 비워 처음 상태로 돌립니다. 실제 도입 시에는 이 동작과 `progress_reset()` 을 두지 않습니다 (기록은 지우지 않고 보존).

- 터미널: `cd server && npm run demo:reset` (배포 서버 `https://ppaegok-api.vercel.app` 에 보냄, 키 필요 없음). 로컬은 `npm run demo:reset -- --base http://127.0.0.1:3000`.
- 행정 화면 숨은 메뉴: `admin.html#reset` (화면 어디에도 링크하지 않음). 「초기화」 → 「정말 모두 지우기」 두 번 눌러야 지우고, 클라우드 모드면 진행 기록을 다시 읽습니다.
- 서버가 확인하는 것: 허용한 사이트(CORS 목록)만, 확인 문구 `confirm` 이 정확히 `"초기화"` (아니면 400), IP당 1분 2회 (넘으면 429). 역할·이름은 받지 않습니다. 누구나 사이트 주소만 알면 부를 수 있으므로 시연 기간에만 둡니다.
- `004_demo_reset.sql` 을 적용하기 전에는 DB 함수가 없어 502 가 납니다.

## 보안 정리

- **모든 표에 RLS** 를 켰습니다. 브라우저(공개 키)는 `review_progress` · `review_log` 를 **읽기만** 하고, 어느 표에도 쓰지 못합니다 (정책도 권한도 없음).
- **쓰기는 서버만** 합니다. `/api/progress` 가 위 확인을 마친 뒤 서비스 키(`service_role`)로 `progress_set()` · `progress_decide()` 를 부릅니다. 두 함수는 `security definer` 이고 실행 권한은 `service_role` 에만 있습니다.
- 브라우저에는 **공개(anon/publishable) 키만** 들어갑니다. 서비스 키는 Vercel 환경변수와 GitHub Actions secrets 에만 둡니다.
- **스스로 고른 역할은 시연용**입니다. 누구나 담당자나 결재자를 고를 수 있으므로 권한 증명이 아닙니다. 실제 도입 시 기관 통합로그인(SSO)·공무원 인증서(GPKI)로 신원과 역할을 확인하고, 서버가 그 정보로 역할을 정해야 합니다.
- 공개 시연 데이터(의안번호, 진행 상태, 메모, 표시 이름, 시각)만 저장합니다. 이메일은 받지 않습니다.
- 화면은 supabase-js 를 고정 버전(2.45.4)과 무결성 해시(SRI)로 받습니다. 키가 없으면 받지도 않습니다.

## 기관 내부 DB 로 바꿀 때

- 같은 `schema.sql` 과 마이그레이션을 내부 PostgreSQL(+ pgvector) 에 적용하고, 로그인은 기관 통합로그인(SSO)·공무원 인증서(GPKI)로 붙입니다. 서버(`/api/progress`)가 화면이 보낸 역할·이름 대신 로그인 정보로 역할과 이름을 정하면 됩니다.
- 화면은 `web/cloud.js` 한 파일만 바꾸면 됩니다 (`admin.js` 와는 `Cloud.*` 연결부로만 이어짐).
- 서버는 `server/lib/supabase.js` 의 주소·헤더만 바꾸면 됩니다 (PostgREST 형식).
