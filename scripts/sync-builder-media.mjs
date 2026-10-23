/** Manual, read-only source refresh. Never alters product prices or runtime data. */
import fs from 'node:fs/promises';
import { plain } from './coolpc-catalog.mjs';
const catalogue=JSON.parse(await fs.readFile(new URL('../data/builder-catalog.json',import.meta.url),'utf8'));
const path=new URL('../builder-catalog-media.js',import.meta.url),previous=await fs.readFile(path,'utf8').catch(()=>''),old=previous?JSON.parse(previous.slice(previous.indexOf('Object.freeze(')+14,-3)):{};
const key=n=>plain(n).normalize('NFKC').replace(/[{}\s]/g,'').toLowerCase();
const records={},categories=[4,5,6,7,10,12,14,15];
for(const category of categories){
 const source='https://www.coolpc.com.tw/eachview.php?IGrp='+category,response=await fetch(source,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Source unavailable: '+category);
 const html=new TextDecoder('big5').decode(await response.arrayBuffer()),index=new Map(catalogue.products.filter(p=>p.category===category).map(p=>[key(p.name),p]));let count=0;
 for(const match of html.matchAll(/<span onclick='Show\(this\)'><img src='([^']+)'><div class=t>(.*?)<\/div>/gs)){
  const product=index.get(key(match[2]));if(!product||!new RegExp('^/eval/'+category+'/[a-zA-Z0-9_.-]+\\.(jpg|png|gif|webp)$','i').test(match[1]))continue;
  const image='https://www.coolpc.com.tw'+match[1],cached=old[product.id],same=cached?.name===product.name&&cached.sourceImage===image&&cached.image.startsWith('./assets/products/');
  records[product.id]={name:product.name,image:same?cached.image:image,source,kind:'catalog-reference',checkedAt:new Date().toISOString().slice(0,10),...(same?{sourceImage:image}:{})};count++;
 }
 if(!count)throw Error('No verified listing matches: '+category);console.log(category,count);
}
if(Object.keys(records).length<Object.keys(old).length*.8)throw Error('Image mapping shrank unexpectedly; existing file retained');
const temporary=new URL('../builder-catalog-media.js.tmp',import.meta.url);await fs.writeFile(temporary,'// Exact normalized source-listing matches. Reference images may show series packaging; read full specifications.\nwindow.DKBuilderCatalogMedia=Object.freeze('+JSON.stringify(records)+');\n');await fs.rename(temporary,path);console.log('Saved',Object.keys(records).length,'source-assigned image references');
