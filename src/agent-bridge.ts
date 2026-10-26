import { App, Platform, TFile, parseYaml, resolveSubpath } from "obsidian";
import { CanvasContextService } from "./canvas-context";
import { ResizeEngine } from "./resize-engine";
import { BridgeError, Json, canonical, insist, safePath, validateCanvas, resolveScope, patchedCanvas, preserves, baseDiagnostics } from "./agent-contract";

const terminal = new Set(["completed","partial","conflict","failed","cancelled"]);
const sleep = (ms: number) => new Promise<void>(r=>window.setTimeout(r,ms));
async function hash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes)).map(n=>n.toString(16).padStart(2,"0")).join("");
}
const clone = (v: any): any => JSON.parse(JSON.stringify(v));

/** Agent API v1. Its runtime adapter is deliberately confined to this class. */
export class AgentBridge {
  lastSnapshotId: string | null = null;
  private snapshots = new Map<string,Json>();
  private operations = new Map<string,Json>();
  private queue: Promise<void> = Promise.resolve();
  private queueState:{tail:Promise<void>};
  private stopped = false;
  private journal: string;
  private protectionQueue:Promise<void>=Promise.resolve();
  constructor(private app: App, private context: CanvasContextService, private resize: ResizeEngine) {
    this.journal = `${app.vault.configDir}/plugins/canvas-toolkit-peng/agent-runs`;
    // A previous generation may still be unwinding a native render/save after unload.
    const owner=app as any;
    this.queueState=owner.__canvasToolkitPengAgentQueueV1??(owner.__canvasToolkitPengAgentQueueV1={tail:Promise.resolve()});
    this.queue=this.queueState.tail;
  }
  capabilities(): Json {
    return {protocolVersion:1,pluginVersion:"0.2.0",desktop:Platform.isDesktop,vault:this.app.vault.getName(),operations:["write","canvas-patch","canvas-fit","restore","recover-trash"],nativeBaseDiagnostics:true,sourceProtection:"enhanced-canvas-scoped",stagingPrefix:"_AgentWorkspace/obsidian-manager-peng/"};
  }
  private file(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(safePath(path));
    insist(!f || f instanceof TFile,"invalid","Path names a folder"); return f as TFile | null;
  }
  private leaf(path: string, leafId?: string): any {
    const leaves = this.app.workspace.getLeavesOfType("canvas").filter((l:any)=>l.view.file?.path===path);
    if (leafId) return leaves.find((l:any)=>l.id===leafId) ?? null;
    const active = leaves.find(l=>l===this.app.workspace.activeLeaf);
    if (active) return active;
    insist(leaves.length<=1,"scope","Multiple views of this canvas; specify leafId");
    return leaves[0] ?? null;
  }
  private node(leaf:any,id:string):any {
    return leaf?.view?.canvas?.nodes?.get(id) ?? null;
  }
  private dirtyMarkdown(path: string, disk:string): boolean {
    return this.app.workspace.getLeavesOfType("markdown").some((l:any)=>l.view.file?.path===path && typeof l.view.editor?.getValue==="function" && l.view.editor.getValue()!==disk);
  }
  private async protectSources<T>(action:()=>Promise<T>):Promise<T> {
    const prior=this.protectionQueue;
    let release!:()=>void;
    this.protectionQueue=new Promise<void>(r=>release=r);
    await prior;
    let restore:(()=>Promise<void>)|null=null;
    try{
      const plugin=(this.app as any).plugins.plugins["enhanced-canvas"],settings=plugin?.settings;
      if(plugin){
        insist(typeof settings?.enableFrontmatter==="boolean","unsupported","Enhanced Canvas source-write control unavailable");
        const path=`${this.app.vault.configDir}/plugins/enhanced-canvas/data.json`;
        const before=await this.app.vault.adapter.stat(path),original=settings.enableFrontmatter;
        settings.enableFrontmatter=false;
        restore=async()=>{
          const after=await this.app.vault.adapter.stat(path);
          insist(plugin.settings===settings&&settings.enableFrontmatter===false&&before?.mtime===after?.mtime,"conflict","Enhanced Canvas settings changed during source protection; inspect settings");
          settings.enableFrontmatter=original;
        };
      }
      return await action();
    }finally{try{if(restore)await restore();}finally{release();}}
  }
  async captureContext(request: Json): Promise<Json> {
    insist(Platform.isDesktop,"unsupported","Agent bridge requires desktop Obsidian");
    if (request.snapshotId) { const old=this.snapshots.get(request.snapshotId); insist(old,"conflict","Selection snapshot expired"); return clone(old); }
    let path = request.path;
    if (!path) {
      const v:any=this.app.workspace.activeLeaf?.view;
      insist(v?.getViewType?.()==="canvas" && v.file?.path,"scope","Open or specify the target canvas"); path=v.file.path;
    }
    path=safePath(path);
    if(request.open===true&&path.endsWith(".canvas")&&!this.leaf(path,request.leafId)){
      insist(!request.leafId,"scope","Requested leaf is unavailable");
      await this.protectSources(async()=>{
        const original=JSON.parse(await this.app.vault.read(this.file(path)!)),l=await this.open(path);
        insist(preserves(original,l.view.canvas.getData()),"unsupported","Native Canvas dropped existing document fields");
        await this.saved(l);
      });
    }
    const file=this.file(path); insist(file,"missing","Target file not found");
    const content=await this.app.vault.read(file), scope=request.scope??"all";
    const leaf=path.endsWith(".canvas")?this.leaf(path,request.leafId):null;
    if(request.leafId)insist(leaf,"scope","Requested canvas leaf is unavailable");
    const diskData=path.endsWith(".canvas")?JSON.parse(content):null;
    const runtimeData=leaf?clone(leaf.view.canvas.getData()):null;
    let selectedIds:string[]=[], groupId:string|null=null;
    if (diskData) {
      if(scope!=="all") insist(leaf,"scope","Selection requires an open target canvas");
      const selected=leaf?this.context.getSelectedNodes(leaf.view.canvas).map(n=>this.context.getNodeData(n)?.id).filter(Boolean):[];
      selectedIds=resolveScope(runtimeData??diskData,selected as string[],scope);
      if(scope==="group") groupId=selected[0] as string;
    }
    const snapshot={snapshotId:crypto.randomUUID(),vault:this.app.vault.getName(),path,scope,leafId:leaf?.id??null,content,diskData,runtimeData,expectedHash:await hash(content),runtimeHash:runtimeData?await hash(canonical(runtimeData)):null,nodeIds:selectedIds,groupId,dirty:Boolean(leaf?.view.dirty)||this.dirtyMarkdown(path,content)||(runtimeData!==null&&canonical(diskData)!==canonical(runtimeData)),capturedAt:new Date().toISOString()};
    this.snapshots.set(snapshot.snapshotId,snapshot); return clone(snapshot);
  }
  private async reference(target: string, sourcePath: string): Promise<Json> {
    const [raw,...rest]=target.split("#");
    const f=raw?this.app.metadataCache.getFirstLinkpathDest(raw,sourcePath):this.file(sourcePath);
    if(!f) return {target,ok:false,reason:"file_missing"};
    if(!rest.length) return {target,ok:true,path:f.path};
    const sub="#"+rest.join("#");
    let ok=false;
    for(let i=0;i<10;i++){
      const cache=this.app.metadataCache.getFileCache(f);
      ok=Boolean(cache && resolveSubpath(cache,sub));
      if(ok)break;
      await sleep(50);
    }
    return {target,path:f.path,ok,reason:ok?undefined:"subpath_missing_or_not_indexed"};
  }
  async validateDocument(request: Json): Promise<Json> {
    const path=safePath(request.path),content=request.content;
    insist(typeof content==="string","invalid","Document content must be text");
    const issues:Json[]=[],refs:Json[]=[];
    if(path.endsWith(".base")) {
      try {
        const parsed=parseYaml(content);
        if(!parsed || typeof parsed!=="object" || Array.isArray(parsed) || !Array.isArray(parsed.views) || !parsed.views.length) issues.push({reason:"base_requires_views"});
      } catch(e) {issues.push({reason:"yaml",message:String(e)});}
    } else if(path.endsWith(".canvas")) {
      try {
        const data=JSON.parse(content);validateCanvas(data);
        const previous=typeof request.previousContent==="string"&&request.previousContent?JSON.parse(request.previousContent):null;
        const previousNodes=new Map<string,Json>((previous?.nodes??[]).map((n:Json)=>[n.id,n]));
        for(const n of data.nodes??[])if(n.type==="file"){
          const old=previousNodes.get(n.id);
          if(old?.type!=="file"||old.file!==n.file||old.subpath!==n.subpath)refs.push(await this.reference(n.file+(n.subpath??""),path));
        }
        for(const n of data.nodes??[])if(n.type==="text"){
          const checked=await this.validateDocument({path:path.replace(/\.canvas$/,".md"),content:n.text,previousContent:previousNodes.get(n.id)?.text});
          refs.push(...checked.references.map((r:Json)=>({...r,nodeId:n.id})));
        }
      } catch(e) {issues.push({reason:"canvas",message:String(e)});}
    } else {
      // Ignore fenced code and inline code; validate references introduced by this edit only.
      const visible=content.replace(/^\s*(```+|~~~+)[\s\S]*?^\s*\1\s*$/gm,"").replace(/`[^`\n]*`/g,"");
      const previous=new Set<string>();
      if(typeof request.previousContent==="string") for(const m of request.previousContent.matchAll(/!?\[\[([^\]]+)\]\]/g)) previous.add(m[1].split("|")[0]);
      for(const m of visible.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
        const target=m[1].split("|")[0];
        if(!previous.has(target)) refs.push(await this.reference(target,path));
      }
    }
    if(path.endsWith(".md")) {
      const visible=content.replace(/^\s*(```+|~~~+)[\s\S]*?^\s*\1\s*$/gm,"").replace(/`[^`\n]*`/g,"");
      const previous = new Set(Array.from((request.previousContent??"").matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g),(m:any)=>m[1]));
      for(const m of visible.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
        if(!previous.has(m[1])&&!/^[a-z][a-z0-9+.-]*:/i.test(m[1]))refs.push(await this.reference(decodeURI(m[1]),path));
      }
    }
    issues.push(...refs.filter(r=>!r.ok));
    return {ok:issues.length===0,issues,references:refs};
  }
  async validateBaseQuery(request:Json):Promise<Json> {
    const path=safePath(request.path),file=this.file(path);
    insist(file&&path.endsWith(".base"),"invalid","Existing Base required for native validation");
    const content=await this.app.vault.read(file),before=await hash(content);
    const folder="_AgentWorkspace/obsidian-manager-peng/native-"+crypto.randomUUID();
    await this.mkdir(folder);
    const scratch=await this.app.vault.create(folder+"/parser.base","views:\n  - type: table\n    name: Parser\n");
    const leaf:any=this.app.workspace.getLeaf("tab");
    try{
      await leaf.openFile(scratch);
      for(let i=0;i<40&&!leaf.view.query;i++)await sleep(50);
      const view=leaf.view,Q=view.query?.constructor,controller=view.controller;
      insist(typeof Q?.fromString==="function"&&controller,"unsupported","Native Bases query diagnostics unavailable");
      // Parse without a target view or save callback. Opening the target can rewrite its YAML.
      const query=Q.fromString(content);query.file=file;
      const issues=baseDiagnostics({formulas:query.formulas,views:query.views,filters:query.filters,summaries:query.summaryFormulas});
      if(!issues.length){
        insist(typeof controller.setQuery==="function"&&typeof controller.update==="function","unsupported","Native Bases evaluator unavailable");
        controller.viewName=undefined;controller.setQuery(query);
        for(const config of query.views){
          controller.viewName=config.name;controller.update();
          for(let i=0;i<100&&controller.initialScan;i++)await sleep(50);
          insist(!controller.initialScan,"timeout","Native Base evaluation did not complete");
          if(controller.error)issues.push({view:config.name,reason:"base_view",message:String(controller.error)});
          for(const error of controller.errors??[])issues.push({view:config.name,reason:"base_evaluation",message:String(error?.message??error)});
          const rows=Array.from(controller.results?.values()??[]) as any[];
          if(rows.length){
            const invalid=Q.fromString('formulas:\n  invalid: "__obsidian_manager_missing_function_0f4c2(1)"\nviews:\n  - type: table\n    name: ErrorProbe\n');
            const errorValue=invalid.formulas.invalid.getValue(rows[0]);
            insist(typeof errorValue?.message==="string","unsupported","Native Bases error-value interface unavailable");
            const ErrorValue=errorValue.constructor;
            for(const [name,formula] of Object.entries(query.formulas??{}) as [string,any][]){
              for(const row of rows){
                const value=formula.getValue(row);
                if(value instanceof ErrorValue){issues.push({view:config.name,formula:name,reason:"base_evaluation",message:String(value)});break;}
              }
            }
          }
        }
      }
      insist(await hash(await this.app.vault.read(file))===before,"conflict","Base changed during native validation");
      return {ok:issues.length===0,issues,engine:"obsidian-native",targetUnchanged:true};
    }finally{leaf.detach();}
  }
  private async mkdir(path: string): Promise<void> {
    let p="";for(const s of path.split("/")){p=p?`${p}/${s}`:s;if(!(await this.app.vault.adapter.exists(p))) await this.app.vault.adapter.mkdir(p);}
  }
  private async record(op:Json):Promise<void> {
    op.updatedAt=new Date().toISOString();await this.mkdir(this.journal);
    await this.app.vault.adapter.write(`${this.journal}/${op.operationId}.json`,JSON.stringify(op));
  }
  async getOperation(id:string):Promise<Json|null> {
    insist(/^[a-zA-Z0-9-]{8,80}$/.test(id),"invalid","Invalid operation ID");
    const inMemory=this.operations.get(id);if(inMemory)return clone(inMemory);
    const path=`${this.journal}/${id}.json`;
    if(!(await this.app.vault.adapter.exists(path)))return null;
    const op=JSON.parse(await this.app.vault.adapter.read(path));
    if(!terminal.has(op.status)){op.status="partial";op.error={code:"interrupted",message:"Plugin reloaded while operation was active; inspect current file before retrying"};await this.record(op);}
    this.operations.set(id,op);return clone(op);
  }
  async submit(request:Json):Promise<Json> {
    insist(Platform.isDesktop&&!this.stopped,"unsupported","Bridge unavailable");
    const id=request.operationId;insist(typeof id==="string"&&/^[a-zA-Z0-9-]{8,80}$/.test(id),"invalid","Invalid operation ID");
    safePath(request.path);insist(request.vault===this.app.vault.getName(),"scope","Wrong vault");
    insist(["write","restore","canvas-patch","canvas-fit","recover-trash"].includes(request.kind),"invalid","Unsupported operation");
    const fingerprint=await hash(canonical(request)),existing=await this.getOperation(id);
    if(existing){insist(existing.fingerprint===fingerprint,"conflict","Operation ID reused with different input");return existing;}
    const op:Json={operationId:id,fingerprint,path:request.path,status:"accepted",createdAt:new Date().toISOString(),persisted:false};
    this.operations.set(id,op);await this.record(op);
    insist(!this.stopped,"cancelled","Bridge reloaded before dispatch; inspect the accepted operation");
    this.queue=this.queue.then(async()=>{
      try {
        this.checkCancelled(op);op.status="running";await this.record(op);
        op.result=request.path.endsWith(".canvas")?await this.protectSources(()=>this.execute(request,op)):await this.execute(request,op);
        op.persisted=true;this.checkCancelled(op);
        op.status=op.result.partial?"partial":"completed";
      } catch(e) {
        const error=e instanceof BridgeError?e:new BridgeError("runtime",String(e));
        op.status=op.mutated?"partial":error.code==="cancelled"?"cancelled":error.code==="conflict"?"conflict":"failed";
        op.error={code:error.code,message:error.message};
      }
      await this.record(op);
    }).catch(e=>console.error("[Canvas Toolkit Peng] operation journal failure",String(e)));
    this.queueState.tail=this.queue;
    return clone(op);
  }
  async cancelOperation(id:string):Promise<Json|null> {
    const op=await this.getOperation(id);if(!op||terminal.has(op.status))return op;
    const owned=this.operations.get(id)!;owned.cancelRequested=true;await this.record(owned);return clone(owned);
  }
  dispose():void{this.stopped=true;for(const op of this.operations.values())if(!terminal.has(op.status))op.cancelRequested=true;}
  private checkCancelled(op:Json):void{insist(!this.stopped&&!op.cancelRequested,"cancelled","Operation cancelled at a safe boundary");}
  private async assertExpected(request:Json):Promise<TFile|null> {
    const f=this.file(request.path);
    if(request.expectedHash===null){insist(!f,"conflict","New target already exists");return null;}
    insist(typeof request.expectedHash==="string"&&f,"conflict","Expected existing target and its hash");
    const disk=await this.app.vault.read(f);
    insist(await hash(disk)===request.expectedHash,"conflict","File changed after planning");
    insist(!this.dirtyMarkdown(request.path,disk),"conflict","Open editor has unsaved changes");return f;
  }
  private async open(path:string):Promise<any> {
    let l=this.leaf(path);if(l)return l;
    const f=this.file(path);insist(f,"missing","Canvas missing");l=this.app.workspace.getLeaf("tab");await l.openFile(f);
    // A freshly created Canvas hydrates its node map asynchronously; wait for it so
    // immediate geometry work does not race an empty view.
    const expected=JSON.parse(await this.app.vault.read(f)).nodes.length;
    for(let i=0;i<40;i++){
      const view=l.view,canvas=view?.canvas;
      if(view?.file&&typeof canvas?.requestSave==="function"&&canvas.nodes?.size===expected)return l;
      await sleep(50);
    }
    throw new BridgeError("runtime","Canvas view did not become ready");
  }
  private async saved(leaf:any):Promise<string> {
    insist(typeof leaf.view.save==="function","unsupported","Canvas save interface unavailable");
    insist(typeof leaf.view.canvas?.requestSave==="function","unsupported","Canvas save synchronization unavailable");
    // Current Obsidian replaces the Canvas view instance when it saves, leaving
    // leaf.view.file null for a moment; keep the TFile handle captured up front.
    const binding=leaf.view.file;
    leaf.view.canvas.requestSave();
    for(let i=0;i<40;i++){
      if(canonical(JSON.parse(leaf.view.getViewData()))===canonical(leaf.view.canvas.getData())) { await leaf.view.save(); break; }
      await sleep(50);
    }
    for(let i=0;i<40;i++){
      const target=leaf.view.file??binding;
      if(target){
        const disk=await this.app.vault.read(target);
        if(canonical(JSON.parse(disk))===canonical(leaf.view.canvas.getData()))return disk;
      }
      await sleep(50);
    }
    throw new BridgeError("persistence","Canvas runtime and saved file did not converge");
  }
  private async execute(request:Json,op:Json):Promise<Json> {
    const f=await this.assertExpected(request);this.checkCancelled(op);
    if(request.kind==="recover-trash"){
      insist(f,"missing","Recovery target missing");
      const leaf=request.path.endsWith(".canvas")?this.leaf(request.path):null;
      const runtime=leaf?canonical(leaf.view.canvas.getData()):null;
      if(leaf)insist(!leaf.view.dirty&&request.runtimeHash===await hash(canonical(leaf.view.canvas.getData())),"conflict","Recovery canvas changed");
      const disk=await this.app.vault.read(f);
      insist(await hash(disk)===request.expectedHash,"conflict","Recovery target changed");
      insist(!this.dirtyMarkdown(request.path,disk)&&(!leaf||!leaf.view.dirty&&canonical(leaf.view.canvas.getData())===runtime),"conflict","Recovery runtime changed");
      await this.app.vault.trash(f,true);op.mutated=true;
      insist(!this.file(request.path),"persistence","Recovery target reappeared");return {trashed:true};
    }
    if(request.kind==="write"||request.kind==="restore"){
      insist(typeof request.content==="string","invalid","Content is required");
      insist(!f||!request.path.endsWith(".canvas")||request.kind==="restore","scope","Existing Canvas accepts geometry patches only");
      const previous=f?await this.app.vault.read(f):"";
      if(f) insist(await hash(previous)===request.expectedHash,"conflict","File changed before validation");
      const validation=await this.validateDocument({...request,previousContent:previous});
      insist(validation.ok,"invalid",JSON.stringify(validation.issues));
      if(!f){const folder=request.path.split("/").slice(0,-1).join("/");if(folder)await this.mkdir(folder);this.checkCancelled(op);await this.app.vault.create(request.path,request.content);}
      else {
        const leaf=request.path.endsWith(".canvas")?this.leaf(request.path):null;
        const runtime=leaf?canonical(leaf.view.canvas.getData()):null;
        if(leaf){insist(request.runtimeHash===await hash(canonical(leaf.view.canvas.getData())),"conflict","Canvas runtime changed");insist(!leaf.view.dirty,"conflict","Canvas has pending edits");}
        await this.app.vault.process(f,data=>{
          insist(data===previous,"conflict","File changed during update");
          insist(!this.dirtyMarkdown(request.path,data)&&(!leaf||!leaf.view.dirty&&canonical(leaf.view.canvas.getData())===runtime),"conflict","Editor changed during validation");
          return request.content;
        });
        if(leaf){await leaf.view.setViewData(request.content,false);await this.saved(leaf);}
      }
      op.mutated=true;
      if(request.path.endsWith(".canvas")&&request.openCanvas===true){
        const leaf=await this.open(request.path);
        insist(preserves(JSON.parse(request.content),leaf.view.canvas.getData()),"unsupported","Native Canvas dropped document fields");
        await this.saved(leaf);
      }
      const actual=await this.app.vault.read(this.file(request.path)!);
      insist(request.path.endsWith(".canvas") ? preserves(JSON.parse(request.content),JSON.parse(actual)) : actual===request.content,"persistence","Saved content differs");
      return {hash:await hash(actual),validation,sourceAutomationPaused:request.path.endsWith(".canvas")};
    }
    insist(f&&request.path.endsWith(".canvas"),"invalid","Canvas target required");
    const leaf=request.kind==="canvas-fit"?await this.open(request.path):this.leaf(request.path,request.leafId);
    insist(leaf,"scope","Open the exact target canvas before applying geometry");
    const c=leaf.view.canvas;
    if(request.kind==="canvas-fit"){
      insist(request.path.startsWith("_AgentWorkspace/obsidian-manager-peng/")&&request.staging===true,"scope","Measure only a task-owned staging canvas");
      insist(preserves(JSON.parse(await this.app.vault.read(f)),c.getData()),"unsupported","Staging runtime dropped fields or changed node order; target was not published");
      const ids:string[]=request.nodeIds;insist(Array.isArray(ids)&&ids.length&&new Set(ids).size===ids.length,"scope","Explicit draft node IDs required");
      const diagnostics:Json[]=[];
      for(const id of ids){
        this.checkCancelled(op);
        // Resizing can trigger a debounced save, which swaps the Canvas view and
        // clears the previous node map; always re-resolve against the live view.
        // Embeds may also still be settling, so retry an unresolved measurement.
        let node=this.node(leaf,id), measured:Json|null=null;
        for(let attempt=0;attempt<12;attempt++){
          if(!node){node=this.node(leaf,id);if(!node){await sleep(80);continue;}}
          measured=await this.resize.fitNodesToContent([node]);op.mutated=true;
          if(!measured.unresolved&&!measured.skipped)break;
          await sleep(120);node=this.node(leaf,id);
        }
        insist(node&&measured,"scope","Unknown draft content node");
        diagnostics.push({id,...measured});
      }
      this.checkCancelled(op);await this.saved(leaf);
      return {data:clone(leaf.view.canvas.getData()),diagnostics,partial:diagnostics.some(d=>d.unresolved||d.skipped),hash:await hash(await this.app.vault.read(f))};
    }
    const snapshot=this.snapshots.get(request.snapshotId);
    insist(snapshot&&snapshot.path===request.path&&snapshot.leafId===leaf.id,"conflict","Snapshot is missing or belongs to another view");
    insist(snapshot.expectedHash===request.expectedHash&&snapshot.runtimeHash===await hash(canonical(c.getData())),"conflict","Canvas changed after selection capture");
    insist(!leaf.view.dirty,"conflict","Canvas has pending edits");
    insist(preserves(snapshot.diskData,snapshot.runtimeData),"unsupported","Canvas runtime cannot preserve existing serialized fields");
    const allowed=[...snapshot.nodeIds];
    if(request.resizeGroup===true){
      if(snapshot.groupId)allowed.push(snapshot.groupId);
      else if(snapshot.scope==="all")allowed.push(...snapshot.runtimeData.nodes.filter((n:Json)=>n.type==="group").map((n:Json)=>n.id));
    }
    const fields=request.fields??["x","y","width","height"];
    const expected=patchedCanvas(c.getData(),request.patch,allowed,fields);
    const targets=request.patch.map((p:Json)=>({node:c.nodes.get(p.id),p}));
    insist(targets.every((t:Json)=>typeof t.node?.moveAndResize==="function"),"unsupported","Node geometry interface unavailable");
    insist(await hash(await this.app.vault.read(f))===request.expectedHash,"conflict","Disk changed before geometry commit");
    insist(canonical(c.getData())===canonical(snapshot.runtimeData),"conflict","Runtime changed before geometry commit");
    // No await between the final revision check and the synchronous geometry commit.
    for(const {node,p} of targets){const d=node.getData();node.moveAndResize({x:d.x,y:d.y,width:d.width,height:d.height,...p.changes});}
    op.mutated=targets.length>0;
    const actual=await this.saved(leaf);
    insist(canonical(JSON.parse(actual))===canonical(expected),"persistence","Unexpected fields changed during save; inspect before recovery");
    return {hash:await hash(actual),runtimeHash:await hash(canonical(c.getData())),changedIds:request.patch.map((p:Json)=>p.id),data:JSON.parse(actual)};
  }
}
