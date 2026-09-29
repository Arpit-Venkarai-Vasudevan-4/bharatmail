/** AST based catalog migration/audit. Protocol literals and user data are never translated. */
import ts from 'typescript';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const write=process.argv.includes('--write');
const catalog=JSON.parse(await readFile('src/i18n/en.json','utf8'));
const locations={};const pending=[];
async function walk(dir){return (await Promise.all((await readdir(dir,{withFileTypes:true})).map(e=>e.isDirectory()?walk(path.join(dir,e.name)):/\.(tsx?|jsx?)$/.test(e.name)?[path.join(dir,e.name)]:[]))).flat()}
const textAttributes=new Set(['aria-label','title','placeholder','alt','label']);
// Browser/API protocol tokens must remain invariant when a locale changes.
const protocolLiterals=new Set(['Accept','Authorization','Enter','Tab']);
const words=new Set(['Home','Inbox','Sent','Drafts','Favorites','Archive','Spam','Trash','Contacts','Settings','Conversation','Message','Draft','People','To','Cc','Reply','Restore','Favorite','You','Next','Saved','Offline','Connected','Account','Password','English','Send','Cancel','UPDATING…','CONVERSATIONS','MESSAGES']);
function human(s){return /[a-zA-Z]/.test(s)&&(/\s/.test(s)||words.has(s)||/^[A-Z][a-z]+[….!?]?$/.test(s))&&!/^[/#]|^\w+:|^-----|[\r\n]/.test(s)}
function jsxText(s){const lines=s.split(/\r?\n/);return lines.map((line,i)=>{let v=line.replace(/\t/g,' ');if(i)v=v.replace(/^ +/,'');if(i<lines.length-1)v=v.replace(/ +$/,'');return v}).filter(Boolean).join(' ').replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&nbsp;','\u00a0')}
for(const file of await walk('src')){
 if(file.includes('/i18n/'))continue;
 const source=await readFile(file,'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('x')?ts.ScriptKind.TSX:ts.ScriptKind.TS),edits=[];
 function add(node,text,jsx=false,attribute=false,values){
   if(!text.trim()||!/[A-Za-z]/.test(text))return;
   const key='m_'+createHash('sha256').update(text).digest('hex').slice(0,12);catalog[key]=text;(locations[key]??=[]).push(file+':'+(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1));
   const call=`t(${JSON.stringify(key)}${values?',{'+values+'}':''})`;
   edits.push({start:node.getStart(ast),end:node.end,text:jsx||attribute?'{'+call+'}':call});pending.push({file,key,text});
 }
 function visit(node){
   if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='t'){
     const key=node.arguments[0];
     if(key&&ts.isStringLiteral(key))(locations[key.text]??=[]).push(file+':'+(ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1));
     // Interpolation values can contain nested labels that also need auditing.
     for(const argument of node.arguments.slice(1))ts.forEachChild(argument,visit);
     return;
   }
   if(ts.isJsxText(node)){add(node,jsxText(node.getText(ast)),true);return}
   if(ts.isJsxAttribute(node)){
     if(textAttributes.has(node.name.getText(ast))&&node.initializer&&ts.isStringLiteral(node.initializer)){add(node.initializer,node.initializer.text,false,true);return}
     if(node.initializer&&ts.isStringLiteral(node.initializer)&&!textAttributes.has(node.name.getText(ast)))return;
     if(['className','style','href','id','name','type','htmlFor','autoComplete','accept','pattern','role','transform','d','rel'].includes(node.name.getText(ast)))return;
   }
   if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node)){
     if(protocolLiterals.has(node.text))return;
     if(ts.isLiteralTypeNode(node.parent)||ts.isImportDeclaration(node.parent)||ts.isExportDeclaration(node.parent)||ts.isPropertyAssignment(node.parent)&&node.parent.name===node)return;
     const p=node.parent;
     const errorArg=ts.isNewExpression(p)&&/Error$/.test(p.expression.getText(ast))&&p.arguments?.indexOf(node)>=(p.expression.getText(ast)==='ApiError'?2:p.expression.getText(ast)==='E2eeClientError'?1:0);
     // Vendor crypto remains mechanically identical except its user-facing error messages.
     if(file.includes('/vendor/')&&!errorArg)return;
     if(errorArg||human(node.text))add(node,node.text);
   }
   if(ts.isTemplateExpression(node)&&(!file.includes('/vendor/')||(ts.isNewExpression(node.parent)&&/Error$/.test(node.parent.expression.getText(ast))))){
     const literal=node.head.text+node.templateSpans.map(s=>s.literal.text).join('');
     const textAttribute=ts.isJsxExpression(node.parent)&&ts.isJsxAttribute(node.parent.parent)&&textAttributes.has(node.parent.parent.name.getText(ast));
     if(human(literal)&&!literal.includes('className')&&(textAttribute||!/^[\w-]+ $/.test(literal))){
       let text=node.head.text;const values=[];node.templateSpans.forEach((span,i)=>{text+='{value'+i+'}'+span.literal.text;values.push('value'+i+':'+span.expression.getText(ast))});add(node,text,false,false,values.join(','));return;
     }
   }
   ts.forEachChild(node,visit);
 }
 visit(ast);
 if(write&&edits.length){let next=source;for(const e of edits.sort((a,b)=>b.start-a.start))next=next.slice(0,e.start)+e.text+next.slice(e.end);if(!/import\s*\{[^}]*\bt\b[^}]*\}\s*from ['"][^'"]*i18n/.test(next)){let target=path.relative(path.dirname(file),'src/i18n').replaceAll('\\','/');if(!target.startsWith('.'))target='./'+target;next=`import {t} from '${target}';\n`+next}await writeFile(file,next)}
}
if(write){await writeFile('src/i18n/en.json',JSON.stringify(catalog,null,2)+'\n');await writeFile('docs/catalog-locations.json',JSON.stringify(locations,null,2)+'\n')}
else {console.log(JSON.stringify(pending,null,2));if(pending.length)process.exitCode=1}
console.log(JSON.stringify({messages:Object.keys(catalog).length,unextracted:pending.length,write}));
