const fs=require('fs'),path=require('path'),vm=require('vm');
const {createRequire}=require('module');
const root=path.resolve(__dirname,'../..');
const output=path.resolve(process.argv[2]||'.');
fs.mkdirSync(output,{recursive:true});
const req=createRequire(root+'/tozon-crm-projects/package.json');
const React=req('react'),{renderToStaticMarkup}=req('react-dom/server'),oxc=req('rolldown/utils');
const source=fs.readFileSync(root+'/tozon-crm-projects/src/features/deals/ContractPrintView.jsx','utf8');
let jsx=source.slice(source.indexOf('<div id={activeTab === \'CONTRACT\''), source.indexOf('        {/* ================= TAB 2:'));
jsx=jsx.slice(0,jsx.lastIndexOf('</div>')+6);
// Replace only source literals tied to Plaza's old signer. All clauses remain source-derived.
for(const [a,b] of [
 ['ҶДММ «Тозон»,','{company_name},'],
 ['Абдуллоев Акмалхон Раҳматуллоевич,','{director_name},'],
 ['Абдуллоева Акмалхона Рахматуллоевича','{director_name}'],
 ['Ваколатномаи № 2','{director_authority}'],
 ['Доверенности № 2','{director_authority}'],
 ['«TOZON PLAZA»','«{project_name}»'],
 ['дар шаҳри Хуҷанд','{project_city}'],['в городе Худжанде','{project_city}'],
 ['630019325','{company_inn}'],['6310011648','{company_registration}'],
 ["{isTJ ? 'Абдуллоев Акмалхон Раҳматуллоевич' : 'Абдуллоев Акмалхон Рахматуллоевич'}","{'{director_name}'}"],
 ['с/ҳ:</strong> ____________________________________','с/ҳ:</strong> {\'{company_account}\'}']
]) {if(!jsx.includes(a))throw Error('missing source '+a);jsx=jsx.split(a).join(b)}
// Placeholder text inserted into JSX literals must remain literal text, not identifiers.
jsx=jsx.replace(/(?<![\w'])\{(company_name|director_name|director_authority|project_name|project_city|company_inn|company_registration)\}(?!')/g,"{'{$1}'}");
// The replacements in quoted JSX expressions above are not used except the signer ternary.
const code=oxc.transformSync('source.jsx','result=('+jsx+');',{lang:'jsx',jsx:{runtime:'classic',pragma:'React.createElement',pragmaFrag:'React.Fragment'}}).code;
const fields={lead_name:'client_name',lead_phone:'client_phone',passport_series:null,passport_number:'passport_number',passport_issued_by:'passport_issued_by',passport_issue_date:'passport_issue_date',registration_address:'client_address',inn:'client_inn',project_address:'project_address',project_name:'project_name',building_name:'building_name',section_name:'section_name',floor_number:'floor_number',unit_number:'unit_number',unit_rooms:'rooms',developer_name:'company_name',developer_address:'company_address',contract_number:'contract_number'};
for(const lang of ['RU','TJ']){
 const deal=Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v?`{${v}}`:null]));
 const ctx={React,result:null,deal,lang,isTJ:lang==='TJ',activeTab:'CONTRACT',nonResidential:false,parking:false,fixedParking:false,isPartialBarter:false,
  currency:'USD',currencyShort:lang==='TJ'?'доллари ИМА':'долларов США',ruObject:'квартиру',ruGenitive:'квартиры',tjObject:'хона',
  displayContractNumber:x=>x,formatDate:x=>x,formatBuildingName:x=>x,cleanCompanyName:x=>x,
  dealDay:'{contract_day}',dealMonthName:'{contract_month}',dealYear:'{contract_year}',areaM2:'{area}',usdPrice:'{price_per_m2}',usdPriceWords:'{price_per_m2_words}',finalPrice:'{contract_total}',downPayment:'{down_payment}',exchangeRate:null,
  getUnitTitle:()=>lang==='TJ'?'Хона':'Квартира'};
 vm.runInNewContext(code,ctx);
 const html=renderToStaticMarkup(ctx.result);
 if(/Абдуллоев|630019325|6310011648|14\.02\.2020/.test(html))throw Error('fixed identity/date remained');
 fs.writeFileSync(output+'/plaza-contract-'+lang+'.html',html);
}
console.log('extracted RU/TJ contract HTML');
