BEGIN;
UPDATE public.layout_rooms r SET description_ru =
 r.name_ru || ' — ' || trim(to_char(r.area,'FM999990.99')) || ' м². ' ||
 CASE r.room_type
 WHEN 'LIVING' THEN 'Пространство для отдыха и общения. Здесь можно организовать мягкую зону и место для семейных вечеров; расстановку мебели стоит выбирать с учётом размеров помещения.'
 WHEN 'BEDROOM' THEN CASE WHEN r.name_ru ILIKE '%детск%' THEN 'Комнату можно оформить как детскую, совместив спальное место, хранение и уголок для занятий. Размеры мебели и проходы уточняются при разработке интерьера.' ELSE 'Личное пространство для сна и спокойного отдыха. Можно продумать размещение кровати и хранения с учётом формы комнаты и расположения проёмов.' END
 WHEN 'KITCHEN' THEN 'Отдельное помещение для приготовления пищи. Рабочую поверхность, технику и возможную обеденную зону можно подобрать под привычки семьи и фактические размеры кухни.'
 WHEN 'HALL' THEN 'Входная зона, связывающая помещения квартиры. Здесь можно предусмотреть место для верхней одежды и обуви, сохранив свободные проходы.'
 WHEN 'BATHROOM' THEN CASE WHEN r.name_ru ILIKE '%туалет%' THEN 'Отдельная санитарная зона для повседневного удобства. Компоновка оборудования подбирается по проекту и расположению коммуникаций.' ELSE 'Помещение для повседневных водных процедур. Размещение ванны или душевой, умывальника и хранения зависит от проекта коммуникаций и выбранного оборудования.' END
 ELSE 'Назначение и обустройство помещения можно адаптировать к потребностям владельца с учётом проекта.'
 END, updated_at=now()::text
FROM public.layout_types l WHERE r.layout_type_id=l.id AND l.project_id=3
AND r.description_ru='Площадь по подписи помещения на чертеже PDF от 16.10.2025.';

UPDATE public.layout_types l SET
 description=coalesce(nullif(description,''),description_ru),
 description_ru= CASE WHEN rooms=0 THEN 'Студия' ELSE rooms::text || '-комнатная квартира' END ||
 ' общей площадью ' || trim(to_char(area_m2_x100/100.0,'FM999990.99')) || ' м². ' ||
 CASE WHEN ceiling_height IS NOT NULL THEN 'Высота потолков ' || trim(to_char(ceiling_height,'FM990.99')) || ' м добавляет ощущение пространства и позволяет продумать освещение под свой интерьер. ' ELSE '' END ||
 CASE WHEN EXISTS(SELECT 1 FROM public.layout_rooms r WHERE r.layout_type_id=l.id AND r.room_type='KITCHEN') THEN 'Отдельная кухня помогает разграничить приготовление пищи и отдых. ' ELSE '' END ||
 CASE WHEN code LIKE 'CEILING315%' THEN 'Состав и площади отдельных помещений уточняются по плану этого этажа. ' ELSE '' END ||
 'Варианты меблировки на иллюстрациях служат примером оформления; состав отделки и комплектацию необходимо сверять с договором.',
 updated_at=now()::text
WHERE project_id=3 AND (coalesce(description_ru,'')='' OR description_ru LIKE 'Площади помещений по подписям PDF%' OR description_ru LIKE 'Высота потолков 3,15 м по указанию владельца.%');

INSERT INTO public.layout_rooms(layout_type_id,room_number,room_type,name_ru,area,description_ru,position_x_percent,position_y_percent,sort_order,is_active,created_at,updated_at)
SELECT l.id,v.n,v.kind,v.name,NULL,v.description,0,0,v.n,true,now()::text,now()::text
FROM public.layout_types l CROSS JOIN (VALUES
(1,'LIVING','Гостиная','На представленной визуализации гостиная выделена как зона отдыха: показаны диван и место для общения. Это пример расстановки мебели, а не подтверждение комплектации квартиры. Площадь комнаты требует уточнения по техническому плану.'),
(2,'BEDROOM','Спальня','На визуализации показана спальня с кроватью и местом для хранения. При разработке интерьера можно адаптировать расстановку под потребности владельца. Площадь и размеры помещения требуют уточнения.'),
(3,'KITCHEN','Кухня и обеденная зона','На визуализации показаны кухонная рабочая зона и обеденный стол. Такое оформление объединяет приготовление пищи и семейные обеды в одном помещении. Фактическая комплектация и площадь уточняются по проекту.'),
(4,'BATHROOM','Ванная','На визуализации показана ванная с санитарным оборудованием. Изображение иллюстрирует возможный вариант оформления; состав оборудования и размеры помещения уточняются по проекту.')
) v(n,kind,name,description)
WHERE l.id=1 AND l.project_id=3 AND l.code='2Б' AND NOT EXISTS(SELECT 1 FROM public.layout_rooms r WHERE r.layout_type_id=l.id AND r.room_number=v.n);

INSERT INTO public.layout_features(layout_type_id,icon_key,text_ru,sort_order,is_active,created_at,updated_at)
SELECT id,'Sparkles','Высота потолков ' || trim(to_char(ceiling_height,'FM990.99')) || ' м — больше возможностей для освещения и оформления интерьера',10,true,now()::text,now()::text
FROM public.layout_types l WHERE project_id=3 AND ceiling_height>=3
AND NOT EXISTS(SELECT 1 FROM public.layout_features f WHERE f.layout_type_id=l.id AND f.text_ru LIKE 'Высота потолков%');
INSERT INTO public.layout_features(layout_type_id,icon_key,text_ru,sort_order,is_active,created_at,updated_at)
SELECT l.id,'Sparkles','Отдельная кухня — приготовление пищи отделено от жилой зоны',20,true,now()::text,now()::text
FROM public.layout_types l WHERE project_id=3 AND EXISTS(SELECT 1 FROM public.layout_rooms r WHERE r.layout_type_id=l.id AND r.room_type='KITCHEN' AND r.area IS NOT NULL)
AND NOT EXISTS(SELECT 1 FROM public.layout_features f WHERE f.layout_type_id=l.id AND f.text_ru LIKE 'Отдельная кухня%');
COMMIT;