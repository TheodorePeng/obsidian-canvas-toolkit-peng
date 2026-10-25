import {test} from "node:test";
import assert from "node:assert/strict";
import {canonical,preserves,safePath,validateCanvas,resolveScope,patchedCanvas,baseDiagnostics} from "../src/agent-contract";
const card=(id:string,x=0,y=0)=>({id,type:"text",x,y,width:100,height:80,text:"hello",extension:{keep:true}});
const fixture=()=>({nodes:[{id:"g",type:"group",x:-20,y:-20,width:300,height:220},card("a"),card("b",400)],edges:[{id:"edge",fromNode:"a",toNode:"b",custom:"keep"}],plugin:{keep:true}});
test("canonical key ordering and nonfinite rejection",()=>{assert.equal(canonical({b:2,a:1}),canonical({a:1,b:2}));assert.throws(()=>canonical({a:NaN}));});
test("paths reject traversal and hidden config",()=>{for(const p of ["/x.md","../x.md",".obsidian/x.md","a/../x.md","a\\x.md"])assert.throws(()=>safePath(p));assert.equal(safePath("A B/a.md"),"A B/a.md");});
test("valid canvas and duplicate ID rejection",()=>{validateCanvas(fixture());const d=fixture();d.edges[0].id="a";assert.throws(()=>validateCanvas(d));});
test("geometry rejects boolean, zero and nonfinite sizes",()=>{for(const v of [true,0,Infinity]){const d:any=fixture();d.nodes[1].width=v;assert.throws(()=>validateCanvas(d));}});
test("explicit selection preserves original ordering",()=>{assert.deepEqual(resolveScope(fixture(),["b","a"],"selected"),["a","b"]);assert.throws(()=>resolveScope(fixture(),[],"selected"));assert.throws(()=>resolveScope(fixture(),["g"],"selected"));});
test("single group includes only contained content",()=>{assert.deepEqual(resolveScope(fixture(),["g"],"group"),["a"]);});
test("nested and crossing groups rejected",()=>{const d:any=fixture();d.nodes.push({id:"nested",type:"group",x:0,y:0,width:10,height:10});assert.throws(()=>resolveScope(d,["g"],"group"));const e:any=fixture();e.nodes[1].x=250;assert.throws(()=>resolveScope(e,["g"],"group"));});
test("patch changes only approved fields, preserves all extensions",()=>{const d=fixture();const a=patchedCanvas(d,[{id:"a",changes:{width:220}}],["a"],["width"]);assert.equal(a.nodes[1].width,220);assert.equal(d.nodes[1].width,100);assert.deepEqual(a.nodes[1].extension,{keep:true});assert.deepEqual(a.edges,d.edges);assert.deepEqual(a.plugin,d.plugin);});
test("unapproved IDs, fields and duplicate patch IDs rejected",()=>{const d=fixture();for(const patch of [[{id:"b",changes:{x:5}}],[{id:"a",changes:{text:"erase"}}],[{id:"a",changes:{x:1}},{id:"a",changes:{x:2}}]])assert.throws(()=>patchedCanvas(d,patch,["a"],["x"]));});

test("canonical follows JSON undefined semantics",()=>{assert.equal(canonical({a:1,b:undefined}),canonical({a:1}));assert.equal(canonical([undefined]),"[null]");});

test("runtime omission of extension fields fails preservation check",()=>{assert.equal(preserves({plugin:{x:1}},{plugin:{x:1,y:2}}),true);assert.equal(preserves({plugin:{x:1}},{}),false);assert.equal(preserves({nodes:[{id:"a"}]},{nodes:[{id:"b"}]}),false);});
test("native Base invalid AST is detected without treating null values as errors",()=>{
 const d:any={formulas:{bad:{text:"if(",formula:{type:"invalid",parseError:"Unable to parse"}},missing:{formula:{type:"literal",value:null}}}};d.cycle=d;
 assert.equal(baseDiagnostics(d).length,1);assert.equal(baseDiagnostics({value:null}).length,0);
});
