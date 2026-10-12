import { localDay, validDay, formatAmounts,formatExpense } from './report.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const owner = user => user.slot === 'AKMALKHON';
export function scopeSnapshot(user,snapshot) {
  if(owner(user))return snapshot;
  if(!user.cash_desk_id)throw new Error('CASH_NOT_ASSIGNED');
  return {...snapshot,desks:snapshot.desks.filter(d=>d.id===user.cash_desk_id),payments:snapshot.payments.filter(p=>p.cash_desk_id===user.cash_desk_id),expenses:snapshot.expenses.filter(e=>e.cash_desk_id===user.cash_desk_id)};
}
export function amountMinor(text) {
  const s=String(text).trim().replace(',','.');
  if(!/^\d{1,8}(?:\.\d{1,2})?$/.test(s))return null;
  const [whole,part='']=s.split('.'); const n=Number(whole)*100+Number(part.padEnd(2,'0'));
  return n>0&&n<=2147483647?n:null;
}
export function usdDebitMinor(minor,rate) {
  const [whole,part='']=String(rate).split('.');
  const divisor=BigInt(whole)*1000000n+BigInt(part.padEnd(6,'0'));
  if(divisor<=0n)throw new Error('INVALID_EXCHANGE_RATE');
  return Number((BigInt(minor)*1000000n+divisor/2n)/divisor);
}
const choices = entries => ({inline_keyboard:entries.map(([text,callback_data])=>[{text,callback_data}])});
const categories=['Строительные материалы','Зарплата сотрудникам / строителям','Услуги подрядчиков и специалистов','Маркетинг и реклама','Хозяйственные расходы','Прочие расходы'];
const errorText = e => {
  const m=e.message||'';
  if(m.includes('INSUFFICIENT_FUNDS'))return 'Недостаточно средств в выбранной валюте кассы. РКО не создан. Пополните кассу или создайте новый РКО с явным списанием USD по курсу.';
  if(/CASH_ACCESS_DENIED|CRM_USER_INACTIVE/.test(m))return 'Ввод РКО недоступен. Проверьте назначенную кассу, автора РКО и разрешение в CRM.';
  if(/DRAFT_EXPIRED|DRAFT_NOT_FOUND/.test(m))return 'Черновик отменён или истёк. Создайте новый РКО.';
  return 'Не удалось подтвердить запись. Повторите подтверждение этого же черновика: повторная запись защищена от дублей.';
};

