import { SUPPORTED_MATH_SYMBOLS, MATH_FUNCTIONS, SUPPORTED_MATH_COMMANDS, SUPPORTED_MATH_ENVIRONMENTS, MATH_GRID_DELIMITERS } from './math-capabilities.mjs';
import { readMathGroup, readMathEnvironment, parseMathGrid, parseArrayColumns } from './math-grid';
import { normalizeMathNotation } from './math-notation.mjs';
import { xmlSafeText } from './xml-text';

const escape = (s:string) => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
const symbols=SUPPORTED_MATH_SYMBOLS;
const functions=new Set(MATH_FUNCTIONS);
const superscripts:Record<string,string> = {'⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9','⁺':'+','⁻':'−'};
type Style = 'p'|'i'|'b'|'double-struck';
// Unicode letters retain their double-struck identity in Word importers that
// ignore m:scr. Keep native math runs; never rasterize a set symbol.
function doubleStruck(text:string) {
  const exceptions:Record<string,string>={C:'\u2102',H:'\u210D',N:'\u2115',P:'\u2119',Q:'\u211A',R:'\u211D',Z:'\u2124'};
  return Array.from(text,c=>exceptions[c]||(/^[A-Z]$/.test(c)?String.fromCodePoint(0x1D538+c.charCodeAt(0)-65):/^[a-z]$/.test(c)?String.fromCodePoint(0x1D552+c.charCodeAt(0)-97):/^[0-9]$/.test(c)?String.fromCodePoint(0x1D7D8+c.charCodeAt(0)-48):c)).join('');
}
const run = (s:string,style?:Style) => `<m:r><m:rPr>${/^\s+$/.test(s)?'<m:nor/>':''}${style==='double-struck'?'<m:scr m:val="double-struck"/>':''}<m:sty m:val="${style==='double-struck'?'p':/[0-9]/.test(s)?'p':style??(/^[A-Za-zα-ωΑ-Ω]+$/.test(s)?'i':'p')}"/></m:rPr><m:t xml:space="preserve">${escape(style==='double-struck'?doubleStruck(s):s)}</m:t></m:r>`;
const wrap = (name:string,inner:string) => `<m:${name}>${inner}</m:${name}>`;
const delimiter = (body:string,begin:string,end:string) => wrap('d',`<m:dPr><m:begChr m:val="${escape(begin)}"/><m:endChr m:val="${escape(end)}"/></m:dPr>${wrap('e',body)}`);
// A ( or [ with no ) or ] before its group ends. OCR keeps a blank outside the
// formula, so one pair can span two formulas: "=($____$+...)^2$". KaTeX shows
// such a bracket as a plain character, and so does Word.
class UnpairedBracket extends Error {}

