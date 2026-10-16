import type { StudioDiagram, StudioShape } from "./answer-studio";

export const xmlEscape = (s: string) => s.replace(/[<>&"']/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&apos;"}[c]!));
// Geometry variables are italic, but digits, punctuation and Chinese labels are upright.
function labelParts(text: string) {
  return (text.match(/[A-Za-zΑ-ω]+|[^A-Za-zΑ-ω]+/gu) || []).map(text=>({text,italic:/^[A-Za-zΑ-ω]+$/u.test(text)}));
}
export function diagramBounds(d: StudioDiagram) {
  const xs = [0, d.width], ys = [0,d.height];
  for (const s of d.shapes) {
    xs.push(s.x-s.weight,s.x+s.width+s.weight); ys.push(s.y-s.weight,s.y+s.height+s.weight);
    s.points.forEach(p=> { xs.push(p.x-s.weight); ys.push(p.y-s.weight); });
  }
  const x = Math.min(...xs)-12, y = Math.min(...ys)-12;
  return { x, y, width: Math.max(...xs)-x+12, height: Math.max(...ys)-y+12 };
}
export function studioDiagramSvg(d: StudioDiagram) {
  const b = diagramBounds(d);
  const shapes = d.shapes.map(s=> {
    const style = `stroke="${s.color}" stroke-width="${s.weight}" fill="none"${s.dash ? ' stroke-dasharray="9 6"' : ''}`;
    if (s.kind === "line") return `<line x1="${s.x}" y1="${s.y}" x2="${s.x+s.width}" y2="${s.y+s.height}" ${style}/>`;
    if (s.kind === "ellipse" || s.kind === "point") return `<ellipse cx="${s.x+s.width/2}" cy="${s.y+s.height/2}" rx="${s.width/2}" ry="${s.height/2}" ${s.kind === "point" ? `fill="${s.color}"` : style}/>`;
    if (s.kind === "path") return `<polyline points="${s.points.map(p=>`${p.x},${p.y}`).join(" ")}" ${style}/>`;
    return `<text x="${s.x}" y="${s.y+s.height*.8}" font-family="Times New Roman,serif" font-size="${s.height*.85}" fill="${s.color}">${labelParts(s.text).map(p=>`<tspan font-style="${p.italic?'italic':'normal'}">${xmlEscape(p.text)}</tspan>`).join('')}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${b.x} ${b.y} ${b.width} ${b.height}" width="${b.width}" height="${b.height}"><rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="white"/>${d.baseImage ? `<image href="${xmlEscape(d.baseImage)}" xlink:href="${xmlEscape(d.baseImage)}" width="${d.width}" height="${d.height}"/>` : ""}${shapes}</svg>`;
}
/** Native Office VML objects, not a flattened image. All coordinates share one group, in one inline run; the
 * paragraph around it decides where it sits. A source picture gets its print width from the caller. */
export function studioDiagramVml(d: StudioDiagram, imageRelation: string, unique: string, widthPt?: number) {
  // Keep solution drawings compact in the handout; the editable VML objects
  // retain their full coordinate system while the rendered group is about
  // half the previous maximum size.
  const b = diagramBounds(d), scale = widthPt ? widthPt/b.width : Math.min(130/b.width,100/b.height,1);
  const width = b.width*scale, height = b.height*scale;
  function shape(s: StudioShape, index: number) {
    const id = `${unique}_${index}`, color = xmlEscape(s.color), weight = s.weight*scale;
    const stroke = `<v:stroke dashstyle="${s.dash ? "dash" : "solid"}"/>`;
    const style = `position:absolute;left:${s.x};top:${s.y};width:${s.width};height:${s.height}`;
    if (s.kind === "line") {
      // VML importers can discard a line with two negative extents. Reversing
      // an undirected segment preserves its geometry and avoids that case.
      const reverse=s.width<0||(s.width===0&&s.height<0);
      const from=reverse?`${s.x+s.width},${s.y+s.height}`:`${s.x},${s.y}`;
      const to=reverse?`${s.x},${s.y}`:`${s.x+s.width},${s.y+s.height}`;
      return `<v:line id="${id}" from="${from}" to="${to}" strokecolor="${color}" strokeweight="${weight}pt">${stroke}</v:line>`;
    }
    if (s.kind === "ellipse" || s.kind === "point") return `<v:oval id="${id}" style="${style}" filled="${s.kind==='point'?'t':'f'}" fillcolor="${color}" strokecolor="${color}" strokeweight="${weight}pt">${stroke}</v:oval>`;
    if (s.kind === "path") {
      // Avoid custom path/viewport interpretations that differ between Office
      // importers. Each segment remains a native editable line in THIS group.
      // Dashed paths maintain their 9/6 phase across vertices (same as SVG).
      let distance=0,part=0;
      const segments:string[]=[];
      for(let i=1;i<s.points.length;i++) {
        const a=s.points[i-1],b=s.points[i],dx=b.x-a.x,dy=b.y-a.y,length=Math.hypot(dx,dy);
        let offset=0;
        while(offset<length) {
          const phase=distance%15,visible=!s.dash||phase<9;
          const step=s.dash?Math.min(length-offset,(phase<9?9:15)-phase):length;
          if(step<1e-9){distance+=1e-8;continue;}
          if(visible) {
            let from={x:a.x+dx*offset/length,y:a.y+dy*offset/length};
            let to={x:a.x+dx*(offset+step)/length,y:a.y+dy*(offset+step)/length};
            if(from.x>to.x||(from.x===to.x&&from.y>to.y))[from,to]=[to,from];
            segments.push(`<v:line id="${id}_part${part++}" from="${from.x},${from.y}" to="${to.x},${to.y}" strokecolor="${color}" strokeweight="${weight}pt"><v:stroke dashstyle="solid"/></v:line>`);
          }
          offset+=step;distance+=step;
        }
      }
      return segments.join('');
    }
    const fontSize=Math.max(15,Math.round(s.height*scale*1.7));
    const labelStyle=`position:absolute;left:${s.x};top:${s.y};width:${Math.max(s.width,(s.text.length*fontSize*.3+2)/scale)};height:${Math.max(s.height,(fontSize*.65)/scale)}`;
    const runs=labelParts(s.text).map(p=>`<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Songti SC"/><w:i w:val="${p.italic?'true':'false'}"/><w:color w:val="${color.slice(1)}"/><w:sz w:val="${fontSize}"/></w:rPr><w:t xml:space="preserve">${xmlEscape(p.text)}</w:t></w:r>`).join('');
    return `<v:rect id="${id}" style="${labelStyle}" filled="f" stroked="f"><v:textbox inset="0,0,0,0"><w:txbxContent><w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr>${runs}</w:p></w:txbxContent></v:textbox></v:rect>`;
  }
  const image = d.baseImage ? `<v:rect id="${unique}_base" style="position:absolute;left:0;top:0;width:${d.width};height:${d.height}" stroked="f"><v:imagedata r:id="${imageRelation}" o:title="原题底图"/></v:rect>` : "";
  return `<w:r><w:pict xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><v:group id="${unique}" style="width:${width}pt;height:${height}pt" coordorigin="${b.x},${b.y}" coordsize="${b.width},${b.height}">${image}${d.shapes.map(shape).join("")}</v:group></w:pict></w:r>`;
}
