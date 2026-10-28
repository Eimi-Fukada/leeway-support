import { createModel } from "../src/config/model.ts";
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,init)=>{
 if(typeof init?.body==="string"){
  const body=JSON.parse(init.body);
  console.log(JSON.stringify({request:{model:body.model,reasoning:body.reasoning,toolTypes:body.tools?.map((tool:{type:string})=>tool.type)}}));
 }
 return originalFetch(url,init);
};
for(const effort of ["low","high"] as const){
 const model=createModel({effort,webSearch:false});const start=Date.now();
 const result=await model.invoke("仅回答 17 乘以 23 的结果。",{signal:AbortSignal.timeout(65000)});
 console.log(JSON.stringify({effort,answer:result.text,elapsedMs:Date.now()-start,usage:result.usage_metadata,responseId:result.response_metadata.id}));
}
const model=createModel({effort:"low",webSearch:true});
const result=await model.bindTools([{type:"web_search"}]).invoke("请联网查看 OpenAI 官方网站最近发布的模型更新，列出一条及日期，并提供官方来源链接。必须实际搜索，不能仅使用训练知识。",{signal:AbortSignal.timeout(65000)});
console.log(JSON.stringify({web:true,answer:result.text,content:result.content,toolOutputs:result.additional_kwargs.tool_outputs,usage:result.usage_metadata,responseId:result.response_metadata.id}));
