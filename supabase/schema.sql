-- Insaan Labs dashboard database. Run once in Supabase > SQL Editor > New query.
--
-- Who can do what (enforced by the database itself, not the website):
--   * Signed-in people only see dashboards listed for their email in `memberships`.
--   * Admins (accounts.is_admin) can also edit content for those dashboards.
--   * Nobody signed out can read anything.
--   * `integration_accounts` is only readable by Supabase functions (the Refresh button).

create table public.clients (
  id text primary key check (id ~ '^[a-z0-9-]+$'),
  name text not null,
  integrations text[] not null default '{}',
  -- The dashboard document: same shape as the old app/data.js files.
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.accounts (
  email text primary key check (email = lower(email)),
  name text not null,
  is_admin boolean not null default false
);

create table public.memberships (
  email text not null references public.accounts (email) on delete cascade on update cascade,
  client_id text not null references public.clients (id) on delete cascade,
  primary key (email, client_id)
);

-- Budgets, crew, status and notes added on the Content page.
create table public.content_edits (
  client_id text primary key references public.clients (id) on delete cascade,
  edits jsonb not null default '{"overrides": {}, "added": []}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- Latest pull from each platform, written by the refresh-instagram function.
create table public.syncs (
  client_id text not null references public.clients (id) on delete cascade,
  platform text not null,
  record jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (client_id, platform)
);

-- Which Instagram account belongs to which dashboard. No policies: website users can't read it.
create table public.integration_accounts (
  client_id text not null references public.clients (id) on delete cascade,
  platform text not null,
  external_id text not null,
  primary key (client_id, platform)
);

-- Helpers used by the policies below.
create function public.my_email()
returns text
language sql
stable
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''))
$$;

-- security definer so policies can check memberships/accounts without exposing other rows.
create function public.can_view(cid text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.client_id = cid and m.email = public.my_email()
  )
$$;

create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select a.is_admin from public.accounts a where a.email = public.my_email()), false)
$$;

revoke execute on function public.my_email(), public.can_view(text), public.is_admin() from public, anon;
grant execute on function public.my_email(), public.can_view(text), public.is_admin() to authenticated;

alter table public.clients enable row level security;
alter table public.accounts enable row level security;
alter table public.memberships enable row level security;
alter table public.content_edits enable row level security;
alter table public.syncs enable row level security;
alter table public.integration_accounts enable row level security;

create policy "Read own account" on public.accounts
  for select to authenticated using (email = public.my_email());

create policy "Read own memberships" on public.memberships
  for select to authenticated using (email = public.my_email());

create policy "Members read their clients" on public.clients
  for select to authenticated using (public.can_view(id));

create policy "Admins update their clients" on public.clients
  for update to authenticated
  using (public.can_view(id) and public.is_admin())
  with check (public.can_view(id) and public.is_admin());

create policy "Members read content edits" on public.content_edits
  for select to authenticated using (public.can_view(client_id));

create policy "Admins add content edits" on public.content_edits
  for insert to authenticated
  with check (public.can_view(client_id) and public.is_admin());

create policy "Admins change content edits" on public.content_edits
  for update to authenticated
  using (public.can_view(client_id) and public.is_admin())
  with check (public.can_view(client_id) and public.is_admin());

create policy "Members read syncs" on public.syncs
  for select to authenticated using (public.can_view(client_id));

-- Belt and braces on top of the policies: signed-out visitors get no table access at all,
-- and signed-in users only get the operations the dashboard needs.
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
grant select on public.clients, public.accounts, public.memberships, public.content_edits, public.syncs to authenticated;
grant update (data, updated_at) on public.clients to authenticated;
grant insert, update on public.content_edits to authenticated;
