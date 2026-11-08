create or replace function public.is_society_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.users
    where auth_user_id = auth.uid()
      and role = 'admin'
  );
$$;

revoke all on function public.is_society_admin() from public;
grant execute on function public.is_society_admin() to authenticated;

grant select on public.polls, public.poll_options to authenticated;

drop policy if exists polls_read_for_authenticated on public.polls;
create policy polls_read_for_authenticated
on public.polls
for select
to authenticated
using (
  public.is_society_admin()
  or (is_deleted = false and deadline > now())
);

drop policy if exists poll_options_read_for_authenticated on public.poll_options;
create policy poll_options_read_for_authenticated
on public.poll_options
for select
to authenticated
using (
  public.is_society_admin()
  or exists (
    select 1
    from public.polls
    where polls.id = poll_options.poll_id
      and polls.is_deleted = false
      and polls.deadline > now()
  )
);