/** Strict native OMML: unsupported notation fails instead of leaking command names. */
function compileMathOmml(source:string):string {
  if(xmlSafeText(source)!==source)throw new Error('公式含异常控制字符，请对照原件校正');
  const text:string=normalizeMathNotation(source).replace(/\*\*/g,'^').replace(/（/g,'(').replace(/）/g,')').replace(/＝/g,'=').replace(/＋/g,'+').replace(/－/g,'−').replace(/＜/g,'<').replace(/＞/g,'>');
  let i=0,parseDepth=0;
  const unpaired=new Set<number>();
  const skip=()=>{while(i<text.length&&/\s/.test(text[i]))i++;};
  function rawGroup():string {
    skip();const group=readMathGroup(text,i);i=group.end;return group.body;
  }
  function group(style?:Style):string {
    skip();if(i>=text.length)throw new Error('公式缺少分子、分母或上下标');
    if(text[i]==='{'){i++;return sequence('}',style);}
    return atom(style);
  }
  function command(style?:Style):string {
    i++;const name=text.slice(i).match(/^[A-Za-z]+/)?.[0]??text[i]??'';i+=name.length;
    if(!name)throw new Error('公式反斜杠命令缺少名称');
    if(/^[A-Za-z]+$/.test(name)&&!SUPPORTED_MATH_COMMANDS.has(name))throw new Error(`Unsupported math command \\${name}`);
    if(['left','right'].includes(name)){if(text[i]==='.')i++;return '';}
    if([',',';',':',' ','!'].includes(name))return name==='!'?'':run(' ');
    if(name==='\\')throw new Error('Row separators are allowed only inside a math grid');
    if(['{','}','%','#','&','_','$'].includes(name))return run(name,style);
    if(['text','textrm'].includes(name))return run(rawGroup(),'p');
    if(['mathrm','operatorname'].includes(name))return group('p');
    if(name==='mathit')return group('i');
    if(name==='mathbf')return group('b');
    if(name==='mathbb')return group('double-struck');
    if(name==='boldsymbol'){
      // OCR may drop the braces from a one-token bold vector command. Keep
      // that token bold and editable instead of leaking "boldsymbol" text.
      skip();
      return text[i]==='{'?group('b'):text[i]==='\\'?command('b'):atom('b');
    }
    if(name==='lim'){
      skip();const base=run('lim','p');
      if(text[i]!=='_')return base;
      i++;return wrap('limLow',wrap('e',base)+wrap('lim',group(style)));
    }
    // Preserve invisible alignment content as native Word math, including its
    // dimensions. Dropping the command would expose hidden repeated symbols.
    if(['phantom','hphantom','vphantom'].includes(name)) {
      const dimensions=name==='hphantom'?'<m:zeroAsc m:val="1"/><m:zeroDesc m:val="1"/>':name==='vphantom'?'<m:zeroWid m:val="1"/>':'';
      return wrap('phant',`<m:phantPr><m:show m:val="0"/>${dimensions}</m:phantPr>${wrap('e',group(style))}`);
    }
    if(['frac','dfrac','tfrac'].includes(name))return wrap('f',wrap('num',group(style))+wrap('den',group(style)));
    if(name==='sqrt'){
      skip();let degree='';if(text[i]==='['){i++;degree=sequence(']',style);}
      return wrap('rad',`<m:radPr><m:degHide m:val="${degree?'0':'1'}"/></m:radPr>${wrap('deg',degree)}${wrap('e',group(style))}`);
    }
    if(['widehat','hat','overparen','wideparen','overgroup'].includes(name))return wrap('acc',`<m:accPr><m:chr m:val="${name==='overparen'||name==='wideparen'?'⏜':name==='overgroup'?'⏠':'̂'}"/></m:accPr>${wrap('e',group(style))}`);
    if(['underline','overline'].includes(name))return wrap('bar',`<m:barPr><m:pos m:val="${name==='underline'?'bot':'top'}"/></m:barPr>${wrap('e',group(style))}`);
    if(name==='sout')return wrap('borderBox',`<m:borderBoxPr><m:hideTop m:val="1"/><m:hideBot m:val="1"/><m:hideLeft m:val="1"/><m:hideRight m:val="1"/><m:strikeH m:val="1"/></m:borderBoxPr>${wrap('e',group(style))}`);
    if(name==='xlongequal')return wrap('limUpp',wrap('e',run('='))+wrap('lim',group(style)));
    if(name==='mkern'){
      const spacing=text.slice(i).match(/^-?\d+(?:\.\d+)?mu/);if(!spacing)throw new Error('公式间距命令无效');i+=spacing[0].length;return '';
    }
    if(name==='begin'){
      const env=rawGroup();
      if(!SUPPORTED_MATH_ENVIRONMENTS.has(env))throw new Error(`Unsupported math environment ${env}`);
      const columns=env==='array'?parseArrayColumns(rawGroup()):undefined;
      const region=readMathEnvironment(text,i,env); i=region.end;
      const grid=parseMathGrid(region.body,env==='array');
      if(env==='cases')return delimiter(wrap('eqArr','<m:eqArrPr><m:baseJc m:val="center"/></m:eqArrPr>'+grid.rows.map(r=>wrap('e',r.map(c=>mathOmml(c)).join(run(' ')))).join('')),'{','');
      const count=columns?.length??Math.max(...grid.rows.map(r=>r.length));
      if(count>32||grid.rows.some(r=>r.length>count))throw new Error('Math grid column count does not match its specification');
      const props=Array.from({length:count},(_,c)=>wrap('mc',wrap('mcPr',`<m:count m:val="1"/><m:mcJc m:val="${columns?.[c].align??(env==='aligned'?(c%2?'left':'right'):'center')}"/>`))).join('');
      // Inter-column material belongs to cell width, not source mathematics.
      const content=grid.rows.map(r=>Array.from({length:count},(_,c)=>mathOmml(r[c]||'')+(c<count-1?run(columns?.[c].gap??'\u2002'):'')));
      if(grid.rules.size)throw new Error('Ruled array requires a standalone display equation; inline or nested horizontal rules cannot be exported reliably');
      const rows=content.map(r=>wrap('mr',r.map(c=>wrap('e',c)).join(''))).join('');
      const body=wrap('m',wrap('mPr','<m:cGpRule m:val="4"/><m:cGp m:val="0"/>'+wrap('mcs',props)+'<m:plcHide m:val="1"/>')+rows);
      const pair=MATH_GRID_DELIMITERS[env];
      return pair?delimiter(body,pair[0],pair[1]):body;
    }
    if(functions.has(name))return run(name,'p');
    if(symbols[name])return run(symbols[name],style);
    throw new Error(`公式暂不支持 ${name}，不能改用公式截图`);
  }
  function atom(style?:Style):string {
    const c=text[i];
    if(c==='\\')return command(style);
    if(c==='{'){i++;return sequence('}',style);}
    if(c==='('||c==='['){
      // Each position is tried once, so many open brackets cannot multiply the work.
      const start=i;
      if(!unpaired.has(start))try{
        i++;let closing=c==='('?')':']';
        const body=sequence(')]',style,end=>{closing=end;});
        return delimiter(body,c,closing);
      }catch(error){if(!(error instanceof UnpairedBracket))throw error;unpaired.add(start);}
      i=start+1;return run(c,style);
    }
    if(c==='√'){i++;return wrap('rad','<m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/>'+wrap('e',group(style)));}
    if(c==='$')throw new Error('Unescaped math delimiter inside equation');
    const character=String.fromCodePoint(text.codePointAt(i)!);
    i+=character.length;return run(character,style);
  }
  function sequence(end?:string,style?:Style,onClose?:(end:string)=>void):string {
    if(++parseDepth>64)throw new Error('Math grouping exceeds 64 levels');
    try {
    const result:string[]=[];
    while(i<text.length){
      const c=text[i];if(end&&end.includes(c)){onClose?.(c);i++;return result.join('');}
      if(c==='}'){if(end===')]')throw new UnpairedBracket();throw new Error('公式出现多余的右花括号');}
      if(c==='^'||c==='_'){
        i++;if(!result.length)throw new Error('公式上下标缺少底数');
        const base=result.pop()!;const script=group(style);
        skip();
        if(text[i]===(c==='_'?'^':'_')) {
          i++;const other=group(style);
          result.push(wrap('sSubSup',wrap('e',base)+wrap('sub',c==='_'?script:other)+wrap('sup',c==='^'?script:other)));
        } else result.push(wrap(c==='^'?'sSup':'sSub',wrap('e',base)+wrap(c==='^'?'sup':'sub',script)));
        continue;
      }
      if(superscripts[c]){
        if(!result.length)throw new Error('公式上标缺少底数');let value='';
        while(superscripts[text[i]])value+=superscripts[text[i++]];
        result.push(wrap('sSup',wrap('e',result.pop()!)+wrap('sup',run(value,'p'))));continue;
      }
      if(/\s/.test(c)){i++;continue;}
      result.push(atom(style));
    }
    if(end===')]')throw new UnpairedBracket();
    if(end)throw new Error(`公式 ${end} 未闭合`);
    return result.join('');
    } finally {parseDepth--;}
  }
  return sequence();
}


