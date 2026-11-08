alter table public.polls
  add column if not exists result_visibility text not null default 'always';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.polls'::regclass
      and conname = 'polls_result_visibility_check'
  ) then
    alter table public.polls
      add constraint polls_result_visibility_check
      check (result_visibility in ('always', 'after_vote', 'after_close'));
  end if;
end;
$$;

create or replace function public.admin_create_scoped_poll_with_options(
  p_title text,
  p_description text,
  p_poll_type text,
  p_restriction text,
  p_deadline timestamptz,
  p_options jsonb,
  p_flat_scope text,
  p_flat_numbers text[],
  p_result_visibility text default 'always'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_profile public.users%rowtype;
  new_poll_id uuid;
  option_data jsonb;
  option_text text;
  image_url text;
  option_order integer := 0;
  selected_flat text;
begin
  select * into admin_profile from public.users
  where auth_user_id = auth.uid() and role = 'admin'
  limit 1;

  if admin_profile.id is null then
    raise exception 'Admin access required';
  end if;
  if nullif(trim(p_title), '') is null then
    raise exception 'Poll title is required';
  end if;
  if p_poll_type not in ('single_choice', 'ranked_choice') then
    raise exception 'Invalid poll type';
  end if;
  if p_restriction not in (
    'one_per_flat', 'owners_only_one_per_flat', 'residents_only_one_per_flat',
    'all_owners', 'all_residents', 'all_owners_and_residents'
  ) then
    raise exception 'Invalid voter restriction';
  end if;
  if p_result_visibility not in ('always', 'after_vote', 'after_close') then
    raise exception 'Invalid result visibility';
  end if;
  if p_deadline <= now() then
    raise exception 'Poll deadline must be in the future';
  end if;
  if p_flat_scope not in ('all', 'selected') then
    raise exception 'Flat scope must be all or selected';
  end if;
  if p_flat_scope = 'selected' and coalesce(cardinality(p_flat_numbers), 0) = 0 then
    raise exception 'Select at least one flat or choose all flats';
  end if;
  if p_flat_scope = 'all' and coalesce(cardinality(p_flat_numbers), 0) > 0 then
    raise exception 'Do not provide selected flats when scope is all';
  end if;
  if p_flat_scope = 'selected' and exists (
    select 1 from unnest(p_flat_numbers) requested(flat_number)
    where nullif(btrim(requested.flat_number), '') is null
       or not exists (select 1 from public.users u where btrim(u.flat_number) = btrim(requested.flat_number))
  ) then
    raise exception 'Selected flats must match registered flat numbers';
  end if;
  if jsonb_typeof(p_options) is distinct from 'array' or jsonb_array_length(p_options) < 2 then
    raise exception 'Poll needs at least two options';
  end if;
  if p_poll_type = 'ranked_choice' and jsonb_array_length(p_options) < 3 then
    raise exception 'Ranked-choice polls need at least three options';
  end if;

  insert into public.polls (title, description, poll_type, restriction, deadline, is_deleted, created_by, flat_scope, result_visibility)
  values (
    trim(p_title), nullif(trim(p_description), ''), p_poll_type::public.poll_type,
    p_restriction::public.voting_restriction, p_deadline, false, admin_profile.id,
    p_flat_scope, p_result_visibility
  )
  returning id into new_poll_id;

  if p_flat_scope = 'selected' then
    foreach selected_flat in array p_flat_numbers
    loop
      insert into public.poll_target_flats (poll_id, flat_number)
      values (new_poll_id, btrim(selected_flat))
      on conflict do nothing;
    end loop;
  end if;

  for option_data in select value from jsonb_array_elements(p_options)
  loop
    option_text := nullif(trim(option_data->>'option_text'), '');
    image_url := nullif(trim(option_data->>'image_url'), '');
    if option_text is null and image_url is null then
      raise exception 'Each option needs text, an image URL, or both';
    end if;
    if image_url is not null and image_url !~* '^https?://' then
      raise exception 'Image URLs must use HTTP or HTTPS';
    end if;

    option_order := option_order + 1;
    insert into public.poll_options (poll_id, option_text, image_url, display_order)
    values (new_poll_id, option_text, image_url, option_order);
  end loop;

  return new_poll_id;
end;
$$;

revoke all on function public.admin_create_scoped_poll_with_options(text, text, text, text, timestamptz, jsonb, text, text[], text) from public, anon;
grant execute on function public.admin_create_scoped_poll_with_options(text, text, text, text, timestamptz, jsonb, text, text[], text) to authenticated;

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
        and (
          p.deadline > now()
          or p.result_visibility in ('always', 'after_close')
          or (p.result_visibility = 'after_vote' and exists (
            select 1 from public.votes v
            where v.poll_id = p.id and v.voter_user_id = u.id
          ))
        )
        and (p.flat_scope = 'all' or exists (
          select 1 from public.poll_target_flats target
          where target.poll_id = p.id and btrim(target.flat_number) = btrim(u.flat_number)
        ))
        and case p.restriction
          when 'one_per_flat' then true
          when 'owners_only_one_per_flat' then exists (
            select 1 from public.user_resident_types m where m.user_id = u.id and m.resident_type = 'owner'
          )
          when 'residents_only_one_per_flat' then exists (
            select 1 from public.user_resident_types m where m.user_id = u.id and m.resident_type = 'resident'
          )
          when 'all_owners' then exists (
            select 1 from public.user_resident_types m where m.user_id = u.id and m.resident_type = 'owner'
          )
          when 'all_residents' then exists (
            select 1 from public.user_resident_types m where m.user_id = u.id and m.resident_type = 'resident'
          )
          when 'all_owners_and_residents' then exists (
            select 1 from public.user_resident_types m where m.user_id = u.id
          )
          else false
        end
    );
