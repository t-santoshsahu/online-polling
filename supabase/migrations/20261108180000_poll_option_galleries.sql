alter table public.poll_options
  add column if not exists image_urls text[] not null default '{}';

update public.poll_options
set image_urls = array[image_url]
where image_url is not null and cardinality(image_urls) = 0;

create or replace function public.admin_create_scoped_poll_with_gallery(
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
  new_poll_id uuid;
  option_data jsonb;
begin
  if jsonb_typeof(p_options) is distinct from 'array' then
    raise exception 'Poll options must be an array';
  end if;

  for option_data in select value from jsonb_array_elements(p_options)
  loop
    if jsonb_typeof(option_data->'image_urls') is distinct from 'array' then
      raise exception 'Option image URLs must be an array';
    end if;
    if jsonb_array_length(option_data->'image_urls') > 20 then
      raise exception 'An option can have at most 20 images';
    end if;
    if exists (
      select 1 from jsonb_array_elements(option_data->'image_urls') as image(value)
      where jsonb_typeof(image.value) <> 'string'
         or trim(image.value #>> '{}') !~* '^https?://'
    ) then
      raise exception 'Image URLs must use HTTP or HTTPS';
    end if;
    if nullif(trim(option_data->>'image_url'), '') is distinct from
       nullif(trim(option_data->'image_urls'->>0), '') then
      raise exception 'The primary image must match the first gallery image';
    end if;
  end loop;

  new_poll_id := public.admin_create_scoped_poll_with_options(
    p_title, p_description, p_poll_type, p_restriction, p_deadline,
    p_options, p_flat_scope, p_flat_numbers, p_result_visibility
  );

  update public.poll_options as poll_option
  set image_urls = array(
    select trim(image.value)
    from jsonb_array_elements_text(submitted_option.value->'image_urls') with ordinality as image(value, position)
    order by image.position
  )
  from jsonb_array_elements(p_options) with ordinality as submitted_option(value, position)
  where poll_option.poll_id = new_poll_id
    and poll_option.display_order = submitted_option.position;

  return new_poll_id;
end;
$$;

revoke all on function public.admin_create_scoped_poll_with_gallery(text, text, text, text, timestamptz, jsonb, text, text[], text) from public, anon;
grant execute on function public.admin_create_scoped_poll_with_gallery(text, text, text, text, timestamptz, jsonb, text, text[], text) to authenticated;