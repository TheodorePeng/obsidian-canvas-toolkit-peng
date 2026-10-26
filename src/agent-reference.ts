/** Heading paths are semantic candidates; native resolveSubpath remains authoritative. */
export interface HeadingEntry {heading:string;level:number;position:{start:{line:number}}}
const clean=(s:string)=>s.replace(/\[([^\]]+)\]\([^)]*\)/g,"$1").replace(/[*_`]/g,"").trim().toLocaleLowerCase();
export function headingCandidates(headings:HeadingEntry[],subpath:string):{line:number;path:string[]}[]{
  const parts=subpath.replace(/^#/,"").split("#").map(clean),stack:HeadingEntry[]=[],result:{line:number;path:string[]}[]=[];
  for(const h of headings){
    while(stack.length&&stack[stack.length-1].level>=h.level)stack.pop();stack.push(h);
    const names=stack.map(x=>x.heading),normalized=names.map(clean);
    if(parts.length<=normalized.length&&parts.every((p,i)=>p===normalized[normalized.length-parts.length+i]))result.push({line:h.position.start.line,path:names});
  }
  return result;
}
