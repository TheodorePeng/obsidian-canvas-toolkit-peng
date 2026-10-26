/** Document policies mirror the manager's independently tested Python contract. */
import {Json,canonical,insist,validateCanvas,inside,overlaps} from "./agent-contract";

export function flatCanvas(data:Json):boolean{
  try{
    validateCanvas(data);
    const cards:Json[]=(data.nodes??[]).filter((n:Json)=>n.type!=="group");
    const groups:Json[]=(data.nodes??[]).filter((n:Json)=>n.type==="group");
    return !cards.some((a,i)=>cards.slice(i+1).some(b=>overlaps(a,b)))
      &&!groups.some((a,i)=>groups.slice(i+1).some(b=>overlaps(a,b)))
      &&cards.every(c=>groups.every(g=>!overlaps(c,g)||inside(c,g)));
  }catch{return false;}
}

export function compareCanvas(a:Json,b:Json,policy="strict"):boolean{
  if(policy==="strict")return canonical(a)===canonical(b);
  if(policy!=="flat"||!flatCanvas(a)||!flatCanvas(b))return false;
  const index=(d:Json)=>({...d,nodes:Object.fromEntries((d.nodes??[]).map((n:Json)=>[n.id,n])),edges:Object.fromEntries((d.edges??[]).map((e:Json)=>[e.id,e]))});
  return canonical(index(a))===canonical(index(b));
}

export function structureDelta(before:Json,after:Json):Json{
  validateCanvas(before);validateCanvas(after);const result:Json={};
  const fields=(a:Json,b:Json)=>[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>
    Object.prototype.hasOwnProperty.call(a,k)!==Object.prototype.hasOwnProperty.call(b,k)||canonical(a[k])!==canonical(b[k])).sort();
  for(const key of ["nodes","edges"]){
    const a:Json=Object.fromEntries((before[key]??[]).map((n:Json)=>[n.id,n]));
    const b:Json=Object.fromEntries((after[key]??[]).map((n:Json)=>[n.id,n]));
    result[key]={added:Object.keys(b).filter(i=>!Object.prototype.hasOwnProperty.call(a,i)).sort(),
      removed:Object.keys(a).filter(i=>!Object.prototype.hasOwnProperty.call(b,i)).sort(),
      updated:Object.keys(a).filter(i=>Object.prototype.hasOwnProperty.call(b,i)&&canonical(a[i])!==canonical(b[i])).sort().map(id=>({id,fields:fields(a[id],b[id])}))};
  }
  result.rootFields=fields(before,after).filter(k=>k!=="nodes"&&k!=="edges");return result;
}

export function assertRestructure(before:Json,after:Json,approval:Json):void{
  const delta=structureDelta(before,after);
  insist(flatCanvas(after)&&canonical(approval?.delta)===canonical(delta)&&!delta.rootFields.length,"scope","Structural delta differs, root fields changed or result is not flat");
  const permitted:Record<string,string[]>={nodes:["x","y","width","height","color","text","file","subpath","label","url"],edges:["fromNode","toNode","fromSide","toSide","fromEnd","toEnd","color","label"]};
  const reason=(map:Json|undefined,id:string)=>typeof map?.[id]==="string"&&map[id].trim().length>0;
  for(const [key,removal] of [["nodes","removeNodes"],["edges","removeEdges"]]){
    for(const id of delta[key].removed)insist(reason(approval[removal],id),"scope","Removal requires a task-authorized reason: "+id);
    for(const change of delta[key].updated){
      insist(change.fields.every((k:string)=>permitted[key].includes(k)),"scope","Unknown fields and existing types must survive: "+change.id);
      if(key==="nodes"&&change.fields.includes("text"))insist(reason(approval.textChanges,change.id),"scope","Existing text requires a task-authorized reason: "+change.id);
    }
  }
}

export function assertSourceManifest(actual:Json,expected:Json|undefined):void{
  insist(expected&&typeof expected==="object"&&!Array.isArray(expected)&&canonical(actual)===canonical(expected),
    "conflict","Source manifest is missing, incomplete or changed");
}
