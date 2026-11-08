create or replace function public.can_view_poll(p_poll_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_society_admin()
    or exists (
      select 1
      from public.polls p
      join public.users u on u.auth_user_id = auth.uid()
      where p.id = p_poll_id
        and p.is_deleted = false
        and p.deadline > now()
        and case p.restriction
          when 'one_per_flat' then true
          when 'owners_only_one_per_flat' then exists (
            select 1 from public.user_resident_types membership
            where membership.user_id = u.id
              and membership.resident_type = 'owner'
          )
          when 'residents_only_one_per_flat' then exists (
            select 1 from public.user_resident_types membership
            where membership.user_id = u.id
              and membership.resident_type = 'resident'
          )
          when 'all_owners' then exists (
            select 1 from public.user_resident_types membership
            where membership.user_id = u.id
              and membership.resident_type = 'owner'
          )
          when 'all_residents' then exists (
            select 1 from public.user_resident_types membership
            where membership.user_id = u.id
              and membership.resident_type = 'resident'
          )
          when 'all_owners_and_residents' then exists (
            select 1 from public.user_resident_types membership
            where membership.user_id = u.id
          )
          else false
        end
    );
$$;

revoke all on function public.can_view_poll(uuid) from public, anon;
grant execute on function public.can_view_poll(uuid) to authenticated;

drop policy if exists polls_read_for_authenticated on public.polls;
create policy polls_read_for_authenticated
on public.polls
for select
to authenticated
using (public.can_view_poll(id));

drop policy if exists poll_options_read_for_authenticated on public.poll_options;
create policy poll_options_read_for_authenticated
on public.poll_options
for select
to authenticated
using (public.can_view_poll(poll_id));