-- ============================================================================
-- LEVEL 6 — meaning (embeddings), the thought graph, and no duplicates.
-- Embeddings use Supabase's built-in gte-small model: 384 numbers per thought.
-- ============================================================================

-- 0. NO DUPLICATES -----------------------------------------------------------
-- The database itself refuses a second identical thought — the only place this
-- can be done without a race between "check" and "save".
alter table thoughts add column if not exists dedup_key text;

create or replace function thoughts_set_dedup_key()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'INSERT' then
    if new.dedup_key is null then
      new.dedup_key := md5(new.content);
    end if;
  elsif TG_OP = 'UPDATE' and new.content is distinct from old.content then
    if old.dedup_key = md5(old.content) then
      new.dedup_key := md5(new.content);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_thoughts_set_dedup_key on thoughts;
create trigger trg_thoughts_set_dedup_key
  before insert or update of content on thoughts
  for each row execute function thoughts_set_dedup_key();

-- Existing rows: the oldest copy of any text keeps the plain key; any later
-- copy gets its own key so this never fails on duplicates already saved.
with ranked as (
  select id, md5(content) as h,
         row_number() over (partition by user_id, md5(content) order by created_at, id) as rn
  from thoughts where dedup_key is null
)
update thoughts t
   set dedup_key = case when r.rn = 1 then r.h else r.h || '-' || t.id::text end
  from ranked r where r.id = t.id;

create unique index if not exists idx_thoughts_dedup_key
  on thoughts (dedup_key, user_id) nulls not distinct;

-- 1. MEANING: an embedding column + a fast index for "nearest" lookups --------
create extension if not exists vector;

alter table thoughts add column if not exists embedding vector(384);

create index if not exists idx_thoughts_embedding
  on thoughts using hnsw (embedding vector_cosine_ops);

-- 2. SEARCH BY MEANING ---------------------------------------------------------
-- Signed in to the app, row-level security already limits this to your own
-- thoughts. Server functions use the master key (which skips those rules), so
-- they must pass p_user_id.
create or replace function search_thoughts(
  query_embedding vector(384),
  match_threshold float default 0.75,
  match_count int default 10,
  p_user_id uuid default null
)
returns table (
  id uuid, content text, created_at timestamptz,
  category text, tags text[], summary text, similarity float
)
language plpgsql stable as $$
begin
  return query
    select t.id, t.content, t.created_at, t.category, t.tags, t.summary,
           (1 - (t.embedding <=> query_embedding))::float as similarity
      from thoughts t
     where t.embedding is not null
       and (p_user_id is null or t.user_id = p_user_id)
       and (1 - (t.embedding <=> query_embedding)) > match_threshold
     order by t.embedding <=> query_embedding
     limit match_count;
end;
$$;
revoke execute on function search_thoughts(vector, float, int, uuid) from public, anon;
grant execute on function search_thoughts(vector, float, int, uuid) to authenticated, service_role;

-- 3. THE GRAPH: links between thoughts that mean similar things ---------------
create table if not exists thought_links (
  id uuid default gen_random_uuid() primary key,
  source_thought_id uuid not null references thoughts(id) on delete cascade,
  target_thought_id uuid not null references thoughts(id) on delete cascade,
  similarity_score float not null,
  link_type text not null default 'semantic',
  created_at timestamptz default now()
);
alter table thought_links add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- One link per pair, whichever direction it was made in (A→B blocks B→A)
create unique index if not exists idx_thought_links_pair
  on thought_links(source_thought_id, target_thought_id);
create unique index if not exists idx_thought_links_canonical
  on thought_links (least(source_thought_id::text, target_thought_id::text),
                    greatest(source_thought_id::text, target_thought_id::text));
create index if not exists idx_thought_links_source on thought_links(source_thought_id);
create index if not exists idx_thought_links_target on thought_links(target_thought_id);
create index if not exists idx_thought_links_user on thought_links(user_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'no_self_links') then
    alter table thought_links add constraint no_self_links check (source_thought_id != target_thought_id);
  end if;
end $$;

-- Same rule as everywhere since Level 2: only the owner can see or change links.
alter table thought_links enable row level security;
drop policy if exists "own_links_select" on thought_links;
create policy "own_links_select" on thought_links for select to authenticated using (auth.uid() = user_id);
drop policy if exists "own_links_insert" on thought_links;
create policy "own_links_insert" on thought_links for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "own_links_delete" on thought_links;
create policy "own_links_delete" on thought_links for delete to authenticated using (auth.uid() = user_id);

-- Nearest neighbors of one thought, for auto-linking. VOLATILE so it always
-- sees the thought that was saved a moment ago.
create or replace function find_links_for_thought(
  source_id uuid,
  source_embedding vector(384),
  p_user_id uuid,
  match_threshold float default 0.82,
  match_count int default 5
)
returns table (target_id uuid, similarity float)
language plpgsql volatile as $$
begin
  return query
    select t.id as target_id, (1 - (t.embedding <=> source_embedding))::float as similarity
      from thoughts t
     where t.id != source_id
       and t.user_id = p_user_id
       and t.embedding is not null
       and (t.category is distinct from 'digest')
       and (1 - (t.embedding <=> source_embedding)) > match_threshold
     order by t.embedding <=> source_embedding
     limit match_count;
end;
$$;
revoke execute on function find_links_for_thought(uuid, vector, uuid, float, int) from public, anon, authenticated;
grant execute on function find_links_for_thought(uuid, vector, uuid, float, int) to service_role;
