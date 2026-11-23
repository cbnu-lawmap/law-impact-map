-- 003: 로그인 없이 검토 진행 공유 (schema.sql(001) + 002 뒤에 실행. Supabase SQL 편집기에 그대로 붙여 넣으면 된다)
--
-- 시연용: 로그인 없이 역할을 고르는 방식. 실제 도입 시 기관 통합로그인(SSO)·공무원 인증서(GPKI)와 연동
--
-- 바뀌는 것
--   1) 브라우저(anon / authenticated)는 review_progress · review_log 를 읽기만 한다.
--      모든 표에서 insert / update / delete 권한을 거두고, 예전 쓰기 정책(rp_insert, rp_update)을 지운다.
--   2) 쓰기는 서버(/api/progress, Vercel)가 service_role 키로 아래 두 함수만 부른다.
--        progress_set(p_bill_no, p_status, p_memo, p_actor)       담당자: 진행 상태·메모 저장
--        progress_decide(p_bill_no, p_decision, p_reason, p_actor) 결재자: 승인 / 반려
--      두 함수는 security definer 이고 실행 권한은 service_role 에만 준다.
--      저장과 review_log 기록이 한 함수(한 트랜잭션) 안에서 함께 일어난다.
--   3) 담당자가 상태나 메모를 바꾸면 승인·반려가 풀려 다시 결재를 받는다 (rp_stamp 트리거, 001·002 와 같은 규칙).
--   4) 이메일 로그인과 members 표를 없앤다.
--      members 에는 로그인 이메일(개인정보)만 들어 있었고 이제 어디서도 쓰지 않으므로, 남겨 두지 않고 지운다 (최소 수집).
--      예전 기록에 남은 이메일(editor, approved_by, review_log.actor)은 아이디 앞 두 글자 + *** 로 가린다.
--      review_progress · review_log 를 누구나 읽게 되므로, 가리지 않으면 이메일이 공개된다.
--   5) agent_runs 는 브라우저에서 직접 읽지 않는다 (집계 함수 agent_run_stats() 만 공개, 그대로).
--   6) 실시간(Realtime) 발행은 그대로 둔다.
--
-- 여러 번 실행해도 같은 결과가 되도록 썼다 (if exists / if not exists / create or replace).

begin;

-- ------------------------------------------------------------------ 1. 예전 트리거를 잠시 떼기
-- (아래에서 예전 이메일을 가릴 때 수정자·시각·결재가 바뀌지 않게 먼저 뗀다. 4번에서 다시 단다)
drop trigger if exists rp_log on public.review_progress;
drop trigger if exists rp_stamp on public.review_progress;
drop trigger if exists rp_human_edit on public.review_progress;
drop function if exists public.rp_log();

-- ------------------------------------------------------------------ 2. 열 더하기
alter table public.review_progress add column if not exists decision text;
alter table public.review_progress add column if not exists decision_by text;
alter table public.review_progress add column if not exists decision_reason text;
alter table public.review_progress add column if not exists decided_at timestamptz;

