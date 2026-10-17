begin;
do $$ declare n integer; begin
if not exists(select 1 from tours_360 where id=30 and project_id=3 and entity_type='UNIT' and entity_id=83 and is_active=false) then raise exception 'Tour scope changed'; end if;
if (select count(*) from panorama_360 where tour_id=30 and id in(55,56,57,58,59))<>5 then raise exception 'Panorama scope changed'; end if;
if (select count(*) from panorama_hotspots where panorama_id in(55,56,57,58,59))<>8 then raise exception 'Hotspot count changed'; end if;
if exists(select 1 from panorama_hotspots h join (values(64,59,55),(66,57,55),(67,57,55),(68,57,55),(69,56,55),(70,55,56),(71,55,57),(72,55,56)) e(id,source,target) on h.id=e.id where h.panorama_id<>e.source or h.target_panorama_id<>e.target) then raise exception 'Existing navigation changed'; end if;
update panorama_hotspots h set
panorama_id=v.source, target_panorama_id=v.target, label=v.label,
yaw=case when h.id=68 then 243 else h.yaw end,
pitch=case when h.id=68 then -5 else h.pitch end,
updated_at=now()::text
from (values(64,59,55,'В коридор'),(66,57,55,'В коридор'),(67,57,58,'В кухню'),(68,58,57,'В гостиную'),(69,56,55,'В коридор'),(72,55,59,'В санузел')) v(id,source,target,label)
where h.id=v.id and h.panorama_id in (55,56,57,58,59);
get diagnostics n=row_count; if n<>6 then raise exception 'Expected 6 rows, got %',n; end if;
if exists(select 1 from panorama_hotspots h where h.panorama_id in(55,56,57,58,59) and not exists(select 1 from panorama_hotspots r where r.panorama_id=h.target_panorama_id and r.target_panorama_id=h.panorama_id)) then raise exception 'Missing reverse edge'; end if;
end $$;
commit;
select h.id,p.name as source,h.label,q.name as target,h.yaw,h.pitch from panorama_hotspots h join panorama_360 p on p.id=h.panorama_id join panorama_360 q on q.id=h.target_panorama_id where p.tour_id=30 order by h.panorama_id,h.id;
