import { createHash } from "node:crypto";
import { validateVectors, type EmbeddingProfile } from "../embeddings/client.ts";

export interface QdrantConfig { baseUrl:string; apiKey?:string; collectionPrefix:string; timeoutMs:number; batchSize:number }
export interface VectorPoint { id:string; vector:number[]; payload:Record<string,unknown> }
export interface IndexTarget { collection:string; endpointHash:string; profileId:string; generationId:string; manifestHash:string }
export interface IndexReceipt extends IndexTarget { verifiedAt:string }
export const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
export class QdrantError extends Error {
  constructor(public readonly uncertain:boolean,message:string,public readonly status?:number){super(message);}
}
export function readQdrantConfig(env:Record<string,string|undefined>=process.env):QdrantConfig{
  const invalid=()=>new Error("Qdrant 配置无效，请检查 QDRANT_* 环境变量。");
  let url:URL;try{url=new URL(env.QDRANT_URL??"");}catch{throw invalid();}
  if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=="/")throw invalid();
  const collectionPrefix=env.QDRANT_COLLECTION_PREFIX?.trim()??"leeway_knowledge";
  if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(collectionPrefix))throw invalid();
  const timeoutMs=Number(env.QDRANT_TIMEOUT_MS??30000),batchSize=Number(env.QDRANT_BATCH_SIZE??32);
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000||!Number.isInteger(batchSize)||batchSize<1||batchSize>128)throw invalid();
  const apiKey=env.QDRANT_API_KEY?.trim()||undefined;if(apiKey&&/[\r\n]/.test(apiKey))throw invalid();
  return {baseUrl:url.origin,apiKey,collectionPrefix,timeoutMs,batchSize};
}
export class QdrantStore {
  readonly endpointHash:string;
  constructor(readonly config:QdrantConfig,private readonly transport:typeof fetch=fetch){this.endpointHash=hash(config.baseUrl);}
  collection(profileId:string):string{
    if(!/^[a-f0-9]{64}$/.test(profileId))throw new QdrantError(false,"嵌入配置标识无效。");
    return `${this.config.collectionPrefix}_${profileId}`;
  }
  private path(collection:string):string{
    if(!/^[a-zA-Z0-9_-]{1,200}$/.test(collection))throw new QdrantError(false,"向量集合名称无效。");
    return `/collections/${collection}`;
  }
  async request(method:string,path:string,body?:unknown,signal?:AbortSignal):Promise<any>{
    const abort=new AbortController();const combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
    const timer=setTimeout(()=>abort.abort(),this.config.timeoutMs);
    try{
      combined.throwIfAborted();
      const response=await this.transport(this.config.baseUrl+path,{method,redirect:"error",headers:{"Content-Type":"application/json",...(this.config.apiKey?{"api-key":this.config.apiKey}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:combined});
      if(!response.ok){await response.body?.cancel();throw new QdrantError(response.status>=500||response.status===408,`向量服务请求失败（HTTP ${response.status}）。`,response.status);}
      if(!response.body)throw new QdrantError(true,"向量服务未返回有效结果。");
      const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
      try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>16*1024*1024){await reader.cancel();throw new QdrantError(true,"向量响应超过限制。");}parts.push(item.value);}}finally{reader.releaseLock();}
      combined.throwIfAborted();const data=JSON.parse(Buffer.concat(parts).toString("utf8"));
      if(data.status!=="ok"||!("result" in data))throw new QdrantError(true,"向量服务响应未确认成功。");
      return data.result;
    }catch(error){if(error instanceof QdrantError)throw error;throw new QdrantError(true,"向量服务未响应或结果尚未确认。");}finally{clearTimeout(timer);}
  }
  async ensureCollection(profile:EmbeddingProfile,signal?:AbortSignal):Promise<string>{
    const collection=this.collection(profile.id),path=this.path(collection);
    let details;
    try{details=await this.request("GET",path,undefined,signal);}catch(error){
      if(!(error instanceof QdrantError)||error.status!==404)throw error;
      try{await this.request("PUT",path,{vectors:{size:profile.dimensions,distance:"Cosine"},on_disk_payload:true},signal);}
      catch(createError){if(!(createError instanceof QdrantError)||createError.status!==409)throw createError;}
      details=await this.request("GET",path,undefined,signal);
    }
    const vectors=details.config?.params?.vectors;
    if(vectors?.size!==profile.dimensions||vectors?.distance!=="Cosine")throw new QdrantError(false,"已有集合的向量维度或距离配置不匹配。");
    for(const field of ["knowledge_base_id","document_id","generation_id","embedding_profile_id"]){
      const result=await this.request("PUT",`${path}/index?wait=true`,{field_name:field,field_schema:"keyword"},signal);
      if(result.status!=="completed")throw new QdrantError(true,"过滤索引尚未确认完成。");
    }
    return collection;
  }
  async upsert(collection:string,points:VectorPoint[],signal?:AbortSignal):Promise<void>{
    const result=await this.request("PUT",`${this.path(collection)}/points?wait=true`,{points},signal);
    if(result.status!=="completed")throw new QdrantError(true,"向量写入仅被接收，尚未确认完成。");
  }
  async verify(collection:string,expected:VectorPoint[],dimensions:number,signal?:AbortSignal):Promise<boolean>{
    let result;
    try{result=await this.request("POST",`${this.path(collection)}/points`,{ids:expected.map(point=>point.id),with_payload:true,with_vector:true},signal);}
    catch(error){if(error instanceof QdrantError&&error.status===404)return false;throw error;}
    if(!Array.isArray(result))throw new QdrantError(true,"向量核对响应无效。");
    const found=new Map(result.map((point:any)=>[point.id,point]));
    if(found.size!==expected.length||result.length!==expected.length)return false;
    for(const point of expected){
      const actual:any=found.get(point.id);if(!actual)return false;
      for(const [key,value] of Object.entries(point.payload))if(JSON.stringify(actual.payload?.[key])!==JSON.stringify(value))return false;
      try{validateVectors([actual.vector],1,dimensions);}catch{return false;}
      const norm=Math.sqrt(point.vector.reduce((sum,value)=>sum+value*value,0));
      // Cosine collection 在上传时归一化；比较规范化数值而非原 JSON 字符串。
      if(actual.vector.some((value:number,index:number)=>Math.abs(value-point.vector[index]!/norm)>0.00002))return false;
    }
    return true;
  }
}
