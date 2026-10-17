import { growStudioRectToBlankEdges, parseStudioPages, type StudioBox, type StudioPage, type StudioDiagram } from "./answer-studio";
import { randomClientId } from "./client-random-id.mjs";
import { contentFingerprint } from "./content-fingerprint.mjs";
import { openPdf } from "./pdfjs";

/** Asynchronous encoding avoids synchronous JPEG work on the UI thread.
 * Preserve existing dimensions and quality; release backing canvas memory.
 */
async function canvasDataUrl(canvas:HTMLCanvasElement,type:string,quality?:number) {
  try {
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('Image encoding failed')),type,quality));
    return await new Promise<string>((resolve,reject)=>{
      const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);
    });
  } finally {canvas.width=0;canvas.height=0;}
}

export async function loadStudioImage(source:string):Promise<HTMLImageElement> {
  return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=()=>reject(new Error("无法读取原图"));image.src=source;});
}
/** Read only the pixels around the box, then let a tight model box grow to the figure's blank edges. */
function growStudioBox(image:HTMLImageElement,box:StudioBox):StudioBox {
  const max=Math.round(Math.max(image.width,image.height)*0.04);
  const x0=Math.max(0,Math.floor(image.width*box.x/1000)-max),y0=Math.max(0,Math.floor(image.height*box.y/1000)-max);
  const x1=Math.min(image.width,Math.ceil(image.width*(box.x+box.width)/1000)+max),y1=Math.min(image.height,Math.ceil(image.height*(box.y+box.height)/1000)+max);
  const canvas=document.createElement("canvas");canvas.width=x1-x0;canvas.height=y1-y0;
  const ctx=canvas.getContext("2d",{willReadFrequently:true})!;ctx.drawImage(image,x0,y0,canvas.width,canvas.height,0,0,canvas.width,canvas.height);
  const pixels=ctx.getImageData(0,0,canvas.width,canvas.height);canvas.width=0;canvas.height=0;
  const r=growStudioRectToBlankEdges(pixels,{
    left:Math.max(0,Math.floor(image.width*box.x/1000)-x0),top:Math.max(0,Math.floor(image.height*box.y/1000)-y0),
    right:Math.min(pixels.width-1,Math.ceil(image.width*(box.x+box.width)/1000)-x0-1),bottom:Math.min(pixels.height-1,Math.ceil(image.height*(box.y+box.height)/1000)-y0-1),
  },max);
  return {x:(r.left+x0)*1000/image.width,y:(r.top+y0)*1000/image.height,width:(r.right-r.left+1)*1000/image.width,height:(r.bottom-r.top+1)*1000/image.height};
}
export async function cropStudioImage(source:string,cropBox:StudioBox,width=600) {
  const image=await loadStudioImage(source),canvas=document.createElement("canvas"),box=growStudioBox(image,cropBox);
  const sw=image.width*box.width/1000,sh=image.height*box.height/1000;
  canvas.width=Math.min(width,sw);canvas.height=Math.max(1,Math.round(canvas.width*sh/sw));
  const ctx=canvas.getContext("2d")!;ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(image,image.width*box.x/1000,image.height*box.y/1000,sw,sh,0,0,canvas.width,canvas.height);
  const result={image:"",width:canvas.width,height:canvas.height};
  result.image=await canvasDataUrl(canvas,"image/png");return result;
}
export async function resizeStudioImage(source:string,edge=2200) {
  const image=await loadStudioImage(source),canvas=document.createElement("canvas"),scale=Math.min(1,edge/Math.max(image.width,image.height));
  canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);
  const ctx=canvas.getContext("2d")!;ctx.fillStyle="#fff";ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
  return canvasDataUrl(canvas,"image/jpeg",.94);
}
export type StudioPageBatchMeta = { fileName:string; batchIndex:number; batchCount:number; pageStart:number; pageEnd:number };
export type StudioPageBatchHandler = (pages:StudioPage[],meta:StudioPageBatchMeta)=>Promise<void>|void;
const STUDIO_PAGE_BATCH_SIZE=40;