export async function cashCommand(bot,user,command,isCallback) {
  const {repo,api}=bot; const id=user.telegram_id;
  const send=(text,markup)=>api.send(id,text,markup);
  if(command==='/cancel'||command==='rcancel') {
    const s=await repo.session(id); if(s?.draft_id)await repo.cancelDraft(s.draft_id,id);
    await repo.clearSession(id); await send('Ввод РКО отменён. Для меню отправьте /start.');return true;
  }
  if(command==='bookpick:income'||command==='bookpick:expense'||command==='/pko'||command==='/rko_list') {
    const kind=command==='bookpick:income'||command==='/pko'?'income':'expense';
    if(owner(user)) {const desks=await repo.cashDesks();await send('Выберите кассу:',choices([['Все кассы',`book:${kind}:ALL:0`],...desks.map(d=>[d.name,`book:${kind}:${d.id}:0`])]));}
    else if(!user.cash_desk_id)await send('Ваша касса ещё не назначена в настройках CRM.');
    else await cashCommand(bot,user,`book:${kind}:${user.cash_desk_id}:0`,true);
    return true;
  }
  const book=/^book:(income|expense):(ALL|[0-9a-f-]{36}):(\d{1,6})$/.exec(command);
  if(book) {
    const [,kind,key,start]=book; const desk=key==='ALL'?null:key; const offset=Number(start);
    if(desk&&!uuid.test(desk))return true;
    if(!owner(user)&&(!desk||desk!==user.cash_desk_id)){await send('Доступ к чужой кассе запрещён.');return true;}
    const fresh=await repo.find(id);if(fresh?.status!=='APPROVED')return true;
    const rows=await repo.ledger(fresh,kind,desk,offset);
    const desks=await repo.cashDesks(); const title=kind==='income'?'ПКО':'РКО';
    const lines=[`${title} · ${desk?(desks.find(d=>d.id===desk)?.name||'Касса'):'Все кассы'} · ${rows.length?'записи '+(offset+1)+'–'+(offset+rows.length):'операций нет'}`];
    for(const r of rows)lines.push(`\n${r.document_number||r.reference||title+'-'+r.id} · ${r.payment_date||r.expense_date}\n${kind==='expense'?formatExpense(r):formatAmounts({[r.currency||'USD']:r.amount_minor})}\n${r.payer_name||r.recipient||''}${r.category?' · '+r.category:''}\n${kind==='expense'?(r.description||'').replace(/\[Касса:\s*[^\]]*\]\s*/gi,'').trim():(r.comment||'')}${!desk?'\nКасса: '+(desks.find(d=>d.id===r.cash_desk_id)?.name||'Не указана'):''}`);
    if(!rows.length)lines.push('Операций больше нет.');
    const nav=[];if(offset>=10)nav.push(['Предыдущие',`book:${kind}:${key}:${offset-10}`]);if(rows.length===10&&offset<999990)nav.push(['Следующие',`book:${kind}:${key}:${offset+10}`]);nav.push(['Выбрать кассу',`bookpick:${kind}`]);
    const check=await repo.find(id);if(check?.status==='APPROVED'&&check.slot===fresh.slot&&check.cash_desk_id===fresh.cash_desk_id)await send(lines.join('\n'),choices(nav));
    return true;
  }
  const post=/^rpost:([0-9a-f-]{36})$/.exec(command);
  if(post) {
    if(!uuid.test(post[1]))return true;
    try {const result=await repo.postExpense(id,post[1]);await repo.clearSession(id);await send(`РКО создан: ${result.reference}\nСписание: ${result.amount} ${result.currency}\nДля списка нажмите /rko_list.`);}
    catch(e){await send(errorText(e),choices([['Повторить подтверждение',command],['Отменить','rcancel']]));}
    return true;
  }
  if(command==='rnew'||command==='/rko') {
    if(!user.can_create_expense||!user.crm_user_id||(!owner(user)&&!user.cash_desk_id)){await send('Для ввода РКО назначьте кассу, автора РКО и разрешение в настройках CRM.');return true;}
    const old=await repo.session(id);if(old?.draft_id)await repo.cancelDraft(old.draft_id,id);
    await repo.saveSession(id,{phase:'desk',payload:{date:localDay(bot.clock())}});
    if(owner(user)){const ds=(await repo.cashDesks()).filter(d=>d.code!=='BANK_ACCOUNT'&&!/бартер/i.test(d.name));await send('Из какой кассы списать расход?',choices(ds.map(d=>[d.name,`rdesk:${d.id}`])));}
    else await cashCommand(bot,user,`rdesk:${user.cash_desk_id}`,true);
    return true;
  }
  if(command.startsWith('/')||(isCallback&&!command.startsWith('r')))return false;
  const s=await repo.session(id);
  if(!s||command.startsWith('/')||(!command.startsWith('r')&&isCallback))return false;
  if(s.desk&&!owner(user)&&s.desk!==user.cash_desk_id){await repo.clearSession(id);await send('Назначенная касса изменилась. Начните новый РКО.');return true;}
  if(!user.can_create_expense||!user.crm_user_id){await repo.clearSession(id);await send('Право ввода РКО отозвано.');return true;}
  const p=s.payload;
  const next=async(phase,prompt,markup)=>{await repo.saveSession(id,{...s,phase,payload:p});await send(prompt,markup);};
  if(s.phase==='desk'&&command.startsWith('rdesk:')) {
    const desk=command.slice(6);const ds=await repo.cashDesks();const d=ds.find(x=>x.id===desk);
    if(!d||d.code==='BANK_ACCOUNT'||/бартер/i.test(d.name)||(!owner(user)&&desk!==user.cash_desk_id)){await send('Касса недоступна.');return true;}
    s.desk=desk;await next('currency','Выберите валюту фактического расхода:',choices([['Сомони (TJS)','rval:TJS'],['Доллары (USD)','rval:USD']]));return true;
  }
  if(s.phase==='currency'&&/^rval:(USD|TJS)$/.test(command)){p.currency=command.slice(5);await next('amount',`Введите сумму в ${p.currency}, например 1500,50.`);return true;}
  if(s.phase==='amount'&&!isCallback) {
    const n=amountMinor(command);if(n===null){await send('Введите положительную сумму, максимум два знака после запятой.');return true;}p.amount_minor=n;
    if(p.currency==='TJS')await next('source','Из какой валюты кассы списать?',choices([['Списать сомони','rsrc:TJS'],['Списать USD по курсу','rsrc:USD']]));
    else {p.source_currency='USD';await next('date','Дата расхода: нажмите «Сегодня» или введите ГГГГ-ММ-ДД.',choices([['Сегодня','rdate:today']]));}return true;
  }
  if(s.phase==='source'&&/^rsrc:(TJS|USD)$/.test(command)){p.source_currency=command.slice(5);if(p.source_currency==='USD')await next('rate','Введите фактический курс: сколько сомони за 1 USD, например 9,27.');else await next('date','Дата: «Сегодня» или ГГГГ-ММ-ДД.',choices([['Сегодня','rdate:today']]));return true;}
  if(s.phase==='rate'&&!isCallback){const value=command.replace(',','.');const rate=Number(value);if(!/^\d{1,5}(\.\d{1,6})?$/.test(value)||rate<=0||rate>10000){await send('Введите положительный фактический курс.');return true;}const debit=usdDebitMinor(p.amount_minor,value);if(debit<=0||debit>2147483647){await send('Списание USD по этому курсу вне допустимого диапазона. Проверьте курс.');return true;}p.exchange_rate=value;await next('date','Дата: «Сегодня» или ГГГГ-ММ-ДД.',choices([['Сегодня','rdate:today']]));return true;}
  if(s.phase==='date'){const date=command==='rdate:today'?localDay(bot.clock()):command;if(!validDay(date)||date>localDay(bot.clock())){await send('Введите существующую дату ГГГГ-ММ-ДД, не в будущем.');return true;}p.date=date;await next('category','Выберите статью или напишите её название:',choices(categories.map((name,i)=>[name,`rcat:${i}`])));return true;}
  if(s.phase==='category'){const c=/^rcat:(\d)$/.exec(command);const name=c?categories[Number(c[1])]:command;if(!name||name.length>150||/конвертаци|перемещени|INTERNAL_TRANSFER|CURRENCY_CONVERSION/i.test(name)){await send('Укажите обычную статью расхода. Перемещения оформляются в CRM.');return true;}p.category=name;await next('recipient','Кому оплачено? Введите получателя.');return true;}
  if(s.phase==='recipient'&&!isCallback){if(command.length<1||command.length>200){await send('Получатель: от 1 до 200 символов.');return true;}p.recipient=command;await next('description','За что оплачено? Введите назначение расхода.');return true;}
  if(s.phase==='description'&&!isCallback){if(command.length<1||command.length>1000){await send('Назначение: от 1 до 1000 символов.');return true;}p.description=command;
    const draft=await repo.draft(user,s.desk,p);await repo.saveSession(id,{...s,phase:'confirm',draft_id:draft.id,payload:p});
    const desks=await repo.cashDesks();let text=`Проверьте РКО:\nКасса: ${desks.find(d=>d.id===s.desk)?.name}\nДата: ${p.date}\nРасход: ${formatAmounts({[p.currency]:p.amount_minor})}\nСтатья: ${p.category}\nПолучатель: ${p.recipient}\nНазначение: ${p.description}`;
    if(p.currency==='TJS'&&p.source_currency==='USD')text+=`\nУчётное списание: ${(usdDebitMinor(p.amount_minor,p.exchange_rate)/100).toFixed(2)} USD по курсу ${p.exchange_rate}. Сумма TJS сохранится в РКО.`;
    await send(text,choices([['Подтвердить и создать РКО',`rpost:${draft.id}`],['Отменить','rcancel']]));return true;
  }
  await send('Продолжите ввод по последнему вопросу или отправьте /cancel.');return true;
}