$$;

create or replace function public.can_view_poll_results(p_poll_id uuid)
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
      cross join lateral public._poll_voter_status(p.id, auth.uid()) status
      where p.id = p_poll_id
        and p.is_deleted = false
        and status.eligible
        and (p.flat_scope = 'all' or exists (
          select 1 from public.poll_target_flats target
          where target.poll_id = p.id and btrim(target.flat_number) = btrim(u.flat_number)
        ))
        and case p.result_visibility
          when 'always' then true
          when 'after_vote' then exists (
            select 1 from public.votes v where v.poll_id = p.id and v.voter_user_id = u.id
          )
          when 'after_close' then p.deadline <= now()
          else false
        end
    );
$$;

revoke all on function public.can_view_poll_results(uuid) from public, anon;
grant execute on function public.can_view_poll_results(uuid) to authenticated;

drop function public.get_poll_results(uuid);
create function public.get_poll_results(p_poll_id uuid)
returns table (
  option_id uuid, option_text text, image_url text, display_order integer,
  single_votes bigint, borda_score bigint, total_ballots bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_view_poll_results(p_poll_id) then
    raise exception 'Poll results are not available yet';
  end if;

  return query
  with selected_poll as (
    select id, poll_type from public.polls where id = p_poll_id and is_deleted = false
  ), ballot_count as (
    select count(*)::bigint as amount from public.votes where poll_id = p_poll_id
  )
  select
    o.id, o.option_text, o.image_url, o.display_order,
    count(e.option_id) filter (where p.poll_type = 'single_choice'),
    coalesce(sum(case when p.poll_type = 'ranked_choice' and e.rank_position between 1 and 3
      then 4 - e.rank_position else 0 end), 0)::bigint,
    bc.amount
  from selected_poll p
  join public.poll_options o on o.poll_id = p.id
  cross join ballot_count bc
  left join public.ballot_entries e on e.poll_id = p.id and e.option_id = o.id
  group by o.id, o.option_text, o.image_url, o.display_order, p.poll_type, bc.amount;
end;
$$;

revoke all on function public.get_poll_results(uuid) from public, anon;
grant execute on function public.get_poll_results(uuid) to authenticated;

create or replace function public.get_my_poll_result_status(p_poll_ids uuid[])
returns table (
  poll_id uuid,
  result_visibility text,
  can_view_results boolean,
  has_person_voted boolean
)
language sql
security definer
set search_path = public
as $$
  select p.id, p.result_visibility, public.can_view_poll_results(p.id),
    exists (
      select 1 from public.votes v
      join public.users u on u.id = v.voter_user_id
      where v.poll_id = p.id and u.auth_user_id = auth.uid()
    )
  from public.polls p
  where p.id = any(p_poll_ids)
    and p.is_deleted = false
    and public.can_view_poll(p.id);
$$;

revoke all on function public.get_my_poll_result_status(uuid[]) from public, anon;
grant execute on function public.get_my_poll_result_status(uuid[]) to authenticated;alter table public.polls
  add column if not exists result_visibility text not null default 'always';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.polls'::regclass
      and conname = 'polls_result_visibility_check'
  ) then
    alter table public.polls
      add constraint polls_result_visibility_check
      check (result_visibility in ('always', 'after_vote', 'after_close'));
  end if;
