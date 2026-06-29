-- Granite Logistics (Next.js) — per-user packages with Row Level Security.
-- Run in Supabase → SQL Editor.

create table if not exists public.packages (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  gl_id         text,
  customer_name text,
  item          text,
  status        text not null default 'Won',
  created_at    timestamptz not null default now()
);

alter table public.packages enable row level security;

create policy "select own" on public.packages for select using (auth.uid() = user_id);
create policy "insert own" on public.packages for insert with check (auth.uid() = user_id);
create policy "update own" on public.packages for update using (auth.uid() = user_id);
create policy "delete own" on public.packages for delete using (auth.uid() = user_id);