// Successful pure compilations only, before color/size/layout. Bound entries
// AND UTF-16 storage; never cache images, user identifiers or credentials.
const compiledMath=new Map<string,string>();
let cacheUnits=0,compileDepth=0;
export function mathOmml(source:string):string {
  if(source.length>100_000)throw new Error('Math expression exceeds the 100000-character limit');
  const hit=compiledMath.get(source);
  if(hit!==undefined){compiledMath.delete(source);compiledMath.set(source,hit);return hit;}
  if(compileDepth>=32)throw new Error('Math nesting exceeds the 32-level limit');
  compileDepth++;
  try {
    let xml=compileMathOmml(source);
    // A relation starting an aligned cell is not a binary expression by itself.
    // Normal-text math runs retain the visible relation without an importer
    // inventing a missing left operand (LibreOffice otherwise shows an error).
    const firstRun=xml.match(/^<m:r>[\s\S]*?<\/m:r>/)?.[0];
    if(firstRun&&/<m:t[^>]*>(?:=|&lt;|&gt;|[\u2260\u2264\u2265\u2248\u223c\u2261])<\/m:t>/.test(firstRun))
      xml=xml.replace('<m:rPr>','<m:rPr><m:nor/>');
    const units=source.length+xml.length;
    if(units<=256_000){
      while(compiledMath.size>=256||cacheUnits+units>1_000_000){
        const key=compiledMath.keys().next().value!;
        cacheUnits-=key.length+compiledMath.get(key)!.length;compiledMath.delete(key);
      }
      compiledMath.set(source,xml);cacheUnits+=units;
    }
    return xml;
  } finally {compileDepth--;}
}
