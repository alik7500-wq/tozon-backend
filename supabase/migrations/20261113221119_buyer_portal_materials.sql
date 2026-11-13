create table public.buyer_portal_documents (
 id uuid primary key default gen_random_uuid(),deal_id integer not null references public.deals(id),
 owner_lead_id integer not null references public.leads(id),title text not null check(length(title) between 1 and 150),
 kind text not null check(kind in ('CONTRACT','SCHEDULE','ACT','APPENDIX','OTHER')),
 language text not null default 'tj' check(language in ('tj','ru')),version integer not null default 1 check(version>0),
 is_signed_original boolean not null default false,storage_path text not null unique,
 mime_type text not null check(mime_type in ('application/pdf','image/png','image/jpeg')),
 file_size integer not null check(file_size>0 and file_size<=12582912),sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 status text not null default 'DRAFT' check(status in ('DRAFT','PUBLISHED','REVOKED')),
 created_by integer not null references public.users(id),created_at timestamptz not null default now(),
 published_by integer references public.users(id),published_at timestamptz,
 check(status<>'PUBLISHED' or (published_by is not null and published_at is not null)),
 check(storage_path in ('deals/'||deal_id||'/'||id||'.pdf','deals/'||deal_id||'/'||id||'.png','deals/'||deal_id||'/'||id||'.jpg'))
);
create index buyer_portal_documents_deal on public.buyer_portal_documents(deal_id,status);
alter table public.buyer_portal_documents enable row level security;
revoke all on public.buyer_portal_documents from public,anon,authenticated;
grant select,insert,update on public.buyer_portal_documents to service_role;
create function public.buyer_portal_document_immutable() returns trigger
language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if TG_OP='DELETE' then raise exception 'BUYER_DOCUMENT_IMMUTABLE';end if;
 if (to_jsonb(new)-array['status','published_by','published_at']) is distinct from (to_jsonb(old)-array['status','published_by','published_at'])
   or (old.status='REVOKED' and new.status<>'REVOKED')
   or (old.status='PUBLISHED' and (new.status='DRAFT' or new.published_by is distinct from old.published_by or new.published_at is distinct from old.published_at))
 then raise exception 'BUYER_DOCUMENT_IMMUTABLE';end if;
 return new;
end $$;
create trigger buyer_portal_document_immutable before update or delete on public.buyer_portal_documents for each row execute function public.buyer_portal_document_immutable();
revoke all on function public.buyer_portal_document_immutable() from public,anon,authenticated;
grant execute on function public.buyer_portal_document_immutable() to service_role;

-- Storage bucket has no public policies. Private originals are never uploaded through Cloudinary.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('buyer-documents','buyer-documents',false,12582912,array['application/pdf','image/png','image/jpeg'])
on conflict(id) do nothing;
do $$begin if exists(select 1 from storage.buckets where id='buyer-documents' and public=true) then raise exception 'BUYER_DOCUMENT_BUCKET_MUST_BE_PRIVATE';end if;end $$;
create policy buyer_documents_server_only on storage.objects as restrictive for all to anon,authenticated
using(bucket_id<>'buyer-documents') with check(bucket_id<>'buyer-documents');
alter table public.buyer_portal_audit add column document_id uuid references public.buyer_portal_documents(id);

create function public.buyer_portal_register_document(p_document jsonb)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare owner_id integer; next_version integer; doc_id uuid:=(p_document->>'id')::uuid;
begin
 select lead_id into owner_id from public.deals where id=(p_document->>'deal_id')::integer and status='SIGNED' for update;
 if not found or owner_id is distinct from (p_document->>'owner_lead_id')::integer then raise exception 'BUYER_DOCUMENT_UNAVAILABLE';end if;
 select coalesce(max(version),0)+1 into next_version from public.buyer_portal_documents
   where deal_id=(p_document->>'deal_id')::integer and kind=p_document->>'kind' and language=p_document->>'language';
 insert into public.buyer_portal_documents(id,deal_id,owner_lead_id,title,kind,language,version,is_signed_original,storage_path,mime_type,file_size,sha256,created_by)
 values(doc_id,(p_document->>'deal_id')::integer,owner_id,p_document->>'title',p_document->>'kind',p_document->>'language',next_version,
 (p_document->>'is_signed_original')::boolean,p_document->>'storage_path',p_document->>'mime_type',(p_document->>'file_size')::integer,p_document->>'sha256',(p_document->>'created_by')::integer);
 insert into public.buyer_portal_audit(event,lead_id,actor_user_id,document_id) values('DOCUMENT_UPLOADED',owner_id,(p_document->>'created_by')::integer,doc_id);
 return doc_id;
