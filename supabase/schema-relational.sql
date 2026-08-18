-- Granite Logistics — relational Supabase schema (proposed)
--
-- This supersedes schema.sql, which stores one jsonb blob per tenant. That shape works as a
-- sync transport but throws away the main reason to move: with a single blob there is no
-- row-level concurrency, which is exactly why appendOrderWithRepair() and the tombstone
-- merge exist in netlify/functions/_lib.mjs. Rows make that class of bug impossible instead
-- of repaired after the fact.
--
-- STATUS: applied to project yjafrhkrcdldvfcqxcol (us-east-2, Postgres 17.6) on 2026-08-18,
-- and applied a second time to prove it is re-runnable. Verified against it afterwards: all
-- fourteen tables, RLS on every one, the unique constraints that hold parcel identity, the
-- NULLS NOT DISTINCT index behind an idempotent activity log, and the whole data layer round
-- tripping a worst-case workspace including photos through Storage.
--
-- What is NOT done: bootstrap_admins is empty, deliberately. Seeding it grants full operations
-- access, so it needs a person to confirm the addresses. See MIGRATION-CHECKLIST.md.
--
-- Mapping from the seven Blobs stores in use today:
--   granite-users            -> auth.users + public.profiles
--   granite-roles            -> public.role_grants + public.role_audit
--   granite-workspaces       -> public.packages / package_events / manifests / load_units
--   granite-push             -> public.push_subscriptions
--   granite-throttle         -> public.auth_throttle
--   granite-notify           -> public.notified
--   granite-customer-orders  -> already legacy; nothing to carry over

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Tenancy
--
-- One row per workspace. Today this is the string "default" plus whatever GL_TENANTS maps.
-- ---------------------------------------------------------------------------
create table if not exists public.tenants (
  slug        text primary key,
  name        text not null default 'Granite Logistics',
  created_at  timestamptz not null default now()
);
insert into public.tenants (slug) values ('default') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- People and roles
--
-- The authority chain today is: env config (GL_ADMIN_EMAILS/GL_ROLES) outranks in-app
-- grants, which outrank Customer. That ordering is deliberate -- it is the break-glass path,
-- because an operator can always restore access by editing environment variables when the
-- stored grants are wrong.
--
-- Postgres has no environment. bootstrap_admins is the replacement, and it is writable ONLY
-- by the service role, so it cannot be edited from the app even by an Admin. That preserves
-- the property but moves the break-glass from "edit a Netlify variable" to "run one SQL
-- statement in the dashboard". Weigh that before committing: it is a real change in how you
-- recover from a lockout.
-- ---------------------------------------------------------------------------
create table if not exists public.bootstrap_admins (
  email       text primary key,
  note        text,
  created_at  timestamptz not null default now()
);

-- Postgres has no CREATE TYPE IF NOT EXISTS. Guarded so this whole file can be re-run after
-- a statement fails part-way, which is the realistic way a first application goes.
do $$ begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'gl_role' and n.nspname = 'public') then
    create type public.gl_role as enum ('Customer', 'Viewer', 'Driver', 'Runner', 'Admin');
  end if;
end $$;

create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text unique not null,
  name          text,
  tenant        text not null default 'default' references public.tenants (slug),
  created_at    timestamptz not null default now()
);

create table if not exists public.role_grants (
  email       text primary key,
  role        public.gl_role not null,
  granted_by  text,
  granted_at  timestamptz not null default now()
);

create table if not exists public.role_audit (
  id          bigserial primary key,
  email       text not null,
  kind        text,                       -- null for a role change, 'password-reset' etc.
  from_role   public.gl_role,
  to_role     public.gl_role,
  by_email    text,
  at          timestamptz not null default now()
);

-- The effective role, resolved in the same order the app resolves it today. STABLE so the
-- planner can call it once per statement inside a policy rather than once per row.
create or replace function public.effective_role(p_email text)
returns public.gl_role
language sql stable security definer set search_path = public as $$
  select case
    when exists (select 1 from public.bootstrap_admins b where lower(b.email) = lower(p_email))
      then 'Admin'::public.gl_role
    else coalesce(
      (select g.role from public.role_grants g where lower(g.email) = lower(p_email)),
      'Customer'::public.gl_role)
  end;
