-- 002: schema.sql(001, 이미 적용) 뒤에 실행한다. Supabase SQL 편집기에 그대로 붙여 넣으면 된다.
--
-- 1) 결재 가로채기 막기
--    001 의 rp_stamp 는 "상태·메모가 그대로이고 approved 만 false → true" 인 update 를 결재로 보고 통과시켰다.
--    그런데 담당자도 review_progress 를 update 할 수 있으므로 (rp_update 정책)
--    담당자가 update review_progress set approved = true ... 를 직접 보내면 스스로 결재한 것처럼 된다.
--    또 이미 결재된 법안을 다시 결재하면 (old.approved = true) 이 조건에 걸리지 않아
--    수정자가 결재자로 바뀌고 결재가 풀리는 문제도 있었다.
--    → 결재 함수 안에서만 켜지는 표시(ppaegok.approving)가 있을 때만 결재 열 변경을 통과시킨다.
--      표시는 set_config(..., true) 라 그 트랜잭션(요청 한 번) 안에서만 살아 있고,
--      PostgREST 로는 클라이언트가 이 값을 직접 바꿀 수 없다.
--
-- 2) 임베딩 갱신 판단용 열
--    bill_embeddings.text_hash: 임베딩을 만든 요약문의 sha256. collect/embed_bills.py 가
--    요약문이 바뀐 법안만 다시 계산하는 데 쓴다. (열이 없어도 스크립트는 "없는 법안만" 방식으로 동작한다)

create or replace function public.rp_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and current_setting('ppaegok.approving', true) = 'on' then
    -- approve_review 가 결재 열만 바꾸는 경우. 상태·메모·수정자는 그대로 둔다
    new.status := old.status; new.memo := old.memo;
    new.editor := old.editor; new.updated_at := old.updated_at;
    return new;
  end if;
  new.editor := lower(auth.jwt() ->> 'email');
  new.updated_at := now();
  new.approved := false; new.approved_by := null; new.approved_at := null;
  return new;
end $$;

create or replace function public.approve_review(p_bill_no text) returns void
language plpgsql security definer set search_path = public as $$
declare
  who text := lower(auth.jwt() ->> 'email');
  n int;
begin
  if public.my_role() is distinct from '결재자' then
    raise exception '결재자만 결재할 수 있습니다';
  end if;
  perform set_config('ppaegok.approving', 'on', true);
  update public.review_progress
     set approved = true, approved_by = who, approved_at = now()
   where bill_no = p_bill_no;
  get diagnostics n = row_count;  -- perform 도 FOUND 를 바꾸므로 행 수를 먼저 받아 둔다
  perform set_config('ppaegok.approving', 'off', true);
  if n = 0 then raise exception '진행 기록이 없는 법안입니다'; end if;
  insert into public.review_log (bill_no, action, actor) values (p_bill_no, '결재', who);
end $$;
revoke all on function public.approve_review(text) from public, anon;
grant execute on function public.approve_review(text) to authenticated;

alter table public.bill_embeddings add column if not exists text_hash text;