end $$;

create function public.buyer_portal_publish_document(p_deal_id integer,p_id uuid,p_owner integer,p_actor integer,p_action text)
returns text language plpgsql security invoker set search_path=public,pg_temp as $$
declare owner_id integer; item public.buyer_portal_documents; result text;
begin
 select lead_id into owner_id from public.deals where id=p_deal_id and status='SIGNED' for share;
 if not found or owner_id is distinct from p_owner then raise exception 'BUYER_DOCUMENT_UNAVAILABLE';end if;
 select * into item from public.buyer_portal_documents where id=p_id and deal_id=p_deal_id and owner_lead_id=owner_id for update;
 if not found or item.status='REVOKED' or p_action is null or p_action not in ('PUBLISH','REVOKE') then raise exception 'BUYER_DOCUMENT_UNAVAILABLE';end if;
 if p_action='PUBLISH' then
   if item.status='PUBLISHED' then return item.status;end if;
   update public.buyer_portal_documents set status='PUBLISHED',published_by=p_actor,published_at=now() where id=p_id;
   result:='PUBLISHED';
 else update public.buyer_portal_documents set status='REVOKED' where id=p_id;result:='REVOKED';end if;
 insert into public.buyer_portal_audit(event,lead_id,actor_user_id,document_id) values('DOCUMENT_'||result,owner_id,p_actor,p_id);
 return result;
end $$;
revoke all on function public.buyer_portal_register_document(jsonb),public.buyer_portal_publish_document(integer,uuid,integer,integer,text) from public,anon,authenticated;
grant execute on function public.buyer_portal_register_document(jsonb),public.buyer_portal_publish_document(integer,uuid,integer,integer,text) to service_role;

create function public.buyer_portal_materials(p_telegram_id bigint,p_deal_id integer)
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
 select jsonb_build_object(
 'plan2d',l.technical_plan_path,'plan3d',coalesce(l.furnished_plan_path,l.image_path),
 'tour',(select jsonb_build_object('id',t.id,'name',t.name,'panoramas',coalesce((select jsonb_agg(
   jsonb_build_object('id',x.id,'name',x.name,'storagePath',x.storage_path,'yaw',x.initial_yaw,'pitch',x.initial_pitch,'fov',x.initial_fov,
     'hotspots',coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'label',h.label,'yaw',h.yaw,'pitch',h.pitch,'targetId',h.target_panorama_id))
       from public.panorama_hotspots h join public.panorama_360 target on target.id=h.target_panorama_id
       where h.panorama_id=x.id and h.hotspot_type='NAVIGATION' and target.tour_id=t.id
       and (target.entity_type is null or (target.entity_type='UNIT' and target.entity_id=u.id))),'[]'::jsonb)) order by x.sort_order,x.id)
   from public.panorama_360 x where x.tour_id=t.id and (x.entity_type is null or (x.entity_type='UNIT' and x.entity_id=u.id))),'[]'::jsonb))
   from public.tours_360 t where t.is_active=true and t.project_id=b.project_id and t.entity_type='UNIT' and t.entity_id=u.id
   order by t.id desc limit 1),
 'documents',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'kind',x.kind,'language',x.language,'version',x.version,
   'isSignedOriginal',x.is_signed_original,'publishedAt',x.published_at,'storagePath',x.storage_path,'mime',x.mime_type,'size',x.file_size,'sha256',x.sha256)
   order by x.is_signed_original desc,x.created_at desc,x.id)
   from public.buyer_portal_documents x where x.deal_id=d.id and x.owner_lead_id=d.lead_id and x.status='PUBLISHED'),'[]'::jsonb))
 from public.buyer_portal_access(p_telegram_id) a join public.deals d on d.id=a.deal_id and d.id=p_deal_id
 join public.units u on u.id=d.unit_id join public.floors f on f.id=u.floor_id
 join public.sections s on s.id=f.section_id join public.buildings b on b.id=s.building_id
 left join public.layout_types l on l.id=u.layout_type_id and l.project_id=b.project_id and l.archived_at is null
$$;
revoke all on function public.buyer_portal_materials(bigint,integer) from public,anon,authenticated;
grant execute on function public.buyer_portal_materials(bigint,integer) to service_role;
