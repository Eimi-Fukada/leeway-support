import { randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../contracts.ts";
import type { EmbeddingClient, EmbeddingProfile } from "../embeddings/client.ts";
import { QdrantStore, hash, type IndexReceipt } from "../indexing/qdrant.ts";
import { retrievalInput, type Evidence, type RetrievalResult } from "./contracts.ts";

interface Source { id:string; name:string; sha256:string; embedding_profile:EmbeddingProfile; index_receipt:IndexReceipt; index_target:IndexReceipt }
interface Candidate { id:string; score:number; payload:Record<string,unknown> }
interface Chunk { id:string; document_id:string; text:string; content_sha256:string; heading_path:string[]; section_index:number; start_offset:number; end_offset:number }

export class RetrievalService {
  constructor(private readonly pool:pg.Pool, private readonly embedding:EmbeddingClient, private readonly store:QdrantStore) {}
  private async sources(userId:string, baseId:string):Promise<Source[]> {
    const owned=await this.pool.query("SELECT id FROM public.knowledge_bases WHERE id=$1 AND owner_id=$2",[baseId,userId]);
    if(!owned.rowCount)throw new AppError(404,"知识库不存在或无权访问。");
    const result=await this.pool.query<Source>(`SELECT id,name,sha256,embedding_profile,index_receipt,index_target FROM public.knowledge_documents
      WHERE knowledge_base_id=$1 AND processing_status='ready' ORDER BY id LIMIT 201`,[baseId]);
    if(result.rows.length>200)throw new AppError(409,"可检索文档超过当前范围上限。");
    return result.rows;
  }
  private revision(sources:Source[]) {return hash(JSON.stringify(sources.map(s=>[s.id,s.sha256,s.index_receipt,s.embedding_profile])));}
  async scope(userId:string,baseId:string){return this.revision(await this.sources(userId,baseId));}
  async search(userId:string,baseId:string,input:unknown,signal?:AbortSignal):Promise<RetrievalResult> {
    const parsed=retrievalInput.safeParse(input);
    if(!parsed.success)throw new AppError(400,"问题须为 1 到 4000 字符，且不能包含额外参数。");
    if(!/^[a-f0-9-]{36}$/i.test(baseId))throw new AppError(404,"知识库不存在或无权访问。");
    const abort=AbortSignal.timeout(45000), combined=signal?AbortSignal.any([abort,signal]):abort;
    const started=Date.now(), retrievalId=randomUUID(), sources=await this.sources(userId,baseId), revision=this.revision(sources);
    const result:RetrievalResult={retrievalId,status:"no_ready_documents",evidence:[],budgetLimited:false,scopeRevision:revision};
    let candidates:Candidate[]=[];
    try {
    if(sources.length){
      for(const s of sources){
        const receipt=s.index_receipt;
        if(!receipt||!s.index_target||s.embedding_profile?.id!==this.embedding.profile.id||receipt.profileId!==this.embedding.profile.id
          ||receipt.endpointHash!==this.store.endpointHash||receipt.collection!==this.store.collection(this.embedding.profile.id)
          ||["collection","endpointHash","profileId","generationId","manifestHash"].some(k=>receipt[k as keyof IndexReceipt]!==s.index_target[k as keyof IndexReceipt]))
          throw new AppError(409,"文档索引与当前嵌入配置不匹配，请先核对索引。");
      }
      const vector=await this.embedding.embedQuery(parsed.data.question,combined);
      const filter={must:[{key:"knowledge_base_id",match:{value:baseId}},{key:"embedding_profile_id",match:{value:this.embedding.profile.id}},
        {should:sources.map(s=>({must:[{key:"document_id",match:{value:s.id}},{key:"generation_id",match:{value:s.index_receipt.generationId}}]}))}]};
      const seen=new Set<string>(); let characters=0;
      for(const limit of [10,20]){
        const response=await this.store.request("POST",`/collections/${this.store.collection(this.embedding.profile.id)}/points/query`,
          {query:vector,filter,limit,with_payload:true,with_vector:false},combined);
        if(!Array.isArray(response.points))throw new AppError(503,"检索响应格式无效。");
        candidates=response.points;
        if(candidates.some(p=>typeof p.id!=="string"||!Number.isFinite(p.score)||!p.payload))throw new AppError(503,"检索候选格式无效。");
        const chunks=await this.pool.query<Chunk>("SELECT * FROM public.knowledge_document_chunks WHERE id=ANY($1::uuid[])",[candidates.map(p=>p.id)]);
        const byId=new Map(chunks.rows.map(c=>[c.id,c]));
        for(const point of [...candidates].sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id))){
          if(seen.has(point.id))continue;seen.add(point.id);
          const chunk=byId.get(point.id), source=sources.find(s=>s.id===chunk?.document_id);
          if(!chunk||!source||point.payload.document_id!==source.id||point.payload.knowledge_base_id!==baseId
            ||point.payload.generation_id!==source.index_receipt.generationId||point.payload.source_sha256!==source.sha256
            ||point.payload.embedding_profile_id!==this.embedding.profile.id||point.payload.chunk_sha256!==chunk.content_sha256
            ||hash(chunk.text)!==chunk.content_sha256||point.payload.text!==chunk.text)throw new AppError(409,"索引来源与正文不一致，请核对后再试。");
          if(result.evidence.some(e=>e.contentSha256===chunk.content_sha256))continue;
          if(result.evidence.length>=6||characters+chunk.text.length>12000){result.budgetLimited=true;continue;}
          characters+=chunk.text.length;
          result.evidence.push({evidenceId:hash(`${retrievalId}:${chunk.id}`),knowledgeBaseId:baseId,documentId:source.id,documentName:source.name,
            chunkId:chunk.id,sourceSha256:source.sha256,generationId:source.index_receipt.generationId,embeddingProfileId:this.embedding.profile.id,
            headingPath:chunk.heading_path,sectionIndex:chunk.section_index,startOffset:chunk.start_offset,endOffset:chunk.end_offset,
            text:chunk.text,contentSha256:chunk.content_sha256,score:point.score});
        }
        if(result.evidence.length>=6||candidates.length<limit)break;
      }
      result.status=result.evidence.length?"ok":"no_match";
      if(!result.evidence.length&&result.budgetLimited)throw new AppError(409,"证据超过当前上下文预算。");
      if(this.revision(await this.sources(userId,baseId))!==revision)throw new AppError(409,"知识范围已变化，请重新查询。");
    }
    combined.throwIfAborted();
    await this.pool.query(`INSERT INTO public.knowledge_retrievals(id,user_id,knowledge_base_id,query,scope_revision,profile_id,status,candidates,evidence,elapsed_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[retrievalId,userId,baseId,parsed.data.question,revision,this.embedding.profile.id,result.status,
      JSON.stringify(candidates.map(p=>({id:p.id,score:p.score}))),JSON.stringify(result.evidence),Date.now()-started]);
    return result;
    } catch(error) {
      const failure=abort.aborted&&!signal?.aborted?new AppError(504,"知识检索超时，请稍后重试。"):error;
      await this.pool.query(`INSERT INTO public.knowledge_retrievals(id,user_id,knowledge_base_id,query,scope_revision,profile_id,status,candidates,evidence,elapsed_ms,error_code)
        VALUES($1,$2,$3,$4,$5,$6,'failed',$7,$8,$9,$10) ON CONFLICT DO NOTHING`,[retrievalId,userId,baseId,parsed.data.question,revision,this.embedding.profile.id,
        JSON.stringify(candidates.map(p=>({id:p.id,score:p.score}))),JSON.stringify(result.evidence),Date.now()-started,failure instanceof AppError?`http_${failure.status}`:"dependency_failure"])
        .catch(()=>console.error("[知识检索] 失败审计未保存。"));
      throw failure;
    }
  }
}
