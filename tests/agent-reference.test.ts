import {test} from "node:test";
import assert from "node:assert/strict";
import {headingCandidates} from "../src/agent-reference";
const h=(heading:string,level:number,line:number)=>({heading,level,position:{start:{line}}});
test("duplicate names require context; repeated siblings stay ambiguous",()=>{
 const headings=[h("Observe",1,0),h("P.S.",2,2),h("Compare",1,4),h("P.S.",2,6),h("Summary",1,8),h("Clause",2,10),h("Clause",2,12)];
 assert.equal(headingCandidates(headings,"#P.S.").length,2);
 assert.deepEqual(headingCandidates(headings,"#Compare#P.S."),[{line:6,path:["Compare","P.S."]}]);
 assert.equal(headingCandidates(headings,"#Summary#Clause").length,2);
 assert.equal(headingCandidates(headings,"#Summary").length,1);
});
test("heading paths retain Unicode, punctuation and formatted link names",()=>{
 assert.equal(headingCandidates([h("主题 😀",1,0),h("[P.S.](marginnote4app://note/id)",2,2)],"#主题 😀#P.S.").length,1);
 assert.equal(headingCandidates([h("Topic",1,0)],"#Missing").length,0);
});
