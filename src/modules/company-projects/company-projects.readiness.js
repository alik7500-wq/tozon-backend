// An advisory snapshot, never an authorization or production activation decision.
export function projectReadiness(snapshot) {
 const checks=[];
 const add=(code,passed,label,action,applicable=true)=>checks.push({code,status:!applicable?'NOT_CHECKED':passed?'PASS':'BLOCKED',label,action:!applicable?'Проверка выполняется после назначения сотруднику соответствующих прав.':passed?'':action});
 const members=snapshot.members;
 add('DIRECTOR',snapshot.director_present,'Директор объекта','Укажите подтверждённое ФИО директора.');
 add('AUTHORITY',snapshot.authority_present,'Основание полномочий','Укажите документ, номер и дату полномочий директора.');
 add('PARTNERS',snapshot.partner_count>=2&&Number(snapshot.partner_total)===100,'Партнёры и доли','Укажите реальных партнёров и доли с итогом 100%.');
 add('COMPLEXES',snapshot.complex_count>0&&snapshot.archived_complex_count===0,'Привязка действующих ЖК','Закрепите действующие ЖК за этим проектом.');
 add('MEMBERS',members.length>0,'Состав сотрудников','Подготовьте подтверждённый список сотрудников этого проекта.');
 add('ACCESS',members.length>0&&members.every(m=>m.active&&m.project_only&&m.roster_enabled&&m.access_enabled&&m.sections.length>0),'Изолированный доступ сотрудников','Проверьте активность, проектный профиль и отдельные права каждого сотрудника. Планируемое назначение само не даёт доступа.');
 const dependencies={'deals.write':['deals.view','leads.view','inventory.view'],'contracts.sign':['deals.view'],'contracts.cancel':['deals.view'],'contracts.terminate':['deals.view'],'finance.payments.write':['finance.payments','deals.view'],'finance.expenses.write':['finance.expenses'],'construction.stock.write':['construction.stock'],'documents.manage':['documents.print','deals.view']};
 add('RIGHTS',members.every(m=>m.write_sections.every(w=>dependencies[w]?.every(r=>m.sections.includes(r)))&&(!m.sections.includes('documents.print')||m.sections.includes('deals.view'))),'Связанные права чтения и операций','Согласуйте права записи с необходимыми разделами чтения.',members.length>0);
 const cash=members.some(m=>m.sections.some(s=>['finance.payments','finance.expenses'].includes(s)));
 const stock=members.some(m=>m.sections.includes('construction.stock'));
 const docs=members.some(m=>m.sections.includes('documents.print'));
 add('CASH',!cash||snapshot.cash_count>0,'Кассы проекта','Закрепите действующую кассу проекта для финансовых разделов.',cash);
 add('WAREHOUSES',!stock||snapshot.warehouse_count>0,'Склады проекта','Закрепите действующий склад проекта.',stock);
 add('LEGACY_DATA',snapshot.deal_scope_issues===0&&snapshot.payment_scope_issues===0&&snapshot.expense_scope_issues===0,'Принадлежность договоров и движений','Разберите непривязанные и противоречивые связи договоров, клиентов, ЖК и касс. Автоматический перенос не выполняется.');
 add('TEMPLATES',!docs||(snapshot.complex_count>0&&snapshot.template_gaps===0),'Наличие бланков RU / TJ','Добавьте действующие бланки договора и графика для своих ЖК или явно общего назначения.',docs);
 add('STORAGE',!docs||snapshot.private_bucket?.private===true,'Закрытое хранилище документов','Проверьте закрытый bucket при первой разрешённой тестовой загрузке.',docs);
 checks.push({code:'MANUAL_VALIDATION',status:'REVIEW',label:'Проверка перед запуском',action:'Отдельно подтвердите реальные назначения и доли, тексты бланков, печать и вложения в браузере, перенос старого учёта и внешние интеграции. Эта проверка не подтверждает готовность к рабочему запуску.'});
 return {project_id:snapshot.project_id,revision:snapshot.revision,checked_at:snapshot.checked_at,configuration_ready:checks.every(c=>c.status!=='BLOCKED'),production_ready:false,checks};
}
