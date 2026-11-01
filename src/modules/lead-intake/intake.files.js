import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
import { AppError } from '../../shared/errors/errorHandler.js';
export function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/)[0];
  const delimiter = [';', ',', '\t'].sort((a,b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = []; let row = [], value = '', quoted = false;
  const pushCell = () => { row.push(value); value = ''; if(row.length > 60) throw new AppError('В файле больше 60 столбцов',400); };
  const pushRow = () => { pushCell(); if(row.some(v=>v.trim()))rows.push(row); row=[]; if(rows.length>501)throw new AppError('Максимум 500 лидов в одном файле',400); };
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"') { if(quoted && text[i+1]==='"'){value+='"';i++;}else quoted=!quoted; }
    else if(c===delimiter && !quoted)pushCell();
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;pushRow();}
    else value+=c;
  }
  if(quoted)throw new AppError('Незакрытые кавычки в CSV',400);
  if(value||row.length)pushRow();
  return rows;
}
function cellText(value) {
  if(value == null)return '';
  if(value instanceof Date)return value.toISOString();
  if(typeof value==='object') {
    if(value.formula || value.sharedFormula)throw new AppError('Удалите формулы из импортируемого листа: вставьте только значения',400);
    if(value.richText)return value.richText.map(p=>p.text).join('');
    return String(value.text ?? '');
  }
  return String(value);
}
export async function readIntakeFile(file) {
  if(!file)throw new AppError('Выберите файл Excel (.xlsx) или CSV',400);
  let sheets;
  if(/\.csv$/i.test(file.originalname)) {
    const text = new TextDecoder('utf-8',{fatal:true}).decode(file.buffer);
    sheets=[{name:'CSV',rows:parseCsv(text)}];
  } else if(/\.xlsx$/i.test(file.originalname)) {
    const zip=new PizZip(file.buffer);
    const expanded=Object.values(zip.files).reduce((n,f)=>n+(f._data?.uncompressedSize || 0),0);
    if(expanded>20*1024*1024 || Object.keys(zip.files).length>1000)throw new AppError('Слишком большой Excel: сохраните нужный лист в CSV',400);
    const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(file.buffer);
    sheets=workbook.worksheets.slice(0,10).map(sheet=>{
      if(sheet.rowCount>501 || sheet.columnCount>60)throw new AppError('Максимум 500 строк и 60 столбцов на листе',400);
      const rows=[];sheet.eachRow(row=>{const cells=[];for(let i=1;i<=Math.min(sheet.columnCount,60);i++)cells.push(cellText(row.getCell(i).value));if(cells.some(v=>v.trim()))rows.push(cells)});
      return {name:sheet.name,rows};
    });
  } else throw new AppError('Поддерживаются .xlsx и .csv (UTF-8)',400);
  return sheets.filter(s=>s.rows.length>1).map(s=>({name:s.name,headers:s.rows[0].map((v,i)=>v||`Столбец ${i+1}`),rows:s.rows.slice(1)}));
}
