from pathlib import Path
from lxml import html
from docx import Document
from docx.shared import Pt, Mm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
import sys
repo=Path(__file__).resolve().parents[1]
root=Path(sys.argv[1])
out=repo/'resources/company-project-templates/plaza'

def base():
 d=Document();s=d.sections[0];s.page_width=Mm(210);s.page_height=Mm(297);s.top_margin=s.bottom_margin=Mm(16);s.left_margin=s.right_margin=Mm(18)
 for key in ['Normal','Title','Heading 1','Heading 2']:
  st=d.styles[key];st.font.name='Times New Roman';st.font.color.rgb=RGBColor(0,0,0);st.font.size=Pt(11 if key=='Normal' else 12)
  pb=st.element.find(qn('w:pPr'))
  if pb is not None:
   for border in list(pb.findall(qn('w:pBdr'))):pb.remove(border)
 for border in d.styles.element.xpath('.//w:pBdr'):
  border.getparent().remove(border)
 d.styles['Normal'].paragraph_format.space_after=Pt(5)
 d.styles['Normal'].paragraph_format.line_spacing=1.05
 return d

def runs(p,e,bold=False,under=False):
 def add(t):
  if t:
   r=p.add_run(' '.join(t.split()));r.bold=bold;r.underline=under
 # Preserve spaces between inline elements, collapse only source indentation.
 if e.text:
  r=p.add_run(' '.join(e.text.split())+(' ' if e.text[-1:].isspace() else ''));r.bold=bold;r.underline=under
 for ch in e:
  if ch.tag=='br':p.add_run().add_break()
  else:runs(p,ch,bold or ch.tag in ['strong','b'],under or ch.tag=='u')
  if ch.tail:
   t=ch.tail;r=p.add_run((' ' if t[:1].isspace() else '')+' '.join(t.split())+(' ' if t[-1:].isspace() else ''));r.bold=bold;r.underline=under

def blocks(parent,node):
 for e in node:
  if e.tag in ['h1','h4','p','li']:
   p=parent.add_paragraph();runs(p,e,e.tag in ['h1','h4']);p.alignment=WD_ALIGN_PARAGRAPH.CENTER if e.tag in ['h1','h4'] else WD_ALIGN_PARAGRAPH.JUSTIFY
   p.paragraph_format.keep_with_next=e.tag in ['h1','h4']
  elif e.tag=='table':
   rows=e.xpath('./thead/tr|./tbody/tr|./tr'); t=parent.add_table(rows=0,cols=max(len(r) for r in rows));t.style='Table Grid'
   for row in rows:
    tr=t.add_row();cells=tr.cells
    tr._tr.get_or_add_trPr().append(OxmlElement('w:cantSplit'))
    if row is rows[0]:
     tr._tr.get_or_add_trPr().append(OxmlElement('w:tblHeader'))
    for i,ce in enumerate(row):
     if ce.xpath('./p|./div'): blocks(cells[i],ce)
     else:runs(cells[i].paragraphs[0],ce,ce.tag=='th')
  elif e.tag=='div' and not e.xpath('./p|./div|./table|./h1|./h4|./ul'):
   p=parent.add_paragraph();runs(p,e)
   if len(e)==2:
    # Date and city are distinct source spans.
    for r in p.runs:
     if r.text.endswith('года') or r.text.endswith('{contract_year}'):r.text+=' '
  else:blocks(parent,e)

for lang in ['RU','TJ']:
 d=base();blocks(d,html.fromstring((root/f'plaza-contract-{lang}.html').read_text().replace('{project_city}','{project_address}')))
 d.core_properties.subject='TOZON_PLAZA_APARTMENT_USD_V1'
 d.save(out/f'CONTRACT-{lang}.docx')
 d=base();tj=lang=='TJ'
 d.add_heading('Ҷадвали пардохт ба Шартномаи иштироки ҳиссагӣ дар сохтмон' if tj else 'График платежей к Договору долевого участия в строительстве',0)
 for ru,tjlabel,field in [('Номер Договора','Рақами Шартнома','contract_number'),('ФИО Дольщика','Ному насаби Ҳиссагузор','client_name'),('Дата заключения Договора','Санаи бастани Шартнома','contract_date'),('Адрес Дольщика','Суроғаи Ҳиссагузор','client_address'),('Номер телефона Дольщика','Рақами телефони Ҳиссагузор','client_phone')]:
  p=d.add_paragraph();p.add_run((tjlabel if tj else ru)+': ').bold=True;p.add_run('{'+field+'}')
 d.add_paragraph('{project_name}, {building_name}, '+('хона' if tj else 'квартира')+' № {unit_number}, {area} м²')
 d.add_paragraph(('Маблағи умумии хона' if tj else 'Общая стоимость квартиры')+': {contract_total} USD')
 d.add_paragraph(('Маблағи пешпардохти аввал (аванс)' if tj else 'Сумма первого взноса (аванс)')+': {down_payment} USD')
 d.add_heading('Ҷадвали пардохти қарз' if tj else 'График погашения задолженности',2)
 # Explicit loop paragraphs outside the table let docxtemplater repeat only the template row.
 t=d.add_table(rows=1,cols=4);t.style='Table Grid'
 for c,v in zip(t.rows[0].cells,['№','Сана' if tj else 'Дата','Мувофиқи ҷадвал USD' if tj else 'По графику USD','Ҳисоб шуд USD' if tj else 'Зачтено USD']):c.text=v
 r=t.add_row()
 for c,v in zip(r.cells,['{#payment_plan_rows}{row_number}','{due_date}','{planned_amount}','{paid_amount}{/payment_plan_rows}']):c.text=v
 p=d.add_paragraph();p.add_run(('ҶАМЪ' if tj else 'ИТОГО')+': {contract_total} USD').bold=True
 d.add_paragraph(('Пардохт шуд' if tj else 'Оплачено')+': {total_paid} USD')
 d.add_paragraph(('БАҚИЯИ ҚАРЗ' if tj else 'ОСТАТОК ДОЛГА')+': {remaining_debt} USD')
 d.add_paragraph(('Санаи воқеии пардохт аз рӯи ПКО дар CRM санҷида мешавад.' if tj else 'Фактические даты поступлений проверяются по ПКО в CRM.'))
 d.add_paragraph('{company_name}\n'+('Роҳбари иншоот' if tj else 'Руководитель объекта')+': {director_name}\n__________________')
 d.add_paragraph(('Ҳиссагузор' if tj else 'Дольщик')+': {client_name}\n__________________')
 d.core_properties.subject='TOZON_PLAZA_APARTMENT_USD_V1'
 d.save(out/f'SCHEDULE-{lang}.docx')
print('created four DOCX templates')
