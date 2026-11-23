-- 빼곡 Supabase 스키마 (시연용 클라우드 DB, 실제 도입 시 기관 내부 DB로 교체)
-- 브라우저는 anon 키만 쓰므로 모든 표에 RLS 를 켜고, 쓰기는 정책·함수로만 허용한다.
-- 이메일 로그인·members 부분은 migrations/003_no_login.sql 이 걷어 낸다 (브라우저는 읽기만, 쓰기는 서버 service_role).

create extension if not exists vector;

-- 1) 구성원: 로그인 이메일과 역할 (담당자 / 결재자). 관리자가 SQL 로 직접 넣는다.
create table if not exists public.members (
  email text primary key,
  role text not null check (role in ('담당자', '결재자')),
  created_at timestamptz not null default now()
);
alter table public.members enable row level security;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where email = lower(auth.jwt() ->> 'email')
$$;

drop policy if exists members_self on public.members;
create policy members_self on public.members for select to authenticated
  using (email = lower(auth.jwt() ->> 'email'));

-- 2) 검토 진행 상황 (법안별 한 줄)
create table if not exists public.review_progress (
  bill_no text primary key,
  status text not null,
  memo text not null default '' check (char_length(memo) <= 300),
  editor text,
  updated_at timestamptz not null default now(),
  approved boolean not null default false,
  approved_by text,
  approved_at timestamptz
);
alter table public.review_progress enable row level security;

drop policy if exists rp_read on public.review_progress;
create policy rp_read on public.review_progress for select to authenticated
  using (public.my_role() is not null);
drop policy if exists rp_insert on public.review_progress;
create policy rp_insert on public.review_progress for insert to authenticated
  with check (public.my_role() = '담당자');
drop policy if exists rp_update on public.review_progress;
create policy rp_update on public.review_progress for update to authenticated
  using (public.my_role() = '담당자') with check (public.my_role() = '담당자');


-- 3) 변경 기록 (트리거와 결재 함수만 쓴다)
create table if not exists public.review_log (
  id bigint generated always as identity primary key,
  bill_no text not null,
  action text not null,
  status text,
  memo text,
  actor text,
  at timestamptz not null default now()
);
alter table public.review_log enable row level security;
drop policy if exists rl_read on public.review_log;
create policy rl_read on public.review_log for select to authenticated
  using (public.my_role() is not null);

create or replace function public.rp_log() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.review_log (bill_no, action, status, memo, actor)
  values (new.bill_no, case when tg_op = 'INSERT' then '등록' else '수정' end, new.status, new.memo, new.editor);
  return null;
end $$;
drop trigger if exists rp_log on public.review_progress;
create trigger rp_log after insert or update of status, memo on public.review_progress
  for each row execute function public.rp_log();

-- 결재자는 표를 직접 고칠 수 없고 이 함수로만 결재한다
create or replace function public.approve_review(p_bill_no text) returns void
language plpgsql security definer set search_path = public as $$
declare who text := lower(auth.jwt() ->> 'email');
begin
  if public.my_role() is distinct from '결재자' then
    raise exception '결재자만 결재할 수 있습니다';
  end if;
  update public.review_progress
     set approved = true, approved_by = who, approved_at = now()
   where bill_no = p_bill_no;
  if not found then raise exception '진행 기록이 없는 법안입니다'; end if;
  insert into public.review_log (bill_no, action, actor) values (p_bill_no, '결재', who);
end $$;
revoke all on function public.approve_review(text) from public, anon;
grant execute on function public.approve_review(text) to authenticated;

-- 담당자가 저장하면 수정자·시각을 서버가 채우고 결재를 다시 받게 한다.
-- 결재 함수의 update(결재만 바뀜)는 그대로 통과시킨다.
create or replace function public.rp_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status
     and new.memo is not distinct from old.memo and new.approved and not old.approved then
    return new;  -- 결재만 바뀐 경우
  end if;
  new.editor := lower(auth.jwt() ->> 'email');
  new.updated_at := now();
  new.approved := false; new.approved_by := null; new.approved_at := null;
  return new;
end $$;

drop trigger if exists rp_stamp on public.review_progress;
create trigger rp_stamp before insert or update on public.review_progress
  for each row execute function public.rp_stamp();

-- 실시간 반영
do $$ begin
  alter publication supabase_realtime add table public.review_progress;
exception when duplicate_object then null; end $$;

-- 4) 비슷한 법안 (pgvector). 공개 법안 요약문의 임베딩이라 읽기는 누구나, 쓰기는 서버(service_role)만.
create table if not exists public.bill_embeddings (
  bill_no text primary key,
  law text,
  embedding vector(384) not null,
  model text not null,
  updated_at timestamptz not null default now()
);
alter table public.bill_embeddings enable row level security;
drop policy if exists be_read on public.bill_embeddings;
create policy be_read on public.bill_embeddings for select to anon, authenticated using (true);
create index if not exists bill_embeddings_hnsw on public.bill_embeddings
  using hnsw (embedding vector_cosine_ops);

create or replace function public.similar_bills(p_bill_no text, k int default 5)
returns table (bill_no text, law text, similarity float)
language sql stable set search_path = public as $$
  select b.bill_no, b.law, 1 - (b.embedding <=> q.embedding) as similarity
    from public.bill_embeddings b,
         (select embedding from public.bill_embeddings where bill_no = p_bill_no) q
   where b.bill_no <> p_bill_no
   order by b.embedding <=> q.embedding
   limit least(greatest(k, 1), 20)
$$;
grant execute on function public.similar_bills(text, int) to anon, authenticated;

-- 5) 에이전트 실행 기록 (서버가 service_role 로 넣음). 화면에는 집계만 공개.
create table if not exists public.agent_runs (
  id bigint generated always as identity primary key,
  bill_no text not null,
  mode text not null default 'agent',
  steps int not null,
  tokens int not null,
  human_edited boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.agent_runs enable row level security;
drop policy if exists ar_read on public.agent_runs;
create policy ar_read on public.agent_runs for select to authenticated
  using (public.my_role() is not null);

-- 담당자가 진행 상황을 저장하면 그 법안의 AI 초안은 "사람이 수정함"으로 표시
create or replace function public.mark_human_edit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.my_role() = '담당자' then
    update public.agent_runs set human_edited = true where bill_no = new.bill_no;
  end if;
  return null;
end $$;
drop trigger if exists rp_human_edit on public.review_progress;
create trigger rp_human_edit after insert or update of status, memo on public.review_progress
  for each row execute function public.mark_human_edit();

create or replace function public.agent_run_stats()
returns table (bills bigint, edited bigint)
language sql stable security definer set search_path = public as $$
  select count(distinct bill_no), count(distinct bill_no) filter (where human_edited)
    from public.agent_runs
$$;
grant execute on function public.agent_run_stats() to anon, authenticated;
