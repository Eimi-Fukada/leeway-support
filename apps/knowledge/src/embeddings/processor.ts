import { randomUUID } from "node:crypto";
import type pg from "pg";
import { validateVectors, type EmbeddingClient } from "./client.ts";

interface EmbeddingRun { id:string; processing_run_id:string; sha256:string }
interface SourceChunk { id:string; text:string }
export class EmbeddingProcessor {
  constructor(private readonly pool:pg.Pool,private readonly client:EmbeddingClient,private readonly timeoutMs=1_800_000) {}
  async recoverInterrupted(documentId?:string):Promise<void>{
    await this.pool.query(`UPDATE public.knowledge_documents SET processing_status='failed',processing_failed_stage='embedding',
      processing_error_code='interrupted',processing_run_id=NULL,processing_lease_expires_at=NULL,processing_updated_at=now()
      WHERE processing_status='embedding' AND (processing_lease_expires_at<=now() OR processing_lease_expires_at IS NULL)
        AND ($1::uuid IS NULL OR id=$1)`,[documentId??null]);
  }
  async claim(documentId?:string):Promise<EmbeddingRun|null>{
    const result=await this.pool.query<EmbeddingRun>(`UPDATE public.knowledge_documents SET processing_status='embedding',
      processing_run_id=$1,processing_lease_expires_at=now()+interval '2 minutes',processing_attempt=processing_attempt+1,processing_updated_at=now()
      WHERE id=(SELECT id FROM public.knowledge_documents WHERE processing_status='chunked' AND ($2::uuid IS NULL OR id=$2)
        ORDER BY processing_updated_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,processing_run_id,sha256`,[randomUUID(),documentId??null]);
    return result.rows[0]??null;
  }
  async heartbeat(run:EmbeddingRun):Promise<boolean>{
    const result=await this.pool.query(`UPDATE public.knowledge_documents SET processing_lease_expires_at=now()+interval '2 minutes'
      WHERE id=$1 AND processing_run_id=$2 AND processing_status='embedding' AND processing_lease_expires_at>now()`,[run.id,run.processing_run_id]);
    return result.rowCount===1;
  }
  async finish(run:EmbeddingRun,chunks:SourceChunk[],vectors:number[][]):Promise<boolean>{
    validateVectors(vectors,chunks.length,this.client.profile.dimensions);
    const db=await this.pool.connect();
    try{
      await db.query("BEGIN");
      const owned=await db.query(`SELECT id FROM public.knowledge_documents WHERE id=$1 AND processing_run_id=$2 AND sha256=$3
        AND processing_status='embedding' AND processing_lease_expires_at>now() FOR UPDATE`,[run.id,run.processing_run_id,run.sha256]);
      if(!owned.rowCount){await db.query("ROLLBACK");return false;}
      const source=await db.query<{id:string}>("SELECT id FROM public.knowledge_document_chunks WHERE document_id=$1 ORDER BY ordinal",[run.id]);
      if(source.rows.length!==chunks.length || source.rows.some((row,index)=>row.id!==chunks[index]!.id))throw new Error("Embedding source changed");
      const updated=await db.query(`UPDATE public.knowledge_document_chunks c SET embedding=x.vector
        FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,vector jsonb) WHERE c.document_id=$1 AND c.id=x.id`,
        [run.id,JSON.stringify(chunks.map((chunk,index)=>({id:chunk.id,vector:vectors[index]})))]);
      if(updated.rowCount!==chunks.length)throw new Error("Embedding write incomplete");
      await db.query(`UPDATE public.knowledge_documents SET processing_status='embedded',embedding_profile=$3,
        processing_run_id=NULL,processing_lease_expires_at=NULL,processing_updated_at=now()
        WHERE id=$1 AND processing_run_id=$2`,[run.id,run.processing_run_id,JSON.stringify(this.client.profile)]);
      await db.query("COMMIT");return true;
    }catch(error){await db.query("ROLLBACK").catch(()=>{});throw error;}finally{db.release();}
  }
  async processNext(documentId?:string):Promise<boolean>{
    const run=await this.claim(documentId);if(!run)return false;
    const abort=new AbortController();let heartbeatBusy=false;
    const heartbeat=setInterval(()=>{
      if(heartbeatBusy)return;heartbeatBusy=true;
      void this.heartbeat(run).then(owned=>{if(!owned)abort.abort();}).catch(()=>abort.abort()).finally(()=>{heartbeatBusy=false;});
    },10000);
    const deadline=setTimeout(()=>abort.abort(),this.timeoutMs);
    try{
      const source=await this.pool.query<SourceChunk>(`SELECT c.id,c.text FROM public.knowledge_document_chunks c
        JOIN public.knowledge_document_contents p ON p.document_id=c.document_id
        WHERE c.document_id=$1 AND p.source_sha256=$2 ORDER BY c.ordinal`,[run.id,run.sha256]);
      if(!source.rows.length || source.rows.length>5000 || source.rows.length*this.client.profile.dimensions>10_000_000)throw new Error("Invalid embedding source size");
      const vectors:number[][]=[];
      for(let start=0;start<source.rows.length;start+=this.client.batchSize){
        abort.signal.throwIfAborted();
        const batch=source.rows.slice(start,start+this.client.batchSize);
        const result=await this.client.embedDocuments(batch.map(chunk=>chunk.text),abort.signal);
        abort.signal.throwIfAborted();
        vectors.push(...validateVectors(result,batch.length,this.client.profile.dimensions));
      }
      abort.signal.throwIfAborted();await this.finish(run,source.rows,vectors);
    }catch{
      // 只生成向量无业务副作用；失败需用户明确重试。若提交实际已成功，run_id 已清空，不覆写 embedded。
      await this.pool.query(`UPDATE public.knowledge_documents SET processing_status='failed',processing_failed_stage='embedding',
        processing_error_code=$3,processing_run_id=NULL,processing_lease_expires_at=NULL,processing_updated_at=now()
        WHERE id=$1 AND processing_run_id=$2 AND processing_status='embedding'`,[run.id,run.processing_run_id,abort.signal.aborted?"interrupted":"embedding_failed"]);
    }finally{clearInterval(heartbeat);clearTimeout(deadline);}
    return true;
  }
}
