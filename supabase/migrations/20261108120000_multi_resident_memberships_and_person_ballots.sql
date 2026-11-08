create table if not exists public.user_resident_types (
  user_id uuid not null references public.users(id) on delete cascade,
  resident_type public.resident_type not null,
  created_at timestamptz not null default now(),
  primary key (user_id, resident_type)
);

alter table public.user_resident_types enable row level security;

insert into public.user_resident_types (user_id, resident_type)
select id, resident_type
from public.users
where resident_type is not null
on conflict do nothing;

alter table public.users alter column resident_type drop not null;

create unique index if not exists users_auth_user_id_unique
  on public.users (auth_user_id)
  where auth_user_id is not null;

alter table public.votes
  add column if not exists voter_user_id uuid references public.users(id) on delete set null;

do $$
begin
  if exists (
    select 1
    from public.votes v
    left join public.users u
      on u.flat_number = v.flat_number
     and u.resident_type = v.resident_type
    group by v.id
    having count(u.id) <> 1
  ) then
    raise exception 'Existing votes cannot be mapped to one voter profile; reconcile them before applying this migration';
  end if;
end;
$$;

update public.votes v
set voter_user_id = u.id
from public.users u
where u.flat_number = v.flat_number
  and u.resident_type = v.resident_type
  and v.voter_user_id is null;

alter table public.votes
  drop constraint if exists unique_vote_per_poll_flat,
  drop constraint if exists unique_vote_per_poll_user;

alter table public.votes alter column resident_type drop not null;

create index if not exists votes_poll_flat_idx
  on public.votes (poll_id, flat_number);

create index if not exists votes_poll_resident_type_idx
  on public.votes (poll_id, flat_number, resident_type);

create unique index if not exists votes_poll_voter_user_unique
  on public.votes (poll_id, voter_user_id)
  where voter_user_id is not null;

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
  row_auth_user_id uuid;
  row_resident_type text;
  resident_type_value text;
  row_resident_types public.resident_type[];
  existing_user public.users%rowtype;
  imported_user_id uuid;
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
    row_role := coalesce(nullif(lower(trim(row_data->>'role')), ''), 'regular');
    row_resident_types := array[]::public.resident_type[];

    if jsonb_typeof(row_data->'resident_types') = 'array' then
      for resident_type_value in
        select jsonb_array_elements_text(row_data->'resident_types')
      loop
        resident_type_value := lower(trim(resident_type_value));
        if resident_type_value not in ('owner', 'resident') then
          raise exception 'Invalid resident type % for email %', resident_type_value, row_email;
        end if;
        if not (resident_type_value::public.resident_type = any(row_resident_types)) then
          row_resident_types := array_append(row_resident_types, resident_type_value::public.resident_type);
        end if;
      end loop;
    elsif nullif(trim(row_data->>'resident_type'), '') is not null then
      row_resident_type := lower(trim(row_data->>'resident_type'));
      if row_resident_type not in ('owner', 'resident') then
        raise exception 'Invalid resident type % for email %', row_resident_type, row_email;
      end if;
      row_resident_types := array[row_resident_type::public.resident_type];
    end if;

    if row_email is null or row_email = '' or coalesce(trim(row_data->>'name'), '') = ''
       or coalesce(trim(row_data->>'flat_number'), '') = ''
       or row_role not in ('admin', 'regular') then
      raise exception 'Invalid user row for email %', row_email;
    end if;
    if row_role = 'regular' and cardinality(row_resident_types) = 0 then
      raise exception 'Regular voter % must have at least one resident type', row_email;
    end if;

    row_auth_user_id := nullif(row_data->>'auth_user_id', '')::uuid;
    if row_auth_user_id is null then
      select id into row_auth_user_id
      from auth.users
      where lower(email) = row_email
      limit 1;
    end if;

    select * into existing_user
    from public.users
    where lower(email) = row_email
    limit 1;

    if existing_user.id is not null then
      imported_user_id := existing_user.id;
      update public.users set
        name = trim(row_data->>'name'),
        contact = nullif(trim(row_data->>'contact'), ''),
        flat_number = trim(row_data->>'flat_number'),
        resident_type = row_resident_types[1],
        role = row_role::public.user_role,
        auth_user_id = coalesce(row_auth_user_id, existing_user.auth_user_id)
      where id = imported_user_id;

      delete from public.user_resident_types where user_id = imported_user_id;
    else
      insert into public.users (auth_user_id, email, name, contact, flat_number, resident_type, role)
      values (
        row_auth_user_id,
        row_email,
        trim(row_data->>'name'),
        nullif(trim(row_data->>'contact'), ''),
        trim(row_data->>'flat_number'),
        row_resident_types[1],
        row_role::public.user_role
      )
      returning id into imported_user_id;
    end if;

    insert into public.user_resident_types (user_id, resident_type)
    select imported_user_id, resident_type
    from unnest(row_resident_types) as memberships(resident_type)
    on conflict do nothing;

    rows_imported := rows_imported + 1;
  end loop;

  return rows_imported;
end;
$$;

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
    when 'owners_only_one_per_flat' then exists (
      select 1 from public.user_resident_types m
      where m.user_id = voter.id and m.resident_type = 'owner'
    )
    when 'residents_only_one_per_flat' then exists (
      select 1 from public.user_resident_types m
      where m.user_id = voter.id and m.resident_type = 'resident'
    )
    when 'all_owners' then exists (
      select 1 from public.user_resident_types m
      where m.user_id = voter.id and m.resident_type = 'owner'
    )
    when 'all_residents' then exists (
      select 1 from public.user_resident_types m
      where m.user_id = voter.id and m.resident_type = 'resident'
    )
    when 'one_per_flat' then true
    when 'all_owners_and_residents' then exists (
      select 1 from public.user_resident_types m
      where m.user_id = voter.id
    )
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
      where v.poll_id = p_poll_id and v.voter_user_id = voter.id
    )
    else true
  end;

  return next;
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
