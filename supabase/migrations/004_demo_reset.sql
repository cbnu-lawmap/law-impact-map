-- 004: 시연 초기화 (003_no_login.sql 뒤에 실행. Supabase SQL 편집기에 그대로 붙여 넣으면 된다)
--
-- 시연 전용. 발표·시연 전에 진행 기록과 결재 기록을 비워 처음 상태로 되돌린다.
-- 실제 도입 시에는 이 함수를 두지 않는다 (기관 내부 DB 의 기록은 지우지 않고 보존).
--
--   progress_reset()  review_progress, review_log 의 모든 줄을 지우고,
--                     agent_runs 는 줄을 남긴 채 human_edited 만 false 로 되돌린다 ("AI 초안 N건 중 사람 수정 0건").
--                     지운 줄 수를 돌려준다: { progress, log, runs_reset }
--   security definer 이고 실행 권한은 service_role 에만 준다.
--   서버 /api/progress 의 action "reset" (확인 문구 "초기화", 1분 2회) 만 이 함수를 부른다.
--
-- 여러 번 실행해도 같은 결과가 되도록 썼다 (create or replace).

begin;

create or replace function public.progress_reset()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  n_progress integer;
  n_log integer;
  n_runs integer;
begin
  -- where true: delete 에 조건을 요구하는 설정(safeupdate)이 켜져 있어도 돌도록
  delete from public.review_progress where true;
  get diagnostics n_progress = row_count;
  delete from public.review_log where true;
  get diagnostics n_log = row_count;
  update public.agent_runs set human_edited = false where human_edited;
  get diagnostics n_runs = row_count;
  return jsonb_build_object('progress', n_progress, 'log', n_log, 'runs_reset', n_runs);
end $$;

revoke all on function public.progress_reset() from public, anon, authenticated;
grant execute on function public.progress_reset() to service_role;

commit;