$$;

create or replace function public.my_role() returns public.gl_role
language sql stable as $$ select public.effective_role(coalesce(auth.jwt() ->> 'email', '')); $$;

create or replace function public.my_tenant() returns text
language sql stable as $$
  select case
    when auth.uid() is null then null
    else coalesce((select tenant from public.profiles where id = auth.uid()), 'default')
  end;
$$;

-- ---------------------------------------------------------------------------
-- Shipments
--
-- One row per parcel, replacing an element inside a jsonb array. `uid` is the stable
-- identity the client merge relies on; `id` stays the human-facing GL-#### label, unique
-- per tenant rather than globally, because the sequence is per workspace today.
--
-- Photos are PATHS into Supabase Storage, never data URLs. That is the whole point of
-- step 1 in the staging order: a condition photo is ~110,000 characters as a data URL and
-- today two of them per parcel puts a hard ceiling near 23 parcels on a device.
-- ---------------------------------------------------------------------------
create table if not exists public.packages (
  -- This IS the order uid the client and appendOrderWithRepair already generate, not a
  -- second identity. Making it the primary key is what retires the repair loop: two racing
  -- inserts can no longer produce one row, and unique (tenant, id) below means they can no
  -- longer share a GL-#### either. The default only covers rows created outside that path.
  uid             uuid primary key default gen_random_uuid(),
  tenant          text not null references public.tenants (slug),
  id              text not null,
  -- The uid minted by an order path (customer order, webhook ingest), null for a parcel an
  -- operator created in the app. NOT the row identity -- uid above is that. This one exists
  -- because mergePushedPackages uses its presence to mean "the server made this, so an ops
  -- client pushing a stale snapshot must not delete it", and a derived value would make every
  -- parcel look server-created and stop a local Reset from ever clearing the workspace.
  order_uid       uuid,
  status          text not null,
  source          text,
  order_ref       text,
  barcode         text,
  carrier         text,
  lane            text,
  batch_id        text,
  tracking        text,
  item            jsonb not null default '{}'::jsonb,     -- {description, value, weight}
  customer        jsonb not null default '{}'::jsonb,     -- {name, address, city, state, zip, phone}
  customer_email  text,                                   -- the join to a signed-in customer
  photo_pickup    text,                                   -- storage path, not a data URL
  photo_delivery  text,
  load_unit       text,                                   -- which load unit holds it
  sort_zone       text,                                   -- ZIP zone it was sorted into
  presort_lane    text,
  promised_at     timestamptz,
  exception       jsonb,
  return_state    jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Which whole-workspace push last contained this row. A row not carrying the token of the
  -- push in progress was absent from it, which is how a deletion is detected without listing
  -- every surviving uid in a URL. A token rather than a timestamp because two pushes inside
  -- one millisecond produce identical timestamps, and a "last seen before now" comparison then
  -- silently misses the deletion.
  sync_token      text not null default '',
  deleted_at      timestamptz,                            -- replaces the tombstone array
  unique (tenant, id)
);
create index if not exists packages_tenant_status_idx on public.packages (tenant, status);
create index if not exists packages_customer_idx on public.packages (lower(customer_email));
create index if not exists packages_tracking_idx on public.packages (tracking);

-- packages.updated_at defaulted to now() on insert and was never touched again, so a column
-- documented as "when this row last changed" always reported when it was created. Two honest
-- options: delete it, or make it true. It is worth keeping -- it is the first thing anybody
-- asks when a sync looks wrong -- so a trigger maintains it rather than trusting every writer
-- to remember, which the writer here did not.
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists packages_touch_updated_at on public.packages;
create trigger packages_touch_updated_at
  before update on public.packages
  for each row execute function public.touch_updated_at();

-- The unique constraint is what makes a workspace push idempotent. An ops client pushes its
-- whole local state, so the same custody entry arrives on every sync; without this, each push
-- would append a duplicate copy of every stage the parcel has ever been through.
create table if not exists public.package_events (
  id          bigserial primary key,
  package_uid uuid not null references public.packages (uid) on delete cascade,
  stage       text not null,
  note        text,
  at          timestamptz not null default now(),
  unique (package_uid, stage, at)
);
create index if not exists package_events_pkg_idx on public.package_events (package_uid, at desc);

