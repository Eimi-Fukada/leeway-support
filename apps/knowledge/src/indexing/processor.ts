import { randomUUID } from "node:crypto";
import type pg from "pg";
import { validateVectors,type EmbeddingProfile } from "../embeddings/client.ts";
import { QdrantStore,QdrantError,hash,type VectorPoint,type IndexTarget,type IndexReceipt } from "./qdrant.ts";
import { AppError } from "../contracts.ts";

interface IndexRun {id:string;knowledge_base_id:string;name:string;sha256:string;embedding_profile:EmbeddingProfile;processing_run_id:string;index_target:IndexTarget|null}
interface Chunk {id:string;text:string;ordinal:number;heading_path:string[];section_index:number;start_offset:number;end_offset:number;content_sha256:string;embedding:number[]}
export class IndexProcessor {
  constructor(private readonly pool:pg.Pool,private readonly store:QdrantStore){}
  async recoverInterrupted(documentId?:string):Promise<void>{
    await this.pool.query(`UPDATE public.knowledge_documents SET processing_status='failed',processing_failed_stage='indexing',processing_error_code='result_unknown',
      processing_run_id=NULL,processing_lease_expires_at=NULL,processing_updated_at=now()
      WHERE processing_status='indexing' AND (processing_lease_expires_at<=now() OR processing_lease_expires_at IS NULL) AND ($1::uuid IS NULL OR id=$1)`,[documentId??null]);
  }
  async claim(documentId?:string,reconcileAttempt?:number):Promise<IndexRun|null>{
    const result=await this.pool.query<IndexRun>(`UPDATE public.knowledge_documents SET processing_status='indexing',processing_run_id=$1,
      processing_lease_expires_at=now()+interval '2 minutes',processing_attempt=processing_attempt+1,processing_failed_stage=NULL,processing_error_code=NULL,processing_updated_at=now()
      WHERE id=(SELECT id FROM public.knowledge_documents WHERE
        (($3::integer IS NULL AND processing_status='embedded') OR ($3::integer IS NOT NULL AND processing_status='failed' AND processing_failed_stage='indexing' AND processing_attempt=$3))
        AND ($2::uuid IS NULL OR id=$2) ORDER BY processing_updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id,knowledge_base_id,name,sha256,embedding_profile,processing_run_id,index_target`,[randomUUID(),documentId??null,reconcileAttempt??null]);
    return result.rows[0]??null;
  }
  private async heartbeat(run:IndexRun):Promise<boolean>{
    const result=await this.pool.query(`UPDATE public.knowledge_documents SET processing_lease_expires_at=now()+interval '2 minutes'
      WHERE id=$1 AND processing_run_id=$2 AND processing_status='indexing' AND processing_lease_expires_at>now()`,[run.id,run.processing_run_id]);return result.rowCount===1;
  }
  private async source(run:IndexRun):Promise<{target:IndexTarget;points:VectorPoint[]}>{
    const profile=run.embedding_profile;
    if(!profile||!Number.isInteger(profile.dimensions)||profile.dimensions<1||profile.dimensions>8192)throw new QdrantError(false,"文档缺少有效的嵌入配置。");
    const chunks=(await this.pool.query<Chunk>(`SELECT c.* FROM public.knowledge_document_chunks c
      JOIN public.knowledge_document_contents p ON p.document_id=c.document_id WHERE c.document_id=$1 AND p.source_sha256=$2 ORDER BY c.ordinal`,[run.id,run.sha256])).rows;
    if(!chunks.length||chunks.length>5000)throw new QdrantError(false,"文档片段尚未完整就绪。");
    if(chunks.some((chunk,index)=>chunk.ordinal!==index||hash(chunk.text)!==chunk.content_sha256))throw new QdrantError(false,"文档片段顺序或正文指纹不匹配。");
    validateVectors(chunks.map(chunk=>chunk.embedding),chunks.length,profile.dimensions);
    const manifestHash=hash(JSON.stringify(chunks.map(chunk=>[chunk.id,chunk.content_sha256,hash(JSON.stringify(chunk.embedding))])));
    const generationId=hash(JSON.stringify([run.id,run.sha256,profile.id,manifestHash]));
    const target={collection:this.store.collection(profile.id),endpointHash:this.store.endpointHash,profileId:profile.id,generationId,manifestHash};
    // JSONB 键顺序无保证，按字段逐一比对。
    if(run.index_target&&Object.entries(target).some(([key,value])=>run.index_target![key as keyof IndexTarget]!==value))throw new QdrantError(false,"已保存索引目标与当前配置或片段不符，请先核对部署配置。");
    const points=chunks.map(chunk=>({id:chunk.id,vector:chunk.embedding,payload:{
      knowledge_base_id:run.knowledge_base_id,document_id:run.id,document_name:run.name,source_sha256:run.sha256,
      embedding_profile_id:profile.id,embedding_model:profile.model,embedding_revision:profile.revision,generation_id:generationId,
      chunk_sha256:chunk.content_sha256,vector_sha256:hash(JSON.stringify(chunk.embedding)),ordinal:chunk.ordinal,
      text:chunk.text,heading_path:chunk.heading_path,section_index:chunk.section_index,start_offset:chunk.start_offset,end_offset:chunk.end_offset,
    }}));
    return {target,points};
  }
  private async finish(run:IndexRun,target:IndexTarget):Promise<boolean>{
    const receipt:IndexReceipt={...target,verifiedAt:new Date().toISOString()};
    const result=await this.pool.query(`UPDATE public.knowledge_documents SET processing_status='ready',index_receipt=$3,processing_run_id=NULL,
      processing_lease_expires_at=NULL,processing_updated_at=now() WHERE id=$1 AND processing_run_id=$2 AND processing_status='indexing'
      AND processing_lease_expires_at>now() AND sha256=$4 AND embedding_profile->>'id'=$5 AND index_target=$6::jsonb`,
      [run.id,run.processing_run_id,JSON.stringify(receipt),run.sha256,target.profileId,JSON.stringify(target)]);
    return result.rowCount===1;
  }
  private async execute(run:IndexRun,readOnly:boolean):Promise<void>{
    const abort=new AbortController();let busy=false,writeStarted=false;
    const heartbeat=setInterval(()=>{if(busy)return;busy=true;void this.heartbeat(run).then(owned=>{if(!owned)abort.abort();}).catch(()=>abort.abort()).finally(()=>{busy=false;});},10000);
    const deadline=setTimeout(()=>abort.abort(),600000);
    try{
      const {target,points}=await this.source(run);
      if(readOnly&&!run.index_target)throw new QdrantError(false,"没有可核对的索引目标。");
      const saved=await this.pool.query(`UPDATE public.knowledge_documents SET index_target=$3 WHERE id=$1 AND processing_run_id=$2
        AND processing_status='indexing' AND processing_lease_expires_at>now()`,[run.id,run.processing_run_id,JSON.stringify(target)]);
      if(!saved.rowCount)return;
      if(!readOnly)await this.store.ensureCollection(run.embedding_profile,abort.signal);
      for(let start=0;start<points.length;start+=this.store.config.batchSize){
        abort.signal.throwIfAborted();
        const batch=points.slice(start,start+this.store.config.batchSize);
        if(!readOnly){writeStarted=true;await this.store.upsert(target.collection,batch,abort.signal);}
        if(!await this.store.verify(target.collection,batch,run.embedding_profile.dimensions,abort.signal))throw new QdrantError(false,"本次文档的向量或来源未全部匹配。");
      }
      abort.signal.throwIfAborted();await this.finish(run,target);
    }catch(error){
      const unknown=readOnly ? !(error instanceof QdrantError&&!error.uncertain) : writeStarted&&(abort.signal.aborted||!(error instanceof QdrantError)||error.uncertain);
      await this.pool.query(`UPDATE public.knowledge_documents SET processing_status='failed',processing_failed_stage='indexing',processing_error_code=$3,
        processing_run_id=NULL,processing_lease_expires_at=NULL,processing_updated_at=now() WHERE id=$1 AND processing_run_id=$2 AND processing_status='indexing'`,
        [run.id,run.processing_run_id,unknown?"result_unknown":"index_failed"]);
    }finally{clearInterval(heartbeat);clearTimeout(deadline);}
  }
  async processNext(documentId?:string):Promise<boolean>{const run=await this.claim(documentId);if(!run)return false;await this.execute(run,false);return true;}
  async reconcile(documentId:string,attempt:number):Promise<void>{
    const run=await this.claim(documentId,attempt);if(!run)throw new AppError(409,"处理状态已变化，请刷新后核对。");
    await this.execute(run,true);
  }
}
