import assert from "node:assert/strict";
import { randomBytes,randomUUID,createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/database.ts";
process.loadEnvFile(fileURLToPath(new URL("../.env",import.meta.url)));
const pool=createPool(),token=randomBytes(32).toString("hex"),digest=createHash("sha256").update(token).digest("hex"),baseId="353b8542-32a0-4247-a5d4-4b367b5cc19d",threadId=`eval-cancel-${randomUUID()}`;
try{
 const user=(await pool.query("SELECT owner_id FROM public.knowledge_bases WHERE id=$1",[baseId])).rows[0].owner_id;
 await pool.query("INSERT INTO public.knowledge_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '5 minutes')",[digest,user]);
 const endpoint=`http://127.0.0.1:3200/api/knowledge-bases/${baseId}/chat`,headers={"Content-Type":"application/json",Origin:"http://127.0.0.1:3200",Cookie:`leeway_knowledge_session=${token}`},abort=new AbortController();
 const response=await fetch(endpoint,{method:"POST",headers,body:JSON.stringify({threadId,requestId:randomUUID(),message:"不要查询知识库。请创作一篇三千字的虚构旅行故事，从第一段开始连续写作。",options:{webSearch:false,thinkingMode:"quick"}}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(65000)])});
 assert.equal(response.status,200);const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer="",receivedText=false;
 try{while(!receivedText){const item=await reader.read();if(item.done)break;buffer+=decoder.decode(item.value,{stream:true});receivedText=buffer.includes('"type":"TEXT_MESSAGE_CONTENT"');}}finally{abort.abort();await reader.cancel().catch(()=>{});reader.releaseLock();}
 assert.ok(receivedText,"在实际收到模型文本后才中断");
 let snapshot;
 for(let attempt=0;attempt<20;attempt++){
  const status=await fetch(`${endpoint}?thread=${threadId}`,{headers});assert.equal(status.status,200);snapshot=(await status.json()).snapshot;
  if(snapshot.status!=="running")break;await new Promise(resolve=>setTimeout(resolve,250));
 }
 assert.ok(["failed","unknown"].includes(snapshot.status),`取消后的状态不应是成功：${snapshot.status}`);
 assert.equal(snapshot.messages.filter((m:{role:string})=>m.role==="assistant").length,0);
 console.log(JSON.stringify({threadId,receivedText,cancelledStatus:snapshot.status,assistantHistoryCount:0}));
}finally{await pool.query("DELETE FROM public.knowledge_sessions WHERE token_hash=$1",[digest]);await pool.end();}