-- packageIds is deliberately NOT stored: membership is packages.batch_id, so the two cannot
-- disagree. The client rebuilds the array on read, exactly as it already does from local state.
create table if not exists public.manifests (
  id          text not null,
  tenant      text not null references public.tenants (slug),
  carrier     text,
  lane        text,
  transmitted boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (tenant, id)
);

-- Was zip_prefix/city/state, which the app never writes. It writes a ZIP sort zone, a
-- pre-sort lane and a weight; parcel membership is packages.load_unit, same argument as
-- manifests above.
create table if not exists public.load_units (
  id          text not null,
  tenant      text not null references public.tenants (slug),
  zone        text,
  lane        text,
  weight_lb   integer,
  created_at  timestamptz not null default now(),
  primary key (tenant, id)
);

-- The Activity Log. Distinct from package_events: those are custody stages on one parcel,
-- these are workspace-level entries (an exception raised, a return requested) that the
-- Activity view lists across parcels. Neither had a table before, so a pull returned an
-- empty log and the client's own entries were dropped on the next push.
create table if not exists public.activity_events (
  id          bigserial primary key,
  tenant      text not null references public.tenants (slug),
  package_id  text,
  kind        text,
  who         text,
  note        text,
  at          timestamptz not null default now(),
  unique nulls not distinct (tenant, package_id, kind, at)
);
create index if not exists activity_tenant_idx on public.activity_events (tenant, at desc);

-- Company name, default carrier and lane. Per workspace, one row.
--
-- The client's settings object also carries `cloud` (the sync URL and api key) and the
-- per-device theme and role. Those are deliberately not stored: an api key has no business
-- in the workspace record, and a theme is a property of a device, not of a business. The
-- client already never applies settings from a server pull, so dropping them changes nothing.
create table if not exists public.workspace_settings (
  tenant      text primary key references public.tenants (slug),
  settings    jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Supporting stores
-- ---------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id          bigserial primary key,
  email       text not null,
  endpoint    text not null unique,
  keys        jsonb not null,
  created_at  timestamptz not null default now()
);
create index if not exists push_email_idx on public.push_subscriptions (lower(email));

-- Counters, not sessions. Kept server-side so a locked address costs an attacker a
-- rejection rather than a hash, exactly as _throttle.mjs does now.
create table if not exists public.auth_throttle (
  scope       text not null,              -- 'login' | 'reset'
  email       text not null,
  count       int  not null default 0,
  first_at    timestamptz not null default now(),
  locked_until timestamptz,
  primary key (scope, email)
);

-- Dedupe for status notifications, so a flapping status cannot mail twice.
create table if not exists public.notified (
  tenant      text not null references public.tenants (slug),
  package_id  text not null,
  stage       text not null,
  at          timestamptz not null default now(),
  primary key (tenant, package_id, stage)
);

-- ---------------------------------------------------------------------------
-- Row level security
--
-- The rule the app enforces today, restated where the database can hold it: a customer sees
-- only their own parcels, an ops role sees the whole tenant, and only WRITE_ROLES may
-- change anything. Getting this right is the entire security value of the move -- with the
-- jsonb-blob schema, anyone holding the anon key and a tenant name reads everything.
-- ---------------------------------------------------------------------------
alter table public.packages          enable row level security;
alter table public.package_events    enable row level security;
alter table public.manifests         enable row level security;
alter table public.load_units        enable row level security;
alter table public.profiles          enable row level security;
alter table public.role_grants       enable row level security;
alter table public.role_audit        enable row level security;
alter table public.activity_events    enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.bootstrap_admins  enable row level security;   -- no policies: service role only
alter table public.auth_throttle     enable row level security;   -- no policies: service role only
alter table public.notified          enable row level security;   -- no policies: service role only

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for select using (id = auth.uid() or public.my_role() = 'Admin');