do $$ begin
  alter table public.review_progress add constraint rp_decision_chk check (decision in ('승인', '반려'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.review_progress add constraint rp_reason_chk check (char_length(decision_reason) <= 100);
exception when duplicate_object then null; end $$;
do $$ begin
  -- 예전 줄이 다른 값을 갖고 있어도 실패하지 않게 not valid (새로 쓰는 줄부터 검사)
  alter table public.review_progress add constraint rp_status_chk check (status in ('todo', 'doing', 'hold', 'done')) not valid;
exception when duplicate_object then null; end $$;

-- 예전 결재(approved)는 "승인"으로 옮긴다
update public.review_progress
   set decision = '승인', decision_by = approved_by, decided_at = approved_at
 where approved and decision is null;

-- ------------------------------------------------------------------ 3. 예전 이메일 가리기 (누구나 읽게 되므로)
update public.review_progress set editor = left(split_part(editor, '@', 1), 2) || '***' where editor like '%@%';
update public.review_progress set approved_by = left(split_part(approved_by, '@', 1), 2) || '***' where approved_by like '%@%';
update public.review_progress set decision_by = left(split_part(decision_by, '@', 1), 2) || '***' where decision_by like '%@%';
update public.review_log set actor = left(split_part(actor, '@', 1), 2) || '***' where actor like '%@%';

-- ------------------------------------------------------------------ 4. 트리거 다시 달기
-- 저장하면 시각을 채우고 승인·반려를 푼다. progress_decide 안에서만 켜지는 표시(ppaegok.deciding)가 있으면
-- 결재 열만 바꾸고 상태·메모·수정자·시각은 그대로 둔다. (표시는 set_config(..., true) 라 그 트랜잭션 안에서만 산다)
create or replace function public.rp_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and current_setting('ppaegok.deciding', true) = 'on' then
    new.status := old.status; new.memo := old.memo;
    new.editor := old.editor; new.updated_at := old.updated_at;
    return new;
  end if;
  new.updated_at := now();
  new.approved := false; new.approved_by := null; new.approved_at := null;
  new.decision := null; new.decision_by := null; new.decision_reason := null; new.decided_at := null;
  return new;
end $$;
create trigger rp_stamp before insert or update on public.review_progress
  for each row execute function public.rp_stamp();

-- 진행 상태·메모를 저장하면 그 법안의 AI 초안은 "사람이 수정함" (예전에는 members 로 담당자인지 봤다)
create or replace function public.mark_human_edit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.agent_runs set human_edited = true where bill_no = new.bill_no;
  return null;
end $$;
create trigger rp_human_edit after insert or update of status, memo on public.review_progress
  for each row execute function public.mark_human_edit();

-- ------------------------------------------------------------------ 5. 쓰기 함수 (service_role 만 실행)
create or replace function public.progress_set(p_bill_no text, p_status text, p_memo text, p_actor text)
returns public.review_progress
language plpgsql security definer set search_path = public as $$
declare
  old_row public.review_progress;
  r public.review_progress;
begin
  p_memo := coalesce(p_memo, '');
  p_actor := btrim(coalesce(p_actor, ''));
  if p_bill_no is null or p_bill_no !~ '^[0-9]{7}$' then raise exception '의안번호는 7자리 숫자여야 합니다'; end if;
  if p_status is null or p_status not in ('todo', 'doing', 'hold', 'done') then raise exception '진행 상태 값이 올바르지 않습니다'; end if;
  if char_length(p_memo) > 300 then raise exception '메모는 300자까지입니다'; end if;
  if char_length(p_actor) < 1 or char_length(p_actor) > 20 then raise exception '이름은 1~20자여야 합니다'; end if;

  select * into old_row from public.review_progress where bill_no = p_bill_no for update;
  if found and old_row.status = p_status and old_row.memo = p_memo then
    return old_row;  -- 바뀐 것이 없으면 쓰지 않는다 (결재도 그대로)
  end if;

  insert into public.review_progress (bill_no, status, memo, editor)
  values (p_bill_no, p_status, p_memo, p_actor)
  on conflict (bill_no) do update set status = excluded.status, memo = excluded.memo, editor = excluded.editor
  returning * into r;

  insert into public.review_log (bill_no, action, status, memo, actor)
  values (p_bill_no, case when old_row.bill_no is null then '등록' else '수정' end, p_status, p_memo, p_actor || ' (담당자)');
  return r;
end $$;

create or replace function public.progress_decide(p_bill_no text, p_decision text, p_reason text, p_actor text)
returns public.review_progress
language plpgsql security definer set search_path = public as $$
declare
  cur public.review_progress;
  r public.review_progress;
  why text;
begin
  p_actor := btrim(coalesce(p_actor, ''));
  if p_decision is null or p_decision not in ('승인', '반려') then raise exception '결재는 승인 또는 반려만 됩니다'; end if;
  if char_length(p_actor) < 1 or char_length(p_actor) > 20 then raise exception '이름은 1~20자여야 합니다'; end if;
  why := case when p_decision = '반려' then nullif(btrim(coalesce(p_reason, '')), '') end;
  if char_length(why) > 100 then raise exception '반려 사유는 100자까지입니다'; end if;

  select * into cur from public.review_progress where bill_no = p_bill_no for update;
  if not found then raise exception '진행 기록이 없는 법안입니다'; end if;
  if cur.status <> 'done' then raise exception '검토 완료된 법안만 결재할 수 있습니다'; end if;
  if cur.decision is not null then raise exception '이미 결재한 법안입니다'; end if;

  perform set_config('ppaegok.deciding', 'on', true);
  update public.review_progress
     set decision = p_decision, decision_by = p_actor, decision_reason = why, decided_at = now(),
         approved = (p_decision = '승인'),
         approved_by = case when p_decision = '승인' then p_actor end,
         approved_at = case when p_decision = '승인' then now() end
   where bill_no = p_bill_no
  returning * into r;
  perform set_config('ppaegok.deciding', 'off', true);

  insert into public.review_log (bill_no, action, status, memo, actor)
  values (p_bill_no, p_decision, cur.status, why, p_actor || ' (결재자)');
  return r;
end $$;

revoke all on function public.progress_set(text, text, text, text) from public, anon, authenticated;
revoke all on function public.progress_decide(text, text, text, text) from public, anon, authenticated;
grant execute on function public.progress_set(text, text, text, text) to service_role;
grant execute on function public.progress_decide(text, text, text, text) to service_role;

-- ------------------------------------------------------------------ 6. 읽기 정책 (브라우저는 읽기만)
drop policy if exists rp_read on public.review_progress;
drop policy if exists rp_insert on public.review_progress;
drop policy if exists rp_update on public.review_progress;
create policy rp_read on public.review_progress for select to anon, authenticated using (true);

drop policy if exists rl_read on public.review_log;
create policy rl_read on public.review_log for select to anon, authenticated using (true);

drop policy if exists ar_read on public.agent_runs;  -- 화면에는 agent_run_stats() 집계만

-- 예전 결재 함수·역할 함수·구성원 표 지우기 (정책을 먼저 지웠으므로 남은 의존 없음)
drop function if exists public.approve_review(text);
drop function if exists public.my_role();
drop table if exists public.members;

-- 모든 표에서 브라우저 쪽 쓰기 권한 거두기 (RLS 정책이 없어도 한 번 더 막는다)
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t.tablename);
  end loop;
end $$;
alter default privileges in schema public revoke insert, update, delete, truncate on tables from anon, authenticated;
grant select on public.review_progress, public.review_log to anon, authenticated;

-- ------------------------------------------------------------------ 7. 실시간 반영 (그대로)
do $$ begin
  alter publication supabase_realtime add table public.review_progress;
exception when duplicate_object then null; end $$;

commit;
