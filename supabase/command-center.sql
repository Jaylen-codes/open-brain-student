-- ============================================================================
-- COMMAND CENTER — the map of your AI system, your Board of Directors, and
-- the coach that watches over all of it.
-- ============================================================================
-- Run this ONCE in Supabase → SQL Editor (after Levels 1–7). Safe to re-run.
--
--   cc_nodes        everything on the map: agents, sections, board members
--   cc_connections  what each node can reach (Zendesk, GitHub, a bank, ...)
--   cc_reviews      every verdict the Board has given
--   cc_chat         your conversation with the Coach
--
-- Every table is locked to its owner: you only ever see your own rows.
-- ============================================================================

-- 1. NODES --------------------------------------------------------------------
create table if not exists cc_nodes (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind         text not null check (kind in ('agent', 'section', 'board')),
  name         text not null,
  emoji        text default '🤖',
  color        text default '#22d3ee',
  description  text default '',
  status       text not null default 'planned'
               check (status in ('active', 'building', 'planned', 'paused')),
  runs_on      text default '',          -- "Claude Code", "Claude Project", "Zapier" ...
  instructions text default '',          -- what this agent does / how a board member judges
  parent_id    uuid references cc_nodes(id) on delete set null,   -- an agent inside a section
  sort         int default 0,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

-- 2. CONNECTIONS — "what can this thing access?" -------------------------------
create table if not exists cc_connections (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  node_id    uuid not null references cc_nodes(id) on delete cascade,
  system     text not null,                       -- "Zendesk", "GitHub", "Open Brain" ...
  access     text not null default 'read'
             check (access in ('read', 'write', 'read/write', 'admin')),
  detail     text default '',                     -- "tickets + macros", "repo: 5star-site"
  url        text default '',
  created_at timestamptz default now()
);

-- 3. BOARD REVIEWS -------------------------------------------------------------
create table if not exists cc_reviews (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  member_id   uuid references cc_nodes(id) on delete set null,   -- which board member
  node_id     uuid references cc_nodes(id) on delete cascade,    -- what was reviewed (if a node)
  thought_id  uuid references thoughts(id) on delete cascade,    -- or a thought
  subject     text not null,
  verdict     text,             -- aligned | caution | conflict  (or pass | risk | fail)
  score       int,              -- 1–10
  summary     text,
  feedback    jsonb default '{}'::jsonb,   -- concerns, suggestions, references, questions
  created_at  timestamptz default now()
);

-- 4. COACH CHAT ---------------------------------------------------------------
create table if not exists cc_chat (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  created_at timestamptz default now()
);

create index if not exists idx_cc_nodes_user on cc_nodes (user_id, kind, sort);
create index if not exists idx_cc_conn_node on cc_connections (node_id);
create index if not exists idx_cc_reviews_user on cc_reviews (user_id, created_at desc);
create index if not exists idx_cc_chat_user on cc_chat (user_id, created_at desc);

-- 5. SECURITY: owner-only, on every table ---------------------------------------
alter table cc_nodes enable row level security;
alter table cc_connections enable row level security;
alter table cc_reviews enable row level security;
alter table cc_chat enable row level security;

do $$
declare t text;
begin
  foreach t in array array['cc_nodes', 'cc_connections'] loop
    execute format('drop policy if exists "own_rows" on %I', t);
    execute format('create policy "own_rows" on %I for all to authenticated
                    using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
  end loop;
  -- Reviews and chat are WRITTEN only by the server functions (they hold the
  -- AI key). You can read them and delete them, never forge them.
  foreach t in array array['cc_reviews', 'cc_chat'] loop
    execute format('drop policy if exists "own_select" on %I', t);
    execute format('create policy "own_select" on %I for select to authenticated using (auth.uid() = user_id)', t);
    execute format('drop policy if exists "own_delete" on %I', t);
    execute format('create policy "own_delete" on %I for delete to authenticated using (auth.uid() = user_id)', t);
  end loop;
end $$;

-- Keep updated_at honest
create or replace function cc_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;
drop trigger if exists trg_cc_nodes_touch on cc_nodes;
create trigger trg_cc_nodes_touch before update on cc_nodes
  for each row execute function cc_touch();

-- 6. LIVE UPDATES: the map redraws itself the moment anything changes ----------
do $$
declare t text;
begin
  foreach t in array array['cc_nodes', 'cc_connections', 'cc_reviews', 'cc_chat', 'thoughts'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and tablename = t) then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end $$;

-- 7. SCHEDULE: the Finance board member's market brief, weekdays 7:12am Mountain
--    (13:12 UTC; markets open 7:30am Mountain). Change the time to suit you.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'daily-market-brief') then
    perform cron.unschedule('daily-market-brief');
  end if;
end $$;

select cron.schedule(
  'daily-market-brief',
  '12 13 * * 1-5',
  $CRON$
    select net.http_post(
      url := 'https://eompdnlidiaqivakumez.supabase.co/functions/v1/market-brief',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb
    );
  $CRON$
);

select jobname, schedule from cron.job order by jobname;