end;
$$;

drop function public.admin_create_scoped_poll_with_options(text, text, text, text, timestamptz, jsonb, text, text[]);

create or replace function public.admin_create_scoped_poll_with_options(
  p_title text,
  p_description text,
  p_poll_type text,
  p_restriction text,
  p_deadline timestamptz,
  p_options jsonb,
  p_flat_scope text,
  p_flat_numbers text[],
  p_result_visibility text default 'always'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_profile public.users%rowtype;
  new_poll_id uuid;
  option_data jsonb;
  option_text text;
  image_url text;
  option_order integer := 0;
  selected_flat text;
begin
  select * into admin_profile from public.users
  where auth_user_id = auth.uid() and role = 'admin'
  limit 1;

  if admin_profile.id is null then
    raise exception 'Admin access required';
  end if;
  if nullif(trim(p_title), '') is null then
    raise exception 'Poll title is required';
  end if;
  if p_poll_type not in ('single_choice', 'ranked_choice') then
    raise exception 'Invalid poll type';
  end if;
  if p_restriction not in (
    'one_per_flat', 'owners_only_one_per_flat', 'residents_only_one_per_flat',
    'all_owners', 'all_residents', 'all_owners_and_residents'
  ) then
    raise exception 'Invalid voter restriction';
  end if;
  if p_result_visibility not in ('always', 'after_vote', 'after_close') then
    raise exception 'Invalid result visibility';
  end if;
  if p_deadline <= now() then
    raise exception 'Poll deadline must be in the future';
  end if;
  if p_flat_scope not in ('all', 'selected') then
    raise exception 'Flat scope must be all or selected';
  end if;
  if p_flat_scope = 'selected' and coalesce(cardinality(p_flat_numbers), 0) = 0 then
    raise exception 'Select at least one flat or choose all flats';
  end if;
  if p_flat_scope = 'all' and coalesce(cardinality(p_flat_numbers), 0) > 0 then
    raise exception 'Do not provide selected flats when scope is all';
  end if;
  if p_flat_scope = 'selected' and exists (
    select 1
    from unnest(p_flat_numbers) requested(flat_number)
    where nullif(btrim(requested.flat_number), '') is null
       or not exists (
         select 1 from public.users u
         where btrim(u.flat_number) = btrim(requested.flat_number)
       )
  ) then
    raise exception 'Selected flats must match registered flat numbers';
  end if;
  if jsonb_typeof(p_options) is distinct from 'array' or jsonb_array_length(p_options) < 2 then
    raise exception 'Poll needs at least two options';
  end if;
  if p_poll_type = 'ranked_choice' and jsonb_array_length(p_options) < 3 then
    raise exception 'Ranked-choice polls need at least three options';
  end if;

  insert into public.polls (title, description, poll_type, restriction, deadline, is_deleted, created_by, flat_scope, result_visibility)
  values (
    trim(p_title), nullif(trim(p_description), ''), p_poll_type::public.poll_type,
    p_restriction::public.voting_restriction, p_deadline, false, admin_profile.id,
    p_flat_scope, p_result_visibility
  )
  returning id into new_poll_id;

  if p_flat_scope = 'selected' then
    foreach selected_flat in array p_flat_numbers
    loop
      insert into public.poll_target_flats (poll_id, flat_number)
      values (new_poll_id, btrim(selected_flat))
      on conflict do nothing;
    end loop;
  end if;

  for option_data in select value from jsonb_array_elements(p_options)
  loop
    option_text := nullif(trim(option_data->>'option_text'), '');
    image_url := nullif(trim(option_data->>'image_url'), '');
    if option_text is null and image_url is null then
      raise exception 'Each option needs text, an image URL, or both';
    end if;
    if image_url is not null and image_url !~* '^https?://' then
      raise exception 'Image URLs must use HTTP or HTTPS';
    end if;

    option_order := option_order + 1;
    insert into public.poll_options (poll_id, option_text, image_url, display_order)
    values (new_poll_id, option_text, image_url, option_order);
  end loop;

  return new_poll_id;
end;
$$;

revoke all on function public.admin_create_scoped_poll_with_options(text, text, text, text, timestamptz, jsonb, text, text[], text) from public, anon;
grant execute on function public.admin_create_scoped_poll_with_options(text, text, text, text, timestamptz, jsonb, text, text[], text) to authenticated;

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
        and (
          p.deadline > now()
          or p.result_visibility in ('always', 'after_close')
          or (p.result_visibility = 'after_vote' and exists (
            select 1 from public.votes v
            where v.poll_id = p.id and (
              (p.restriction = 'all_owners_and_residents' and v.voter_user_id = u.id)
              or (p.restriction <> 'all_owners_and_residents' and v.flat_number = u.flat_number)
            )
          ))
        )
        and (p.flat_scope = 'all' or exists (
          select 1 from public.poll_target_flats target
          where target.poll_id = p.id and btrim(target.flat_number) = btrim(u.flat_number)
        ))
        and case p.restriction
          when 'one_per_flat' then true
          when 'owners_only_one_per_flat' then exists (
            select 1 from public.user_resident_types m where m.user_id = u.id and m.resident_type = 'owner'
          )
          when 'residents_only_one_per_flat' then exists (
            select 1 from public.user_resident_types m where m.user_id = u.id and m.resident_type = 'resident'
          )
          when 'all_owners' then exists (
            select 1 from public.user_resident_types m where m.user_id = u.id and m.resident_type = 'owner'
          )
          when 'all_residents' then exists (
            select 1 from public.user_resident_types m where m.user_id = u.id and m.resident_type = 'resident'
          )
          when 'all_owners_and_residents' then exists (
            select 1 from public.user_resident_types m where m.user_id = u.id
          )
          else false
        end
    );
