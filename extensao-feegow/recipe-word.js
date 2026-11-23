function wordZip(files){
 const encoder=new TextEncoder(),local=[],central=[];let offset=0;
 function header(size,fields){const result=new Uint8Array(size),view=new DataView(result.buffer);
 for(const [position,value,width] of fields){if(width===2)view.setUint16(position,value,true);else view.setUint32(position,value,true);}
 return result;}
 for(const [name,content] of Object.entries(files)){
 const key=encoder.encode(name),data=typeof content==='string'?encoder.encode(content):content;
 let crc=0xffffffff;for(const byte of data){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(~crc)>>>0;
 local.push(header(30,[[0,0x04034b50],[4,20,2],[6,2048,2],[14,crc],[18,data.length],[22,data.length],[26,key.length,2]]),key,data);
 central.push(header(46,[[0,0x02014b50],[4,20,2],[6,20,2],[8,2048,2],[16,crc],[20,data.length],[24,data.length],[28,key.length,2],[42,offset]]),key);
 offset+=30+key.length+data.length;
 }
 const count=central.length/2,size=central.reduce((sum,a)=>sum+a.length,0);
 return new Blob([...local,...central,header(22,[[0,0x06054b50],[8,count,2],[10,count,2],[12,size],[16,offset]])]);
}
async function fillOriginalRecipe(file,patient,content,date){
 const bytes=new Uint8Array(await file.arrayBuffer()), view=new DataView(bytes.buffer);
 const xmlPath='word/document.xml', decoder=new TextDecoder();
 let end=bytes.length-22;
 while(end>=Math.max(0,bytes.length-65557)&&view.getUint32(end,true)!==0x06054b50)end--;
 if(end<Math.max(0,bytes.length-65557))throw Error('O modelo não é um Word válido.');
 let offset=view.getUint32(end+16,true), total=0;
 const files=Object.create(null);
 for(let i=0;i<view.getUint16(end+10,true);i++){
  if(view.getUint32(offset,true)!==0x02014b50)throw Error('O modelo Word está danificado.');
  const method=view.getUint16(offset+10,true),length=view.getUint16(offset+28,true);
  const name=decoder.decode(bytes.subarray(offset+46,offset+46+length));
  const size=view.getUint32(offset+20,true), expanded=view.getUint32(offset+24,true), local=view.getUint32(offset+42,true);
  total+=expanded;
  if(total>40*1024*1024||![0,8].includes(method)||view.getUint16(offset+8,true)&1)throw Error('Formato de modelo Word não suportado.');
  if(view.getUint32(local,true)!==0x04034b50)throw Error('O modelo Word está danificado.');
  const start=local+30+view.getUint16(local+26,true)+view.getUint16(local+28,true);
  const packed=bytes.subarray(start,start+size);
  const data=method===0?packed:new Uint8Array(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  if(data.length!==expanded)throw Error('O modelo Word está danificado.');
  files[name]=data;
  offset+=46+length+view.getUint16(offset+30,true)+view.getUint16(offset+32,true);
 }
 if(!files[xmlPath])throw Error('O modelo não contém o documento principal.');
 const ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
 const xml=new DOMParser().parseFromString(decoder.decode(files[xmlPath]),'application/xml');
 const body=xml.getElementsByTagNameNS(ns,'body')[0];
 if(!body)throw Error('O texto do modelo Word não pôde ser lido.');
 const paragraphs=Array.from(body.children).filter(p=>p.namespaceURI===ns&&p.localName==='p');
 const textOf=p=>Array.from(p.getElementsByTagNameNS(ns,'t')).map(t=>t.textContent).join('').trim();
 const names=paragraphs.filter(p=>/^PARA\s*:?$/iu.test(textOf(p)));
 const dates=paragraphs.filter(p=>/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(textOf(p)));
 const blocks=paragraphs.filter(p=>/^MANIPULE\s*:?$/iu.test(textOf(p)));
 if(names.length!==2||dates.length!==2||blocks.length!==2)throw Error('Selecione o PRESCRIPTION TEMPLATE CABELO original de duas páginas.');
 function setText(paragraph,text){
  const nodes=Array.from(paragraph.getElementsByTagNameNS(ns,'t'));
  if(!nodes.length)throw Error('O modelo original tem um campo sem formatação reconhecível.');
  nodes[0].setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space','preserve');
  nodes[0].textContent=text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g,'');
  nodes.slice(1).forEach(node=>{node.textContent='';});
 }
 const lines=content.replace(/\\r\\n|\\n/g,'\n').split(/\r?\n/).map(l=>l.trim().replace(/\*\*/g,'').replace(/^#{1,6}\s+/,'')).filter(l=>l&&!/^PARA(?:\s*:\s*|\s+)|^MANIPULE\s*:?$|^MINUTA\b|^Fórmula, dose e posologia: a preencher pelo médico\.?$/iu.test(l));
 const first=[],second=[];
 let target=first;
 for(const line of lines){
  if(/^Fórmula\s+\d+/iu.test(line))target=first;
  if(/^(?:[•⮚*-]\s*)?minoxidil\b/iu.test(line)){
   if(!/\d/.test(line)||/^(?:[•⮚*-]\s*)?minoxidil\s+tópico/iu.test(line))throw Error('Confira a apresentação do minoxidil antes de exportar.');
   target=second;
  }
  target.push(line);
 }
 names.forEach(p=>setText(p,'PARA '+patient));
 dates.forEach(p=>setText(p,date));
 for(const [i,part] of [first,second].entries()){
  if(i===1&&!part.length)continue;
  const start=paragraphs.indexOf(blocks[i]), stop=paragraphs.indexOf(dates[i]);
  const slots=paragraphs.slice(start+1,stop).filter(p=>textOf(p));
  if(!slots.length)throw Error('Os campos da fórmula não foram encontrados.');
  function paragraphStyle(source){
   const paragraph=xml.createElementNS(ns,'w:p');
   const properties=Array.from(source.children).find(node=>node.namespaceURI===ns&&node.localName==='pPr');
   if(properties){
    const style=properties.cloneNode(true);
    for(const tag of ['pageBreakBefore','sectPr','pPrChange']){
     Array.from(style.getElementsByTagNameNS(ns,tag)).forEach(node=>node.remove());
    }
    paragraph.appendChild(style);
   }
   const run=xml.createElementNS(ns,'w:r');
   const originalText=source.getElementsByTagNameNS(ns,'t')[0];
   const originalRun=originalText?.parentElement;
   const runStyle=Array.from(originalRun?.children||[]).find(node=>node.namespaceURI===ns&&node.localName==='rPr');
   if(runStyle)run.appendChild(runStyle.cloneNode(true));
   run.appendChild(xml.createElementNS(ns,'w:t'));
   paragraph.appendChild(run);
   return paragraph;
  }
  const prototypes={
   title:paragraphStyle(slots[0]),
   item:paragraphStyle(slots.find(p=>/^\s*(?:Vit |Dutasterida|Minoxidil)/iu.test(textOf(p)))||slots[0]),
   instruction:paragraphStyle(slots.find(p=>/^Tomar\b/iu.test(textOf(p)))||slots[0])
  };
  const anchor=slots[0];
  for(const line of part){
   const key=/^(?:Fórmula|Uso|MINUTA)/iu.test(line)?'title':/^(?:QSP|Tomar|Aplicar|Pendência)/iu.test(line)?'instruction':'item';
   const p=prototypes[key].cloneNode(true);
   if(key==='item'&&p.getElementsByTagNameNS(ns,'numPr').length) setText(p,line.replace(/^[•⮚*-]\s*/u,''));
   else setText(p,line);
   body.insertBefore(p,anchor);
  }
  for(const p of slots)p.remove();
 }
 if(!second.length){
  const firstDate=paragraphs.indexOf(dates[0]), next=paragraphs.indexOf(names[1]);
  const secondHeader=paragraphs.slice(firstDate+1,next).findLastIndex(p=>p.getElementsByTagNameNS(ns,'drawing').length);
  if(secondHeader<0)throw Error('A segunda página do modelo não pôde ser identificada.');
  for(const p of paragraphs.slice(firstDate+1+secondHeader))p.remove();
 }
 files[xmlPath]=new XMLSerializer().serializeToString(xml);
 return wordZip(files);
}
