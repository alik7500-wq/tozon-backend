import {describe,it,expect} from 'vitest';
import PizZip from 'pizzip';
import {compileTemplate,renderTemplate,sampleTemplate,cleanContext,TYPES} from './template.engine.js';

describe('DOCX template engine',()=>{
  it.each(TYPES)('renders %s, preserving XML escaping and document identity',type=>{
    const result=renderTemplate(sampleTemplate(type),{client_name:'Тест <&>',contract_number:'TOZON-2026-0003',schedules:[{row_number:1,due_date:'01.01.2027',planned_amount:'123,45',paid_amount:'0,00',balance:'123,45'}]});
    const xml=new PizZip(result).file('word/document.xml').asText();
    expect(xml).toContain('Тест &lt;&amp;&gt;');expect(xml).toContain('TOZON-2026-0003');
    expect(xml).not.toContain('{client_name}');
    if(type==='SCHEDULE'){expect(xml).toContain('123,45');expect(xml).not.toContain('{#schedules}');}
  });
  it('rejects malformed files and excessive sizes',()=>{expect(()=>compileTemplate(Buffer.from('fake'))).toThrow();expect(()=>compileTemplate(Buffer.alloc(2097153))).toThrow();});
  it('rejects unknown variables and raw XML directives',()=>{
    for(const tag of ['{unknown}','{@client_name}','{client_name.constructor}']){
      const zip=new PizZip(sampleTemplate('CONTRACT'));zip.file('word/document.xml',zip.file('word/document.xml').asText().replace('{client_name}',tag));
      expect(()=>renderTemplate(zip.generate({type:'nodebuffer'}),{client_name:'text'})).toThrow();
    }
  });
  it('rejects macros, embedded objects and external relationships',()=>{
    for(const [name,data] of [['word/vbaProject.bin','fake'],['word/embeddings/a.bin','fake'],['word/_rels/document.xml.rels','<Relationship TargetMode="External" Target="https://example.test"/>']]){
      const zip=new PizZip(sampleTemplate('CONTRACT'));zip.file(name,data);expect(()=>compileTemplate(zip.generate({type:'nodebuffer'}))).toThrow();
    }
  });
  it('rejects nested contexts, unknown keys and oversized schedules',()=>{
    expect(()=>cleanContext({client_name:{x:1}})).toThrow();expect(()=>cleanContext({bad:'x'})).toThrow();
    expect(()=>cleanContext({schedules:Array(601).fill({})})).toThrow();expect(()=>cleanContext({schedules:[{schedules:[]}]})).toThrow();
  });
  it('never resolves inherited data',()=>{
    const input=Object.create({client_name:'inherited'});input.contract_number='0042';
    const xml=new PizZip(renderTemplate(sampleTemplate('CONTRACT'),input)).file('word/document.xml').asText();
    expect(xml).not.toContain('inherited');expect(xml).toContain('0042');
  });
});
