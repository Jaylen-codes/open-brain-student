-- ============================================================================
-- LEVEL 5 — agents. Run this once in the Supabase SQL Editor.
-- ============================================================================

-- 1. RECEIPTS: one row per AI call, with what it cost ------------------------
create table if not exists llm_usage (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  kind              text not null default 'chat',
  model             text,
  source            text,
  prompt_tokens     integer default 0,
  completion_tokens integer default 0,
  cost_usd          numeric(12,8) default 0,
  created_at        timestamptz not null default now()
);
create index if not exists idx_usage_user_time on llm_usage(user_id, created_at desc);
alter table llm_usage enable row level security;
drop policy if exists "own_usage_select" on llm_usage;
create policy "own_usage_select" on llm_usage
  for select to authenticated using (auth.uid() = user_id);

-- my_spend(): your totals. Signed in to the app it shows only your own calls;
-- here in the SQL Editor (as the database owner) it totals everything.
create or replace function my_spend()
returns table (month_usd numeric, month_calls bigint, total_usd numeric, total_calls bigint)
language plpgsql stable as $$
begin
  return query
    select
      coalesce(sum(u.cost_usd) filter (where u.created_at >= date_trunc('month', now())), 0)::numeric,
      count(*) filter (where u.created_at >= date_trunc('month', now()))::bigint,
      coalesce(sum(u.cost_usd), 0)::numeric,
      count(*)::bigint
    from llm_usage u
    where auth.uid() is null or u.user_id = auth.uid();
end;
$$;
-- Strangers (not signed in) can't ask for totals at all.
revoke execute on function my_spend() from public, anon;
grant execute on function my_spend() to authenticated;

-- 2. NEW COLUMNS for the tagging agent ---------------------------------------
alter table thoughts
  add column if not exists tags text[] default '{}',
  add column if not exists category text,
  add column if not exists summary text,
  add column if not exists enriched_at timestamptz;

-- 3. TRIGGER: every new thought calls the tagging agent ----------------------
-- (pg_net lets the database make web requests; without it nothing happens.)
create extension if not exists pg_net;

create or replace function enrich_new_thought()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url := 'https://eompdnlidiaqivakumez.supabase.co/functions/v1/enrich-thought',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('id', new.id)
  );
  return new;
end;
$$;

drop trigger if exists enrich_on_insert on thoughts;
create trigger enrich_on_insert
  after insert on thoughts
  for each row execute function enrich_new_thought();

-- 4. SCHEDULE: weekly digest, Sundays 8:00am Mountain time (14:00 UTC) --------
create extension if not exists pg_cron;
grant usage on schema cron to postgres;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'weekly-brain-digest') then
    perform cron.unschedule('weekly-brain-digest');
  end if;
end $$;

select cron.schedule(
  'weekly-brain-digest',
  '0 14 * * 0',
  $CRON$
    select net.http_post(
      url := 'https://eompdnlidiaqivakumez.supabase.co/functions/v1/weekly-digest',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb
    );
  $CRON$
);

-- 5. CATCH UP: tag the thoughts you saved before today (about 2 cents at most)
select net.http_post(
  url := 'https://eompdnlidiaqivakumez.supabase.co/functions/v1/enrich-thought',
  headers := '{"Content-Type": "application/json"}'::jsonb,
  body := jsonb_build_object('id', id)
)
from thoughts
where enriched_at is null
order by created_at desc
limit 100;

-- Show what's scheduled
select jobname, schedule from cron.job order by jobname;
