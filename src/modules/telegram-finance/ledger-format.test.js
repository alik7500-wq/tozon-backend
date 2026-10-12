import {it,expect} from 'vitest';
import {ledgerMessage} from './ledger-format.js';
import {splitMessage} from './report.js';
it('formats a readable RKO with currency labels and safe bold headings',()=>{
 const t=ledgerMessage([{reference:'РКО-1',expense_date:'2026-10-10',currency:'TJS',amount_minor:92700,amount_usd:100,recipient:'Test <b>person</b>',category:'Materials',description:'[Касса: Own] Gloves & tools'}],'expense','a',[{id:'a',name:'Own'}],0);
 expect(t).toContain('<b>РКО-1</b> · 10.10.2026');expect(t).toContain('Сомони: <b>927,00</b>');expect(t).toContain('Доллары: <b>100,00</b>');expect(t).toContain('Кому: Test &lt;b&gt;person&lt;/b&gt;');expect(t).toContain('За что: Gloves &amp; tools');expect(t).not.toContain('[Касса:');
});
it('keeps each HTML tag and entity intact when long pages are split',()=>{
 const rows=Array.from({length:10},(_,id)=>({id,currency:'USD',amount_minor:10000,recipient:'&'.repeat(200),category:'<'.repeat(150),description:'&'.repeat(1000)}));
 const parts=splitMessage(ledgerMessage(rows,'expense','a',[{id:'a',name:'Own'}],0));
 expect(parts.length).toBeGreaterThan(1);for(const p of parts){expect(p.length).toBeLessThanOrEqual(3500);expect((p.match(/<b>/g)||[]).length).toBe((p.match(/<\/b>/g)||[]).length);expect(p).not.toMatch(/&(?:a|am|amp|l|lt|g|gt)?$/);}
});
