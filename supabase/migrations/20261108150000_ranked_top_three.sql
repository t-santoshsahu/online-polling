create or replace function public.admin_create_poll_with_options(
  p_title text,
  p_description text,
  p_poll_type text,
  p_restriction text,
  p_deadline timestamptz,
  p_options jsonb
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
  if p_deadline <= now() then
    raise exception 'Poll deadline must be in the future';
  end if;
  if jsonb_typeof(p_options) is distinct from 'array' then
    raise exception 'Poll options must be a JSON array';
  end if;
  if jsonb_array_length(p_options) < 2 then
    raise exception 'Poll needs at least two options';
  end if;
  if p_poll_type = 'ranked_choice' and jsonb_array_length(p_options) < 3 then
    raise exception 'Ranked-choice polls need at least three options';
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
  vote_resident_type public.resident_type;
  lock_subject text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into voter from public.users where auth_user_id = auth.uid() limit 1;
  select * into poll from public.polls where id = p_poll_id and is_deleted = false limit 1;

  if voter.id is null then
    raise exception 'Registered voter profile not found';
  end if;
  if poll.id is null or poll.deadline <= now() then
    raise exception 'Poll is unavailable or has closed';
  end if;

  lock_subject := case
    when poll.restriction = 'all_owners_and_residents' then 'user:' || voter.id::text
    else 'flat:' || voter.flat_number
  end;
  perform pg_advisory_xact_lock(hashtextextended(p_poll_id::text || ':' || lock_subject, 0));

  select * into status from public._poll_voter_status(p_poll_id, auth.uid());
  if not coalesce(status.eligible, false) then
    raise exception 'You are not eligible to vote in this poll';
  end if;
  if coalesce(status.has_voted, true) then
    raise exception 'A vote has already been recorded for this voter or flat';
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
  if poll.poll_type = 'ranked_choice' and array_length(p_option_ids, 1) <> 3 then
    raise exception 'Ranked-choice ballots must select exactly three options';
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

  if poll.poll_type = 'ranked_choice' and (
    (select min(rank_position) from unnest(p_rank_positions) as ranks(rank_position)) <> 1
    or (select max(rank_position) from unnest(p_rank_positions) as ranks(rank_position)) <> 3
  ) then
    raise exception 'Ranked positions must be exactly 1, 2, and 3';
  end if;

  vote_resident_type := case
    when poll.restriction in ('owners_only_one_per_flat', 'all_owners') then 'owner'::public.resident_type
    when poll.restriction in ('residents_only_one_per_flat', 'all_residents') then 'resident'::public.resident_type
    else null
  end;

  insert into public.votes (poll_id, flat_number, resident_type, voter_user_id, voted_at)
  values (p_poll_id, voter.flat_number, vote_resident_type, voter.id, now());

  insert into public.ballot_entries (poll_id, option_id, rank_position)
  select p_poll_id, ballot.option_id, ballot.rank_position
  from unnest(p_option_ids, p_rank_positions) as ballot(option_id, rank_position);
end;
$$;

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
language sql
security definer
set search_path = public
as $$
  with selected_poll as (
    select id, poll_type from public.polls
    where id = p_poll_id and is_deleted = false
  ), ballot_count as (
    select count(*)::bigint as amount from public.votes where poll_id = p_poll_id
  )
  select
    option_row.id,
    option_row.option_text,
    option_row.image_url,
    option_row.display_order,
    count(entry.option_id) filter (where selected_poll.poll_type = 'single_choice'),
    coalesce(sum(
      case
        when selected_poll.poll_type = 'ranked_choice' and entry.rank_position between 1 and 3
          then 4 - entry.rank_position
        else 0
      end
    ), 0)::bigint,
    ballot_count.amount
  from selected_poll
  join public.poll_options option_row on option_row.poll_id = selected_poll.id
  cross join ballot_count
  left join public.ballot_entries entry
    on entry.poll_id = selected_poll.id and entry.option_id = option_row.id
  group by
    option_row.id,
    option_row.option_text,
    option_row.image_url,
    option_row.display_order,
    selected_poll.poll_type,
    ballot_count.amount;
$$;create or replace function public.admin_create_poll_with_options(
  p_title text,
  p_description text,
  p_poll_type text,
  p_restriction text,
  p_deadline timestamptz,
  p_options jsonb
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
  if p_deadline <= now() then
    raise exception 'Poll deadline must be in the future';
  end if;
  if jsonb_typeof(p_options) is distinct from 'array' then
    raise exception 'Poll options must be a JSON array';
  end if;
  if jsonb_array_length(p_options) < 2 then
    raise exception 'Poll needs at least two options';
  end if;
  if p_poll_type = 'ranked_choice' and jsonb_array_length(p_options) < 3 then
    raise exception 'Ranked-choice polls need at least three options';
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
  vote_resident_type public.resident_type;
  lock_subject text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into voter from public.users where auth_user_id = auth.uid() limit 1;
  select * into poll from public.polls where id = p_poll_id and is_deleted = false limit 1;

  if voter.id is null then
    raise exception 'Registered voter profile not found';
  end if;
  if poll.id is null or poll.deadline <= now() then
    raise exception 'Poll is unavailable or has closed';
  end if;

  lock_subject := case
    when poll.restriction = 'all_owners_and_residents' then 'user:' || voter.id::text
    else 'flat:' || voter.flat_number
  end;
  perform pg_advisory_xact_lock(hashtextextended(p_poll_id::text || ':' || lock_subject, 0));

  select * into status from public._poll_voter_status(p_poll_id, auth.uid());
  if not coalesce(status.eligible, false) then
    raise exception 'You are not eligible to vote in this poll';
  end if;
  if coalesce(status.has_voted, true) then
    raise exception 'A vote has already been recorded for this voter or flat';
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
  if poll.poll_type = 'ranked_choice' and array_length(p_option_ids, 1) <> 3 then
    raise exception 'Ranked-choice ballots must select exactly three options';
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

  if poll.poll_type = 'ranked_choice' and (
    (select min(rank_position) from unnest(p_rank_positions) as ranks(rank_position)) <> 1
    or (select max(rank_position) from unnest(p_rank_positions) as ranks(rank_position)) <> 3
  ) then
    raise exception 'Ranked positions must be exactly 1, 2, and 3';
  end if;

  vote_resident_type := case
    when poll.restriction in ('owners_only_one_per_flat', 'all_owners') then 'owner'::public.resident_type
    when poll.restriction in ('residents_only_one_per_flat', 'all_residents') then 'resident'::public.resident_type
    else null
  end;

  insert into public.votes (poll_id, flat_number, resident_type, voter_user_id, voted_at)
  values (p_poll_id, voter.flat_number, vote_resident_type, voter.id, now());

  insert into public.ballot_entries (poll_id, option_id, rank_position)
  select p_poll_id, ballot.option_id, ballot.rank_position
  from unnest(p_option_ids, p_rank_positions) as ballot(option_id, rank_position);
end;
$$;

drop function public.get_poll_results(uuid);

create function public.get_poll_results(p_poll_id uuid)
returns table (
  option_id uuid,
  option_text text,
  image_url text,
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
    select id, poll_type from public.polls
    where id = p_poll_id and is_deleted = false
  ), ballot_count as (
    select count(*)::bigint as amount from public.votes where poll_id = p_poll_id
  )
  select
    option_row.id,
    option_row.option_text,
    option_row.image_url,
    option_row.display_order,
    count(entry.option_id) filter (where selected_poll.poll_type = 'single_choice'),
    coalesce(sum(
      case
        when selected_poll.poll_type = 'ranked_choice' and entry.rank_position between 1 and 3
          then 4 - entry.rank_position
        else 0
      end
    ), 0)::bigint,
    ballot_count.amount
  from selected_poll
  join public.poll_options option_row on option_row.poll_id = selected_poll.id
  cross join ballot_count
  left join public.ballot_entries entry
    on entry.poll_id = selected_poll.id and entry.option_id = option_row.id
  group by
    option_row.id,
    option_row.option_text,
    option_row.image_url,
    option_row.display_order,
    selected_poll.poll_type,
    ballot_count.amount;
$$;

revoke all on function public.get_poll_results(uuid) from public;
grant execute on function public.get_poll_results(uuid) to authenticated;