/** Read source files in bounded batches so a large PDF never has to stay fully rasterized in memory. */
export async function readStudioFilesInBatches(files:File[],role:StudioPage["role"],range:string,progress:(message:string)=>void,onBatch:StudioPageBatchHandler,batchSize=STUDIO_PAGE_BATCH_SIZE) {
  if(!Number.isInteger(batchSize)||batchSize<1) throw new Error("无效的页面批次大小");
  for (const file of files) {
    if (file.size>80_000_000) throw new Error("单个文件不得超过80MB");
    const add=async(image:string,page:number,target:StudioPage[])=> {
      target.push({id:randomClientId(),role,name:file.name,page,image,hash:await contentFingerprint(image),selected:true});
    };
    if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
      const task=await openPdf(new Uint8Array(await file.arrayBuffer()));
      try {
        const pdf=await task.promise,selected=parseStudioPages(range,pdf.numPages),batchCount=Math.max(1,Math.ceil(selected.length/batchSize));
        for (let offset=0;offset<selected.length;offset+=batchSize) {
          const batch=selected.slice(offset,offset+batchSize),pages:StudioPage[]=[];
          progress(`读取 ${file.name}：第 ${Math.floor(offset/batchSize)+1}/${batchCount} 批（${batch[0]}–${batch[batch.length-1]} 页）`);
          for (const n of batch) {
            const page=await pdf.getPage(n),base=page.getViewport({scale:1}),viewport=page.getViewport({scale:3200/Math.max(base.width,base.height)});
            const canvas=document.createElement("canvas");canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
            await page.render({canvas,canvasContext:canvas.getContext("2d")!,viewport}).promise;
            await add(await canvasDataUrl(canvas,"image/jpeg",.97),n,pages);page.cleanup();
          }
          await onBatch(pages,{fileName:file.name,batchIndex:Math.floor(offset/batchSize)+1,batchCount,pageStart:batch[0],pageEnd:batch[batch.length-1]});
        }
      } finally {await task.destroy();}
    } else {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("仅支持PDF、PNG、JPEG、WebP");
      const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(file);});
      const pages:StudioPage[]=[];await add(await resizeStudioImage(data,4200),1,pages);
      await onBatch(pages,{fileName:file.name,batchIndex:1,batchCount:1,pageStart:1,pageEnd:1});
    }
  }
}

export async function readStudioFiles(files:File[],role:StudioPage["role"],range:string,progress:(message:string)=>void) {
  const pages:StudioPage[]=[];
  await readStudioFilesInBatches(files,role,range,progress,batch=>{pages.push(...batch);});
  return pages;
}
export async function studioDrawingContact(bases:StudioDiagram[],answers:string[],previews:string[]=[]) {
  const sources=[...bases.map((d,i)=>({label:`BASE ${i}`,source:d.baseImage})),...answers.map((s,i)=>({label:`ANSWER ${i}`,source:s})),...previews.map((s,i)=>({label:`PREVIEW ${i} (generated, not source)`,source:s}))];
  const images=await Promise.all(sources.map(s=>loadStudioImage(s.source)));
  const width=1400,heights=images.map(im=>Math.round(im.height*(width-80)/im.width)+90);
  const canvas=document.createElement("canvas");canvas.width=width;canvas.height=heights.reduce((a,b)=>a+b,0);
  if(canvas.height>16000) throw new Error("解答图原件过长，请逐段处理");
  const ctx=canvas.getContext("2d")!;ctx.fillStyle="#fff";ctx.fillRect(0,0,width,canvas.height);let y=0;
  images.forEach((im,i)=>{
    const scale=(width-80)/im.width,top=y+65,left=55;
    ctx.fillStyle="#000";ctx.font="bold 24px sans-serif";ctx.fillText(`${sources[i].label}   original ${im.width} × ${im.height}`,10,y+28);
    ctx.drawImage(im,left,top,im.width*scale,im.height*scale);
    if(i<bases.length){
      ctx.font="18px sans-serif";ctx.fillStyle="#1761a0";ctx.strokeStyle="#7fb0d055";ctx.lineWidth=1;
      for(let x=0;x<=im.width;x+=50){ctx.fillText(String(x),left+x*scale-8,top-9);ctx.beginPath();ctx.moveTo(left+x*scale,top);ctx.lineTo(left+x*scale,top+im.height*scale);ctx.stroke();}
      for(let yy=0;yy<=im.height;yy+=50){ctx.fillText(String(yy),4,top+yy*scale+6);ctx.beginPath();ctx.moveTo(left,top+yy*scale);ctx.lineTo(left+im.width*scale,top+yy*scale);ctx.stroke();}
    }
    y+=heights[i];
  });
  return canvasDataUrl(canvas,"image/jpeg",.95);
}
