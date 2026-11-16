-- Construction progress read RPC for buyer portal, strictly scoped to the buyer's authorized deal project.
create or replace function public.buyer_portal_construction(p_telegram_id bigint, p_deal_id integer)
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'projectId', p.id,
    'projectName', p.name,
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', pm.id,
          'title', pm.title,
          'description', pm.description,
          'storagePath', pm.storage_path,
          'mimeType', pm.mime_type,
          'createdAt', pm.created_at,
          'updatedAt', pm.updated_at
        )
        order by pm.updated_at desc, pm.sort_order asc, pm.id desc
      )
      from public.project_media pm
      where pm.project_id = p.id
        and pm.category = 'CONSTRUCTION'
        and pm.is_active = true
    ), '[]'::jsonb)
  )
  from public.buyer_portal_access(p_telegram_id) a
  join public.deals d on d.id = a.deal_id and d.id = p_deal_id
  join public.units u on u.id = d.unit_id
  join public.floors f on f.id = u.floor_id
  join public.sections s on s.id = f.section_id
  join public.buildings b on b.id = s.building_id
  join public.projects p on p.id = b.project_id
$$;

revoke all on function public.buyer_portal_construction(bigint, integer) from public, anon, authenticated;
grant execute on function public.buyer_portal_construction(bigint, integer) to service_role;
