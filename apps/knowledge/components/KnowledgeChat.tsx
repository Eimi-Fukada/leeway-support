"use client";
import { useEffect,useRef,useState } from "react";

interface Citation {id:string;kind:"knowledge"|"web";title:string;url?:string;evidence?:{text:string;documentId:string;headingPath:string[]}}
interface Message {id:string;role:string;content:string;citations?:Citation[]}
function answerContent(message:Message){
 return message.content.split(/(\[K:[^\]]+\]|\*\*[^*]+\*\*|\[[^\[\]]+\]\(https?:\/\/[^\s)]+\))/g).map((part,index)=>{
  if(part.startsWith("[K:")){const citation=message.citations?.findIndex(c=>`[${c.id}]`===part)??-1;return citation>=0?<a key={index} href={`#citation-${message.id}-${citation}`}>[来源 {citation+1}]</a>:null;}
  if(part.startsWith("**")&&part.endsWith("**"))return <strong key={index}>{part.slice(2,-2)}</strong>;
  const link=part.match(/^\[([^\[\]]+)\]\((https?:\/\/[^\s)]+)\)$/);if(link)return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
  return part;
 });
}
interface Form {formId:string;formVersion:1;interruptId?:string;spec:{title:string;description:string;fields:{key:string;label:string;type:string;required:boolean;options?:{value:string;label:string}[]}[]}}
export function KnowledgeChat({baseId,name}:{baseId:string;name:string}){
 const [thread,setThread]=useState(""),[draft,setDraft]=useState(""),[messages,setMessages]=useState<Message[]>([]),[status,setStatus]=useState("loading"),[notice,setNotice]=useState(""),
  [web,setWeb]=useState(false),[thinking,setThinking]=useState<"quick"|"deep">("quick"),[form,setForm]=useState<Form>(),[answers,setAnswers]=useState<Record<string,string>>({});
 const abort=useRef<AbortController|null>(null),generation=useRef(0),endpoint=`/api/knowledge-bases/${baseId}/chat`;
 const active=status==="running",canSend=["empty","completed"].includes(status);
 async function restore(id:string){
  const current=++generation.current;
  try{const response=await fetch(`${endpoint}?thread=${encodeURIComponent(id)}`,{cache:"no-store"});const data=await response.json();if(!response.ok)throw new Error(data.error??"读取会话失败");
   if(current!==generation.current)return;
   const items:Message[]=data.snapshot.messages;for(const row of data.results??[]){const message=items.find(m=>m.id===`assistant-${row.request_id}`);if(message)message.citations=row.result?.details?.citations??[];}
   setMessages(items);setStatus(data.snapshot.status);setForm(data.snapshot.information);setNotice(data.snapshot.notice??"");
  }catch(error){if(current===generation.current){setStatus("unknown");setNotice(error instanceof Error?error.message:"无法确认会话状态");}}
 }
 useEffect(()=>{const key=`knowledge-chat:${baseId}`,id=localStorage.getItem(key)??crypto.randomUUID();localStorage.setItem(key,id);setThread(id);void restore(id);return()=>{generation.current++;abort.current?.abort();};},[baseId]);
 function fresh(){generation.current++;abort.current?.abort();const id=crypto.randomUUID();localStorage.setItem(`knowledge-chat:${baseId}`,id);setThread(id);setMessages([]);setForm(undefined);setStatus("empty");setNotice("");}
 async function send(cancelled?:boolean){
  if(active||(!form&&(!canSend||!draft.trim())))return;
  const current=++generation.current;
  const requestId=crypto.randomUUID(),message=form?"提交补充信息":draft.trim(),controller=new AbortController();abort.current=controller;
  const submission=form?{formId:form.formId,formVersion:form.formVersion,interruptId:form.interruptId,submissionId:requestId,cancelled:!!cancelled,answers:cancelled?{}:answers}:undefined;
  setMessages(previous=>[...previous,{id:requestId,role:"user",content:message},{id:`assistant-${requestId}`,role:"assistant",content:""}]);setDraft("");setStatus("running");setNotice("");
  try{
   const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({threadId:thread,requestId,message,options:{webSearch:web,thinkingMode:thinking},...(submission?{submission}:{})}),signal:controller.signal});
   if(!response.ok){const data=await response.json();throw new Error(data.error??"请求失败");}if(!response.body)throw new Error("响应为空");
   const reader=response.body.getReader(),decoder=new TextDecoder();let buffer="",finished=false;
   try{for(;;){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let boundary;
    while((boundary=buffer.indexOf("\n\n"))>=0){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const line=frame.split("\n").find(l=>l.startsWith("data: "));if(!line)continue;const event=JSON.parse(line.slice(6));
     if(current!==generation.current)continue;
     if(event.type==="TEXT_MESSAGE_CONTENT")setMessages(previous=>previous.map(m=>m.id===event.messageId?{...m,content:m.content+event.delta}:m));
     if(event.type==="RUN_ERROR")throw new Error(event.message);
     if(event.type==="CUSTOM"&&event.name==="support.retrieval")setNotice(event.value.status==="started"?"正在查询知识库…":"已完成知识检索。");
     if(event.type==="CUSTOM"&&event.name==="support.web_search")setNotice("已完成联网搜索，正在整理来源。");
     if(event.type==="CUSTOM"&&event.name==="support.result"){finished=true;setStatus(event.value.status);setForm(event.value.information);setAnswers({});setMessages(previous=>previous.map(m=>m.id===`assistant-${requestId}`?{...m,content:event.value.answer,citations:event.value.details?.citations??[]}:m));}
    }
   }}finally{reader.releaseLock();}
   if(!finished)throw new Error("连接中断，结果未确认，请读取状态。");
  }catch(error){if(current===generation.current){setStatus("unknown");setNotice(error instanceof Error?error.message:"执行已停止，请核对状态。");}}
 }
 return <section className="qa-panel" aria-label="库内问答">
  <header className="qa-toolbar"><strong>{name}</strong><div><button type="button" disabled={active} onClick={fresh}>新会话</button><button type="button" disabled={active} onClick={()=>restore(thread)}>读取历史 / 核对状态</button></div></header>
  <div className="knowledge-messages" aria-live="polite">{!messages.length&&<p>可以询问当前资料，也可以聊天。开启联网后可查询公开信息。</p>}{messages.map(m=><article key={m.id} className={`knowledge-message ${m.role}`}><strong>{m.role==="user"?"你":"助手"}</strong><div className="knowledge-answer">{answerContent(m)}</div>{m.citations?.map((c,citationIndex)=>c.kind==="web"&&c.url&&/^https?:\/\//.test(c.url)?<p key={c.id}><a href={c.url} target="_blank" rel="noreferrer">网页来源：{c.title}</a></p>:<details key={c.id} id={`citation-${m.id}-${citationIndex}`}><summary>知识来源：{c.title}</summary><p>{c.evidence?.headingPath.join(" / ")}</p><pre>{c.evidence?.text}</pre>{c.evidence&&<a href={`/api/knowledge-bases/${baseId}/documents/${c.evidence.documentId}/original`} target="_blank" rel="noreferrer">查看原文件</a>}</details>)}</article>)}</div>
  {form&&<form className="knowledge-information" onSubmit={event=>{event.preventDefault();void send();}}><h3>{form.spec.title}</h3><p>{form.spec.description}</p>{form.spec.fields.map(field=><label key={field.key}>{field.label}{field.type==="select"?<select required={field.required} value={answers[field.key]??""} onChange={event=>setAnswers({...answers,[field.key]:event.target.value})}><option value="">请选择</option>{field.options?.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select>:<textarea required={field.required} maxLength={field.type==="text"?500:2000} value={answers[field.key]??""} onChange={event=>setAnswers({...answers,[field.key]:event.target.value})}/>}</label>)}<button disabled={active}>提交资料</button><button type="button" disabled={active} onClick={()=>send(true)}>取消填写</button></form>}
  <div className="qa-composer-area"><div className="qa-composer"><textarea aria-label="输入问题" value={draft} onChange={event=>setDraft(event.target.value)} maxLength={12000} disabled={!canSend} placeholder="输入问题…" rows={3}/><div className="qa-composer-bottom"><label><input type="checkbox" checked={web} disabled={active||!!form} onChange={event=>setWeb(event.target.checked)}/> 联网搜索</label><select aria-label="思考模式" value={thinking} disabled={active||!!form} onChange={event=>setThinking(event.target.value as "quick"|"deep")}><option value="quick">快速</option><option value="deep">深度思考</option></select>{active?<button onClick={()=>abort.current?.abort()}>停止</button>:<button disabled={!canSend||!draft.trim()} onClick={()=>send()}>发送</button>}</div></div>{notice&&<p role="alert">{notice}</p>}<p className="qa-disclaimer">{status==="running"?"正在执行，答案尚未确认完成":status==="unknown"?"结果待核对；不会自动重发":status==="waiting_for_input"?"等待补充资料":"回答请结合引用来源核实"}</p></div>
 </section>;
}
