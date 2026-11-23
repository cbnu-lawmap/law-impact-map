# Supabase 설정 (시연용 클라우드 DB)

> 시연용 클라우드 DB입니다. 실제 도입 시에는 기관 내부 DB(PostgreSQL + pgvector)로 바꿉니다.
> 키가 하나도 없으면 사이트는 예전과 똑같이 동작합니다 (진행 기록은 각 브라우저에만 저장, 비슷한 법안은 단어 유사도).

프로젝트 주소: `https://bfwgwdcfdydwyiysrflm.supabase.co` (공개해도 되는 값, `web/config.js` 와 `collect/embed_bills.py` 에 들어 있음)

## 무엇을 저장하나

| 표 | 내용 | 누가 읽나 | 누가 쓰나 |
| :--- | :--- | :--- | :--- |
| `members` | 로그인 이메일과 역할(담당자 / 결재자) | 본인 줄만 | 관리자가 SQL 로 직접 |
| `review_progress` | 법안별 진행 상태, 인계 메모(300자), 마지막 수정자·시각, 결재 여부 | 구성원 | 담당자(저장), 결재자는 `approve_review()` 함수로 결재만 |
| `review_log` | 등록·수정·결재 기록 (트리거가 씀) | 구성원 | 트리거·결재 함수만 |
| `bill_embeddings` | 공개 법안 요약문의 임베딩(384차원) | 누구나 | 서비스 키(GitHub Actions)만 |
| `agent_runs` | 검토 에이전트 실행 기록(법안 번호, 단계 수, 토큰 수, 사람 수정 여부) | 구성원, 화면에는 `agent_run_stats()` 집계만 | 서비스 키(Vercel)만 |

수정자·시각은 화면이 보내는 값이 아니라 DB 트리거(`rp_stamp`)가 로그인 정보로 채웁니다. 담당자가 저장하면 결재가 풀려 다시 결재를 받아야 합니다.

## 처음 설정 (한 번)

1. **SQL 실행**: Supabase 대시보드 > SQL Editor 에서 차례로 실행합니다.
   - `supabase/schema.sql` (적용됨)
   - `supabase/migrations/002_approve_guard_and_text_hash.sql`
     - 담당자가 `approved` 열을 직접 바꿔 스스로 결재할 수 있던 구멍을 막고, 이미 결재된 법안을 다시 결재하면 결재가 풀리던 문제를 고칩니다.
     - `bill_embeddings.text_hash` 열을 더해 요약문이 바뀐 법안만 임베딩을 다시 만듭니다 (열이 없어도 스크립트는 "없는 법안만" 넣습니다).
2. **이메일 로그인**: Authentication > Providers > Email 을 켭니다 (Magic Link).
   Authentication > URL Configuration 에서
   - Site URL: `https://cbnu-lawmap.github.io/law-impact-map/`
   - Redirect URLs: `https://cbnu-lawmap.github.io/law-impact-map/admin.html`, 로컬 시험용 `http://localhost:8000/admin.html`
3. **Realtime**: `schema.sql` 이 `review_progress` 를 `supabase_realtime` 발행에 넣습니다. Database > Publications 에서 켜져 있는지 확인합니다.
4. **구성원 등록**: SQL Editor 에서 넣습니다. 이메일은 **소문자**로 넣습니다 (로그인 이메일을 소문자로 바꿔 비교함).

   ```sql
   insert into public.members(email, role) values ('담당자메일@example.go.kr', '담당자');
   insert into public.members(email, role) values ('결재자메일@example.go.kr', '결재자');
   -- 역할 바꾸기 / 빼기
   update public.members set role = '결재자' where email = '...';
   delete from public.members where email = '...';
   ```

   등록되지 않은 사람도 이메일 링크로 로그인은 되지만, 화면에 "구성원으로 등록되지 않은 계정"이라고 나오고 아무 표도 읽거나 쓸 수 없습니다 (RLS).

## 키 넣기

키 값은 저장소에 커밋하지 않습니다. 화면에는 공개(anon/publishable) 키만 들어갑니다.