drop policy if exists "packages readable by owner or ops" on public.packages;
create policy "packages readable by owner or ops" on public.packages
  for select using (
    deleted_at is null and tenant = public.my_tenant() and (
      public.my_role() in ('Viewer','Driver','Runner','Admin')
      or lower(customer_email) = lower(coalesce(auth.jwt() ->> 'email',''))
    )
  );

-- Writes are ops-only. A customer creates an order through an edge function running as the
-- service role, the same shape as /api/my-orders today, so the client never writes directly.
drop policy if exists "packages writable by ops" on public.packages;
create policy "packages writable by ops" on public.packages
  for all using (tenant = public.my_tenant() and public.my_role() in ('Runner','Driver','Admin'))
  with check (tenant = public.my_tenant() and public.my_role() in ('Runner','Driver','Admin'));

drop policy if exists "events follow their package" on public.package_events;
create policy "events follow their package" on public.package_events
  for select using (exists (
    select 1 from public.packages p where p.uid = package_uid
      and p.tenant = public.my_tenant()
      and (public.my_role() in ('Viewer','Driver','Runner','Admin')
           or lower(p.customer_email) = lower(coalesce(auth.jwt() ->> 'email','')))
  ));

drop policy if exists "activity ops read" on public.activity_events;
create policy "activity ops read"   on public.activity_events for select using (tenant = public.my_tenant() and public.my_role() <> 'Customer');
drop policy if exists "settings tenant read" on public.workspace_settings;
create policy "settings tenant read" on public.workspace_settings for select using (tenant = public.my_tenant() and public.my_role() <> 'Customer');
drop policy if exists "manifests ops read" on public.manifests;
create policy "manifests ops read"  on public.manifests  for select using (tenant = public.my_tenant() and public.my_role() <> 'Customer');
drop policy if exists "loadunits ops read" on public.load_units;
create policy "loadunits ops read"  on public.load_units for select using (tenant = public.my_tenant() and public.my_role() <> 'Customer');
drop policy if exists "grants admin only" on public.role_grants;
create policy "grants admin only"   on public.role_grants for all using (public.my_role() = 'Admin') with check (public.my_role() = 'Admin');
drop policy if exists "audit admin read" on public.role_audit;
create policy "audit admin read"    on public.role_audit  for select using (public.my_role() = 'Admin');
drop policy if exists "own push rows" on public.push_subscriptions;
create policy "own push rows"       on public.push_subscriptions
  for all using (lower(email) = lower(coalesce(auth.jwt() ->> 'email','')))
  with check (lower(email) = lower(coalesce(auth.jwt() ->> 'email','')));

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------
-- insert into storage.buckets (id, name, public) values ('condition-photos','condition-photos',false)
--   on conflict do nothing;
--
-- Private bucket, read through short-lived signed URLs. Public tracking shows photos to a
-- recipient who has the tracking number, so those URLs must be minted server-side and
-- expire -- the public page deliberately exposes status, dates and destination city only,
-- and a permanent photo URL would undo that.

-- ---------------------------------------------------------------------------
-- Staging order, and why
-- ---------------------------------------------------------------------------
-- 1. PHOTOS ONLY. Move condition photos to Storage, keep everything else exactly as it is.
--    This is the live problem: the 5.24M-character localStorage budget, ~23 parcels. It is
--    also the only step that is worth doing on its own merits even if the rest never
--    happens, and it touches no auth.
--
-- 2. DATA. Move packages/manifests/events to the tables above, behind the existing
--    provider === "supabase" seam in app.js. appendOrderWithRepair and the tombstone merge
--    retire here, replaced by a unique constraint and deleted_at.
--
-- 3. AUTH LAST, and only for a reason. The current implementation is the most finished part
--    of the system: scrypt with per-user salts, HMAC sessions, pwChangedAt supersession, a
--    login throttle deliberately built so it cannot be used to enumerate accounts, and roles
--    re-derived server-side on every request -- 145 tests, several mutation-tested. Moving it
--    trades audited-and-working for new-and-unverified. Good reasons to do it anyway: SSO, a
--    customer's identity requirements, or isolation the current model cannot express.
--    "Email is not configured" is not one -- that is two environment variables.
