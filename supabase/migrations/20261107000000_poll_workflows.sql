create or replace function public._poll_voter_status(p_poll_id uuid, p_user_id uuid)
returns table (eligible boolean, has_voted boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  voter public.users%rowtype;
  poll public.polls%rowtype;
begin
  select * into voter
  from public.users
  where auth_user_id = p_user_id
  limit 1;

  select * into poll
  from public.polls
  where id = p_poll_id and is_deleted = false
  limit 1;

  if voter.id is null or poll.id is null then
    return query select false, false;
    return;
  end if;

  eligible := case poll.restriction
    when 'owners_only_one_per_flat' then voter.resident_type = 'owner'
    when 'residents_only_one_per_flat' then voter.resident_type = 'resident'
    when 'all_owners' then voter.resident_type = 'owner'
    when 'all_residents' then voter.resident_type = 'resident'
    when 'one_per_flat' then true
    when 'all_owners_and_residents' then true
    else false
  end;

  has_voted := case poll.restriction
    when 'one_per_flat' then exists (
      select 1 from public.votes v
      where v.poll_id = p_poll_id and v.flat_number = voter.flat_number
    )
    when 'owners_only_one_per_flat' then exists (
      select 1 from public.votes v
      where v.poll_id = p_poll_id and v.flat_number = voter.flat_number
    )
    when 'residents_only_one_per_flat' then exists (
      select 1 from public.votes v
      where v.poll_id = p_poll_id and v.flat_number = voter.flat_number
    )
    when 'all_owners' then exists (
      select 1 from public.votes v
      where v.poll_id = p_poll_id and v.flat_number = voter.flat_number
        and v.resident_type = 'owner'
    )
    when 'all_residents' then exists (
      select 1 from public.votes v
      where v.poll_id = p_poll_id and v.flat_number = voter.flat_number
        and v.resident_type = 'resident'
    )
    when 'all_owners_and_residents' then exists (
      select 1 from public.votes v
      where v.poll_id = p_poll_id and v.flat_number = voter.flat_number
        and v.resident_type = voter.resident_type
    )
    else true
  end;

  return next;
end;
$$;

create or replace function public.get_my_poll_vote_status(p_poll_ids uuid[])
returns table (poll_id uuid, eligible boolean, has_voted boolean)
language sql
security definer
set search_path = public
as $$
  select requested.poll_id, status.eligible, status.has_voted
  from unnest(p_poll_ids) as requested(poll_id)
  cross join lateral public._poll_voter_status(requested.poll_id, auth.uid()) status;
$$;

drop function if exists public.link_my_user_profile();

create function public.link_my_user_profile()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  verified_email text := lower(trim(coalesce(auth.jwt()->>'email', '')));
  linked_role text;
begin
  if auth.uid() is null or verified_email = '' then
    raise exception 'Authenticated email required';
  end if;

  update public.users
  set auth_user_id = auth.uid()
  where lower(email) = verified_email
    and (auth_user_id is null or auth_user_id = auth.uid())
  returning role into linked_role;

  if linked_role is null then
    raise exception 'No unlinked resident profile matches this email';
  end if;

  return linked_role;
end;
$$;

create or replace function public.submit_poll_ballot(
  p_poll_id uuid,
  p_option_ids uuid[],
  p_rank_positions integer[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  voter public.users%rowtype;
  poll public.polls%rowtype;
  status record;
  option_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into voter
  from public.users
  where auth_user_id = auth.uid()
  limit 1;

  select * into poll
  from public.polls
  where id = p_poll_id and is_deleted = false
  limit 1;

  if voter.id is null then
    raise exception 'Registered voter profile not found';
  end if;
  if poll.id is null or poll.deadline <= now() then
    raise exception 'Poll is unavailable or has closed';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_poll_id::text || ':' || voter.flat_number, 0));

  select * into status from public._poll_voter_status(p_poll_id, auth.uid());
  if not coalesce(status.eligible, false) then
    raise exception 'You are not eligible to vote in this poll';
  end if;
  if coalesce(status.has_voted, true) then
    raise exception 'A vote has already been recorded for this flat and poll';
  end if;

  if coalesce(array_length(p_option_ids, 1), 0) = 0
     or array_length(p_option_ids, 1) <> array_length(p_rank_positions, 1) then
    raise exception 'A valid ballot is required';
  end if;

  if poll.poll_type = 'single_choice' and array_length(p_option_ids, 1) <> 1 then
    raise exception 'Single-choice polls accept exactly one option';
  end if;

  if poll.poll_type = 'single_choice' and p_rank_positions[1] <> 1 then
    raise exception 'Single-choice ballot rank must be one';
  end if;

  if exists (
    select 1 from unnest(p_option_ids) option_id
    group by option_id having count(*) > 1
  ) or exists (
    select 1 from unnest(p_rank_positions) rank_position
    group by rank_position having count(*) > 1
  ) or exists (
    select 1 from unnest(p_rank_positions) rank_position
    where rank_position < 1
  ) then
    raise exception 'Ballot options and ranks must be unique and valid';
  end if;

  select count(*) into option_count
  from public.poll_options
  where poll_id = p_poll_id and id = any(p_option_ids);

  if option_count <> array_length(p_option_ids, 1) then
    raise exception 'Ballot contains an option outside this poll';
  end if;

  if poll.poll_type = 'ranked_choice' and option_count <> (
    select count(*) from public.poll_options where poll_id = p_poll_id
  ) then
    raise exception 'Ranked ballots must include every poll option';
  end if;

  if poll.poll_type = 'ranked_choice' and (
    (select min(rank_position) from unnest(p_rank_positions) as ranks(rank_position)) <> 1
    or (select max(rank_position) from unnest(p_rank_positions) as ranks(rank_position)) <> array_length(p_rank_positions, 1)
  ) then
    raise exception 'Rank positions must be a complete sequence starting at one';
  end if;

  insert into public.votes (poll_id, flat_number, resident_type, voted_at)
  values (p_poll_id, voter.flat_number, voter.resident_type, now());

  insert into public.ballot_entries (poll_id, option_id, rank_position)
  select p_poll_id, ballot.option_id, ballot.rank_position
  from unnest(p_option_ids, p_rank_positions) as ballot(option_id, rank_position);
end;
$$;

create or replace function public.admin_import_users(p_users jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  row_data jsonb;
  rows_imported integer := 0;
  row_email text;
  row_role text;
  row_resident_type text;
  row_auth_user_id uuid;
  existing_user public.users%rowtype;
begin
  if not exists (
    select 1 from public.users
    where auth_user_id = auth.uid() and role = 'admin'
  ) then
    raise exception 'Admin access required';
  end if;
  if jsonb_typeof(p_users) <> 'array' then
    raise exception 'User import must be a JSON array';
  end if;

  for row_data in select value from jsonb_array_elements(p_users)
  loop
    row_email := lower(trim(row_data->>'email'));
    row_role := coalesce(nullif(trim(row_data->>'role'), ''), 'regular');
    row_resident_type := lower(trim(row_data->>'resident_type'));

    if row_email is null or row_email = '' or coalesce(trim(row_data->>'name'), '') = ''
       or coalesce(trim(row_data->>'flat_number'), '') = ''
       or row_resident_type is null or row_resident_type not in ('owner', 'resident')
       or row_role not in ('admin', 'regular') then
      raise exception 'Invalid user row for email %', row_email;
    end if;

    row_auth_user_id := nullif(row_data->>'auth_user_id', '')::uuid;
    if row_auth_user_id is null then
      select id into row_auth_user_id
      from auth.users
      where lower(email) = row_email
      limit 1;
    end if;

    select * into existing_user from public.users where lower(email) = row_email limit 1;
    if existing_user.id is not null then
      update public.users set
        name = trim(row_data->>'name'),
        contact = nullif(trim(row_data->>'contact'), ''),
        flat_number = trim(row_data->>'flat_number'),
        resident_type = row_resident_type,
        role = row_role,
        auth_user_id = coalesce(row_auth_user_id, existing_user.auth_user_id)
      where id = existing_user.id;
    else
      insert into public.users (auth_user_id, email, name, contact, flat_number, resident_type, role)
      values (
        row_auth_user_id,
        row_email,
        trim(row_data->>'name'),
        nullif(trim(row_data->>'contact'), ''),
        trim(row_data->>'flat_number'),
        row_resident_type,
        row_role
      );
    end if;
    rows_imported := rows_imported + 1;
  end loop;

  return rows_imported;
end;
$$;

create or replace function public.admin_create_poll(
  p_title text,
  p_description text,
  p_poll_type text,
  p_restriction text,
  p_deadline timestamptz,
  p_options text[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  admin_profile public.users%rowtype;
  new_poll_id uuid;
  option_text text;
  option_order integer := 0;
begin
  select * into admin_profile from public.users
  where auth_user_id = auth.uid() and role = 'admin'
  limit 1;

  if admin_profile.id is null then
    raise exception 'Admin access required';
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
  if p_deadline <= now() or cardinality(p_options) < 2 then
    raise exception 'Poll needs a future deadline and at least two options';
  end if;

  insert into public.polls (title, description, poll_type, restriction, deadline, is_deleted, created_by)
  values (
    trim(p_title),
    nullif(trim(p_description), ''),
    p_poll_type::public.poll_type,
    p_restriction::public.voting_restriction,
    p_deadline,
    false,
    admin_profile.id
  )
  returning id into new_poll_id;

  foreach option_text in array p_options
  loop
    option_order := option_order + 1;
    if trim(option_text) <> '' then
      insert into public.poll_options (poll_id, option_text, display_order)
      values (new_poll_id, trim(option_text), option_order);
    end if;
  end loop;

  if (select count(*) from public.poll_options where poll_id = new_poll_id) < 2 then
    raise exception 'Poll needs at least two non-empty options';
  end if;

  return new_poll_id;
end;
$$;

create or replace function public.get_poll_results(p_poll_id uuid)
returns table (
  option_id uuid,
  option_text text,
  display_order integer,
  single_votes bigint,
  borda_score bigint,
  total_ballots bigint
)
language sql
security definer
set search_path = public
as $$
  with selected_poll as (
    select id, poll_type
    from public.polls
    where id = p_poll_id and is_deleted = false
  ), option_count as (
    select count(*)::integer as amount
    from public.poll_options
    where poll_id = p_poll_id
  ), ballot_count as (
    select count(*)::bigint as amount
    from public.votes
    where poll_id = p_poll_id
  )
  select
    option_row.id,
    option_row.option_text,
    option_row.display_order,
    count(entry.option_id) filter (where selected_poll.poll_type = 'single_choice'),
    coalesce(sum(
      case
        when selected_poll.poll_type = 'ranked_choice'
          then option_count.amount - entry.rank_position
        else 0
      end
    ), 0)::bigint,
    ballot_count.amount
  from selected_poll
  join public.poll_options option_row on option_row.poll_id = selected_poll.id
  cross join option_count
  cross join ballot_count
  left join public.ballot_entries entry
    on entry.poll_id = selected_poll.id and entry.option_id = option_row.id
  group by
    option_row.id,
    option_row.option_text,
    option_row.display_order,
    selected_poll.poll_type,
    option_count.amount,
    ballot_count.amount;
$$;

create or replace function public.broadcast_poll_results_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_poll_id uuid;
begin
  if tg_op = 'DELETE' then
    changed_poll_id := old.poll_id;
  else
    changed_poll_id := new.poll_id;
  end if;

  perform realtime.send(
    payload => jsonb_build_object('poll_id', changed_poll_id),
    event => 'poll_results_changed',
    topic => 'poll-results:' || changed_poll_id::text,
    private => true
  );

  return null;
end;
$$;

drop trigger if exists ballot_entries_broadcast_poll_results on public.ballot_entries;
create trigger ballot_entries_broadcast_poll_results
after insert or update or delete on public.ballot_entries
for each row execute function public.broadcast_poll_results_change();

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'realtime'
      and tablename = 'messages'
      and policyname = 'authenticated_poll_results_broadcasts'
  ) then
    execute $policy$
      create policy authenticated_poll_results_broadcasts
        on realtime.messages
        for select
        to authenticated
        using (topic like 'poll-results:%')
    $policy$;
  end if;
end;
$$;

revoke all on function public._poll_voter_status(uuid, uuid) from public;
revoke all on function public.get_my_poll_vote_status(uuid[]) from public;
revoke all on function public.link_my_user_profile() from public;
revoke all on function public.submit_poll_ballot(uuid, uuid[], integer[]) from public;
revoke all on function public.admin_import_users(jsonb) from public;
revoke all on function public.admin_create_poll(text, text, text, text, timestamptz, text[]) from public;
revoke all on function public.get_poll_results(uuid) from public;

grant execute on function public.get_my_poll_vote_status(uuid[]) to authenticated;
grant execute on function public.link_my_user_profile() to authenticated;
grant execute on function public.submit_poll_ballot(uuid, uuid[], integer[]) to authenticated;
grant execute on function public.admin_import_users(jsonb) to authenticated;
grant execute on function public.admin_create_poll(text, text, text, text, timestamptz, text[]) to authenticated;
grant execute on function public.get_poll_results(uuid) to authenticated;