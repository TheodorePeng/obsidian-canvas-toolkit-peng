/** Pure protocol invariants; no Obsidian or desktop imports. */
export type Json = Record<string, any>;
export class BridgeError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function insist(ok: unknown, code: string, message: string): asserts ok {
  if (!ok) throw new BridgeError(code, message);
}
export function canonical(value: any): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    insist(typeof value !== "number" || Number.isFinite(value), "invalid", "Non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}
export function safePath(path: unknown): string {
  insist(typeof path === "string" && path.length > 0 && !path.includes("\\"), "invalid", "Expected vault-relative path");
  insist(path.split("/").every(p => !!p && p !== "." && p !== ".." && !p.startsWith(".")), "invalid", "Hidden or escaping paths are not allowed");
  insist(/\.(md|base|canvas)$/.test(path), "invalid", "Supported extensions: md, base, canvas");
  return path;
}
export function validateCanvas(data: Json): void {
  insist(data && typeof data === "object" && !Array.isArray(data), "invalid", "Expected Canvas object");
  const nodes = data.nodes ?? [], edges = data.edges ?? [];
  insist(Array.isArray(nodes) && Array.isArray(edges), "invalid", "Expected nodes and edges arrays");
  const ids = new Set<string>(), nodeIds = new Set<string>();
  for (const n of nodes) {
    insist(n && typeof n.id === "string" && n.id.length && !ids.has(n.id), "invalid", "Invalid or duplicate ID");
    ids.add(n.id); nodeIds.add(n.id);
    insist(["text", "file", "link", "group"].includes(n.type), "invalid", "Invalid node type");
    for (const k of ["x", "y", "width", "height"]) insist(Number.isInteger(n[k]), "invalid", "Invalid node geometry");
    insist(n.width > 0 && n.height > 0, "invalid", "Non-positive dimensions");
    const key = ({text:"text", file:"file", link:"url"} as Json)[n.type];
    if (key) insist(typeof n[key] === "string", "invalid", "Missing node content");
  }
  for (const e of edges) {
    insist(e && typeof e.id === "string" && e.id.length && !ids.has(e.id), "invalid", "Invalid or duplicate edge ID");
    ids.add(e.id);
    insist(nodeIds.has(e.fromNode) && nodeIds.has(e.toNode), "invalid", "Dangling edge");
  }
}
export const inside = (a: Json, b: Json): boolean => a.x >= b.x && a.y >= b.y && a.x+a.width <= b.x+b.width && a.y+a.height <= b.y+b.height;
export const overlaps = (a: Json, b: Json): boolean => a.x < b.x+b.width && a.x+a.width > b.x && a.y < b.y+b.height && a.y+a.height > b.y;
export function resolveScope(data: Json, selected: string[], scope: string): string[] {
  validateCanvas(data);
  const nodes: Json[] = data.nodes ?? [];
  if (scope === "all") return nodes.filter(n=>n.type!=="group").map(n=>n.id);
  insist(Array.isArray(selected) && selected.length && new Set(selected).size===selected.length, "scope", "Select cards or one group first");
  insist(selected.every(id=>nodes.some(n=>n.id===id)), "scope", "Unknown selected ID");
  if (scope === "selected") {
    insist(selected.every(id=>nodes.find(n=>n.id===id)?.type!=="group"), "scope", "Use group scope for a group");
    return nodes.filter(n=>selected.includes(n.id)).map(n=>n.id);
  }
  insist(scope === "group" && selected.length===1, "scope", "Select exactly one group");
  const group = nodes.find(n=>n.id===selected[0]);
  insist(group?.type === "group", "scope", "Selected object is not a group");
  for (const n of nodes) {
    if (n.id===group.id) continue;
    if (n.type==="group") insist(!overlaps(n,group), "scope", "Nested or overlapping groups require explicit expansion");
    else insist(!overlaps(n,group) || inside(n,group), "scope", "Card crosses the group boundary");
  }
  const result = nodes.filter(n=>n.type!=="group" && inside(n,group)).map(n=>n.id);
  insist(result.length, "scope", "Group contains no content cards");
  return result;
}
export function patchedCanvas(data: Json, patch: Json[], allowed: string[], fields: string[]): Json {
  validateCanvas(data);
  insist(Array.isArray(patch) && Array.isArray(allowed) && fields.every(k=>["x","y","width","height"].includes(k)), "scope", "Invalid geometry contract");
  const result = JSON.parse(JSON.stringify(data)), seen = new Set<string>();
  for (const p of patch) {
    insist(p && allowed.includes(p.id) && !seen.has(p.id), "scope", "Patch targets an unapproved or duplicate node");
    seen.add(p.id);
    const n = result.nodes.find((n: Json)=>n.id===p.id);
    insist(n && p.changes && Object.keys(p.changes).every(k=>fields.includes(k)), "scope", "Unapproved field");
    Object.assign(n,p.changes);
  }
  validateCanvas(result); return result;
}

/** Existing serialized fields must survive the runtime before any write. */
export function preserves(before:any, runtime:any):boolean {
  if(before===null||typeof before!=="object")return before===runtime;
  if(Array.isArray(before))return Array.isArray(runtime)&&before.length===runtime.length&&before.every((v,i)=>preserves(v,runtime[i]));
  return runtime!==null&&typeof runtime==="object"&&Object.keys(before).every(k=>Object.prototype.hasOwnProperty.call(runtime,k)&&preserves(before[k],runtime[k]));
}

/** Native Bases AST diagnostics; skip back-references rather than stringify native objects. */
export function baseDiagnostics(value:any):Json[] {
  const issues:Json[]=[],seen=new Set<any>();
  const visit=(v:any,path:string,depth:number):void=>{
    if(!v||typeof v!=="object"||seen.has(v)||depth>12)return;
    seen.add(v);
    if(v.type==="invalid"||v.parseError)issues.push({path,reason:"base_expression",message:String(v.parseError??"Invalid expression")});
    for(const k of Object.keys(v))if(!["query","app","controller","file","saveFn"].includes(k))visit(v[k],path+"."+k,depth+1);
  };
  visit(value,"base",0);return issues;
}
