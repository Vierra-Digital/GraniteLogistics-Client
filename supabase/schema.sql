-- Granite Logistics — Supabase schema
-- Run this in the Supabase dashboard → SQL Editor.
-- Model: one JSON "workspace" blob per tenant (matches the app's Cloud Sync state).

create table if not exists public.workspaces (
  tenant      text primary key,
  data        jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table public.workspaces enable row level security;

-- ---------------------------------------------------------------------------
-- DEFAULT: browser-direct mode (works on Netlify with no server).
-- The app talks to Supabase REST with the public anon key, so we allow anon
-- to read/write workspace rows. Security note: anyone with the anon key + a
-- tenant name can access that workspace. Fine for a pilot/demo; use a long,
-- non-guessable tenant name. Harden with Auth (below) for production.
-- ---------------------------------------------------------------------------
drop policy if exists "anon read workspaces"   on public.workspaces;
drop policy if exists "anon write workspaces"  on public.workspaces;
drop policy if exists "anon update workspaces" on public.workspaces;
create policy "anon read workspaces"   on public.workspaces for select to anon using (true);
create policy "anon write workspaces"  on public.workspaces for insert to anon with check (true);
create policy "anon update workspaces" on public.workspaces for update to anon using (true);

-- ---------------------------------------------------------------------------
-- PRODUCTION HARDENING (optional): tie each workspace to a logged-in user with
-- Supabase Auth and drop the anon policies above. Each user sees only their row.
--
--   alter table public.workspaces
--     add column if not exists user_id uuid references auth.users (id) default auth.uid();
--   drop policy "anon read workspaces"   on public.workspaces;
--   drop policy "anon write workspaces"  on public.workspaces;
--   drop policy "anon update workspaces" on public.workspaces;
--   create policy "own read"   on public.workspaces for select using (auth.uid() = user_id);
--   create policy "own insert" on public.workspaces for insert with check (auth.uid() = user_id);
--   create policy "own update" on public.workspaces for update using (auth.uid() = user_id);
-- ---------------------------------------------------------------------------