$$;

create or replace function public.can_view_poll_results(p_poll_id uuid)
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
      cross join lateral public._poll_voter_status(p.id, auth.uid()) status
      where p.id = p_poll_id
        and p.is_deleted = false
        and status.eligible
        and (p.flat_scope = 'all' or exists (
          select 1 from public.poll_target_flats target
          where target.poll_id = p.id and btrim(target.flat_number) = btrim(u.flat_number)
        ))
        and case p.result_visibility
          when 'always' then true
          when 'after_vote' then status.has_voted
          when 'after_close' then p.deadline <= now()
          else false
        end
    );
$$;

revoke all on function public.can_view_poll_results(uuid) from public, anon;
grant execute on function public.can_view_poll_results(uuid) to authenticated;

create or replace function public.get_poll_results(p_poll_id uuid)
returns table (
  option_id uuid,
  option_text text,
  image_url text,
  display_order integer,
  single_votes bigint,
  borda_score bigint,
  total_ballots bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_view_poll_results(p_poll_id) then
    raise exception 'Poll results are not available yet';
  end if;

  return query
  with selected_poll as (
    select id, poll_type from public.polls
    where id = p_poll_id and is_deleted = false
  ), ballot_count as (
    select count(*)::bigint as amount from public.votes where poll_id = p_poll_id
  )
  select
    o.id,
    o.option_text,
    o.image_url,
    o.display_order,
    count(e.option_id) filter (where p.poll_type = 'single_choice'),
    coalesce(sum(case when p.poll_type = 'ranked_choice' and e.rank_position between 1 and 3
      then 4 - e.rank_position else 0 end), 0)::bigint,
    bc.amount
  from selected_poll p
  join public.poll_options o on o.poll_id = p.id
  cross join ballot_count bc
  left join public.ballot_entries e on e.poll_id = p.id and e.option_id = o.id
  group by o.id, o.option_text, o.image_url, o.display_order, p.poll_type, bc.amount;
end;
$$;

revoke all on function public.get_poll_results(uuid) from public, anon;
grant execute on function public.get_poll_results(uuid) to authenticated;