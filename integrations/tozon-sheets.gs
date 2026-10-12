// Bound script for the existing Сохтмони Автовокзал spreadsheet.
// Enable the Google Sheets advanced service. Set Script Property TOZON_SHEETS_SECRET.
const TOZON_SPREADSHEET_ID = '1R1V3lM6JEY9_jDXoDDdORiJGJCt8jjBz9KT6uC5_Ht0';
const TOZON_ALLOWED_SHEETS = ['Касса Акмалхон', 'Касса Илхомчон'];
function tozonResponse(value) { return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON); }
function doPost(e) {
  const lock=LockService.getScriptLock();
  try {
    const request=JSON.parse(e.postData.contents);
    const secret=PropertiesService.getScriptProperties().getProperty('TOZON_SHEETS_SECRET');
    if(!secret||secret.length<32||!Number.isSafeInteger(request.timestamp)||Math.abs(Date.now()-request.timestamp)>300000||typeof request.payload!=='string')return tozonResponse({ok:false});
    const expected=Utilities.computeHmacSha256Signature(request.timestamp+'.'+request.payload,secret).map(b=>('0'+((b+256)%256).toString(16)).slice(-2)).join('');
    let difference=expected.length^(request.signature||'').length;
    for(let i=0;i<expected.length;i++)difference|=expected.charCodeAt(i)^((request.signature||'').charCodeAt(i)||0);
    if(difference)return tozonResponse({ok:false});
    const p=JSON.parse(request.payload);
    if(!/^[0-9a-f-]{36}$/.test(p.id)||!TOZON_ALLOWED_SHEETS.includes(p.sheet)||!/^\d{4}-\d{2}-\d{2}$/.test(p.date)||!Number.isSafeInteger(p.amount_minor)||p.amount_minor<=0||!['USD','TJS'].includes(p.currency)||!p.recipient||!p.description||!p.category) return tozonResponse({ok:false});
    lock.waitLock(25000);
    const book=SpreadsheetApp.openById(TOZON_SPREADSHEET_ID),sheet=book.getSheetByName(p.sheet);
    if(!sheet)throw new Error('SHEET_MISSING');
    const marker='TOZON-RKO:'+p.id;
    const notes=sheet.getRange(5,6,sheet.getMaxRows()-4,1).getNotes();
    const existing=notes.findIndex(r=>r[0]===marker);
    if(existing>=0)return tozonResponse({ok:true,id:p.id,row:existing+5});
    const rows=sheet.getRange(5,1,sheet.getMaxRows()-4,9).getValues();
    const totalIndex=rows.findIndex(r=>String(r[1]).trim()==='ИТОГО:');
    if(totalIndex<0)throw new Error('TOTAL_ROW_MISSING');
    let last=-1;
    for(let i=0;i<totalIndex;i++)if(rows[i][0] instanceof Date||typeof rows[i][0]==='number')last=i;
    if(last<0)throw new Error('EXEMPLAR_MISSING');
    let row=last+6,inserted=false;
    const totals=sheet.getRange(totalIndex+5,1,1,9).getFormulas()[0];
    if(row>=totalIndex+5||rows[row-5].some(v=>v!=='')) {row=totalIndex+5;sheet.insertRowBefore(row);inserted=true;}
    const exemplar=sheet.getRange(last+5,1,1,9),destination=sheet.getRange(row,1,1,9);
    exemplar.copyTo(destination,SpreadsheetApp.CopyPasteType.PASTE_FORMAT,false);
    exemplar.copyTo(destination,SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION,false);
    const amount=p.amount_minor/100,rate=Number(p.exchange_rate)||null;
    const usd=p.currency==='USD'?amount:rate?Number((amount/rate).toFixed(2)):null;
    const tjs=p.currency==='TJS'?amount:rate?Number((amount*rate).toFixed(2)):null;
    const date=(Date.parse(p.date+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000;
    // Literal stringValue blocks spreadsheet formula injection. Amounts and identifier note
    // are committed in one Sheets batch so a lost HTTP acknowledgement is safe to retry.
    const literal=v=>v===null?{}:typeof v==='number'?{userEnteredValue:{numberValue:v}}:{userEnteredValue:{stringValue:String(v)}};
    const cells=[date,p.recipient,null,usd,p.category,(p.reference||'РКО')+' · '+p.description,rate,tjs===null?null:-tjs,usd===null?null:-usd].map(literal);
    cells[5].note=marker;
    SpreadsheetApp.flush();
    const requests=[{updateCells:{range:{sheetId:sheet.getSheetId(),startRowIndex:row-1,endRowIndex:row,startColumnIndex:0,endColumnIndex:9},rows:[{values:cells}],fields:'userEnteredValue,note'}}];
    if(inserted)for(const col of [2,3,7]) {
      const letter=String.fromCharCode(65+col);
      if(totals[col])requests.push({updateCells:{range:{sheetId:sheet.getSheetId(),startRowIndex:row,endRowIndex:row+1,startColumnIndex:col,endColumnIndex:col+1},rows:[{values:[{userEnteredValue:{formulaValue:totals[col].replace(new RegExp(':'+letter+(row-1)+'(?=[)\\s])','g'),':'+letter+row)}}]}],fields:'userEnteredValue'}});
    }
    Sheets.Spreadsheets.batchUpdate({requests},TOZON_SPREADSHEET_ID);
    return tozonResponse({ok:true,id:p.id,row});
  } catch(error) { return tozonResponse({ok:false,error:'SYNC_FAILED'}); }
  finally {if(lock.hasLock())lock.releaseLock();}
}
