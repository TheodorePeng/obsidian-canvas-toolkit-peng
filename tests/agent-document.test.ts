import {test} from "node:test";
import assert from "node:assert/strict";
import {Json} from "../src/agent-contract";
import {compareCanvas,flatCanvas,structureDelta,assertRestructure,assertSourceManifest} from "../src/agent-document";

const fixture=():Json=>({metadata:{tags:["keep","order"]},nodes:[
 {id:"g",type:"group",x:-50,y:-80,width:600,height:500,label:"Group"},
 {id:"a",type:"text",x:0,y:0,width:200,height:90,text:"人工批注",custom:{a:[2,1]}},
 {id:"b",type:"text",x:280,y:0,width:200,height:300,text:"Reference"}],edges:[{id:"e",fromNode:"a",toNode:"b",custom:"keep"}]});
test("only flat root arrays may reorder",()=>{
 const a=fixture(),b=structuredClone(a);b.nodes.reverse();assert.equal(compareCanvas(a,b),false);assert.equal(compareCanvas(a,b,"flat"),true);
 b.metadata.tags.reverse();assert.equal(compareCanvas(a,b,"flat"),false);
 b.metadata.tags.reverse();b.nodes.find((n:Json)=>n.id==="a").custom.a.reverse();assert.equal(compareCanvas(a,b,"flat"),false);
});
test("runtime loss, extra fields and overlap fail comparison",()=>{
 for(const mutate of [(d:Json)=>delete d.nodes[1].custom,(d:Json)=>d.nodes[1].extra=1,(d:Json)=>d.nodes[2].x=10]){
  const a=fixture(),b=structuredClone(a);mutate(b);assert.equal(compareCanvas(a,b,"flat"),false);
 }
 const a=fixture();a.nodes[2].x=10;assert.equal(flatCanvas(a),false);assert.equal(compareCanvas(a,a,"flat"),false);
});
test("text updates, removal and stale delta are separately constrained",()=>{
 const a=fixture(),b=structuredClone(a);b.nodes[1].text="Navigation";const delta=structureDelta(a,b);
 assert.deepEqual(delta.nodes.updated,[{id:"a",fields:["text"]}]);assert.throws(()=>assertRestructure(a,b,{delta}));
 assertRestructure(a,b,{delta,textChanges:{a:"User requested rewrite"}});
 const c=fixture();c.nodes.pop();c.edges=[];const d=structureDelta(a,c);
 assert.throws(()=>assertRestructure(a,c,{delta:d}));assertRestructure(a,c,{delta:d,removeNodes:{b:"Approved duplicate"},removeEdges:{e:"Incident edge"}});
 assert.throws(()=>assertRestructure(a,b,{delta:structureDelta(a,a),textChanges:{a:"User requested rewrite"}}));
});
test("unknown fields, types and root metadata cannot be approved away",()=>{
 for(const mutate of [(d:Json)=>d.metadata.tags.reverse(),(d:Json)=>d.nodes[1].custom.a.reverse(),(d:Json)=>d.nodes[1].type="link"]){
  const a=fixture(),b=structuredClone(a);mutate(b);assert.throws(()=>assertRestructure(a,b,{delta:structureDelta(a,b)}));
 }
});
test("source manifests must cover every discovered source and embed",()=>{
 const actual={"A.md":"hash-a","image.svg":"hash-image"};
 for(const expected of [undefined,{}, {"A.md":"hash-a"},{...actual,"A.md":"later"}])assert.throws(()=>assertSourceManifest(actual,expected));
 assertSourceManifest(actual,{"image.svg":"hash-image","A.md":"hash-a"});assertSourceManifest({},{});
});