| 어디 | 이름 | 값 | 쓰는 곳 |
| :--- | :--- | :--- | :--- |
| GitHub > Settings > Secrets > Actions | `SUPABASE_ANON_KEY` | 공개 키 (Project Settings > API 의 anon 또는 publishable) | `pages.yml` 이 배포본의 `web/config.js` 에 넣음 |
| GitHub > Settings > Secrets > Actions | `SUPABASE_SERVICE_ROLE_KEY` | 서비스 키 (service_role 또는 secret) | `embed-bills.yml` 이 임베딩을 넣을 때 |
| GitHub > Settings > Secrets > Actions | `SUPABASE_URL` (선택) | 프로젝트 주소 | 없으면 위 주소를 씀 |
| Vercel > ppaegok-api > Settings > Environment Variables | `SUPABASE_URL` | 프로젝트 주소 | `/api/similar`, 에이전트 실행 기록 |
| Vercel > ppaegok-api > Settings > Environment Variables | `SUPABASE_SERVICE_ROLE_KEY` | 서비스 키 | `server/lib/similar.js`, `server/lib/runs.js` |

- 키를 넣은 뒤 Pages 는 **다시 배포**해야 화면에 반영됩니다 (Actions > Deploy web prototype to GitHub Pages > Run workflow).
- Vercel 은 환경변수를 바꾼 뒤 Redeploy 해야 반영됩니다.
- 임베딩은 Actions > Bill embeddings (pgvector) > Run workflow 에서 `all` 을 켜고 한 번 돌리면 전부 들어갑니다. 그 뒤로는 매일 07:30 에 새·바뀐 법안만 넣습니다.

## 화면에서

- 행정 화면 > 진행 현황 맨 위에 로그인 상자가 생깁니다. 이메일을 넣고 "로그인 링크 받기"를 누른 뒤, **같은 브라우저**에서 메일의 링크를 엽니다.
- 담당자: 진행 상태·메모를 저장하면 구성원 모두에게 바로 보입니다. 처음 로그인하면 "이 브라우저 기록 가져오기"로 예전 기록을 올릴 수 있습니다.
- 결재자: 읽기 전용입니다. 법안 상세와 "결재 대기 목록"에서 결재 버튼을 누릅니다.
- 다른 사람의 이메일은 화면에 아이디 앞 두 글자만 보입니다 (예: `ab***`). 본인 이메일만 머리글에 그대로 보입니다.
- 연결이 안 되거나 로그인 전이면 예전처럼 이 브라우저에만 저장하고, 진행 현황에 그렇다고 짧게 표시합니다.
- 상황판의 "검토 에이전트 초안" 카드는 `agent_run_stats()` 집계만 읽습니다 (로그인 불필요). 기록이 없으면 "기록 없음", 불러오지 못하면 카드를 그리지 않습니다.

## 보안 정리

- **모든 표에 RLS** 를 켰습니다. 공개 키로 할 수 있는 일은 정책과 `security definer` 함수가 허락한 것뿐입니다.
- 브라우저에는 **공개(anon/publishable) 키만** 들어갑니다. 서비스 키는 Vercel 환경변수와 GitHub Actions secrets 에만 둡니다.
- 역할은 `members` 표로만 정합니다. 화면의 "역할 고르기"(첫 화면 안내)는 권한과 무관합니다.
- 결재는 `approve_review()` 함수로만 됩니다 (마이그레이션 002 이후 담당자가 결재 열을 직접 바꿔도 트리거가 되돌림).
- 메모에는 개인정보를 넣지 않도록 화면이 전화번호·주민번호·이메일 모양을 막습니다 (DB 에는 300자 제한만 있음).
- 화면은 supabase-js 를 고정 버전(2.45.4)과 무결성 해시(SRI)로 받습니다. 키가 없으면 받지도 않습니다.

## 기관 내부 DB 로 바꿀 때

- 같은 `schema.sql` 을 내부 PostgreSQL(+ pgvector) 에 적용하고, 로그인은 기관 SSO 로 바꿉니다 (`auth.jwt() ->> 'email'` 을 쓰는 곳만 고치면 됨).
- 화면은 `web/cloud.js` 한 파일만 바꾸면 됩니다 (`admin.js` 와는 `Cloud.*` 연결부로만 이어짐).
- 서버는 `server/lib/supabase.js` 의 주소·헤더만 바꾸면 됩니다 (PostgREST 형식).
