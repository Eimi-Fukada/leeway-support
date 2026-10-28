import { fileURLToPath } from "node:url";
import { createPool } from "../src/database.ts";
import { createEmbeddingClient } from "../src/embeddings/client.ts";
import { QdrantStore,readQdrantConfig } from "../src/indexing/qdrant.ts";
import { RetrievalService } from "../src/retrieval/service.ts";
process.loadEnvFile(fileURLToPath(new URL("../.env",import.meta.url)));
const pool=createPool();
try {
 const base=(await pool.query("SELECT id,owner_id FROM public.knowledge_bases WHERE name='入库验收 A · 青禾项目'")).rows[0];
 if(!base)throw new Error("缺少已有验收资料");
 const retrieval=new RetrievalService(pool,createEmbeddingClient(),new QdrantStore(readQdrantConfig()));
 const questions:[string,string|null][]=[
  ["青禾专业月付多少钱？","99 元"],["专业版可以试用多长时间？","14 个自然日"],
  ["订单没付款多久关闭？","30 分钟"],["付款成功多久开通？","3 分钟"],
  ["首次购买月付如何退款？","7 个自然日"],["退款有使用时长限制吗？","2 小时"],
  ["专业套餐允许多少成员？","30 人"],["邀请未接受会占名额吗？","72 小时"],
  ["青禾董事长是谁？",null],["公司食堂今天菜单？",null],["青禾支持什么银行卡贷款？",null],["明年股价预测？",null]];
 let failures=0;
 for(const [question,expected] of questions){const start=Date.now();const result=await retrieval.search(base.owner_id,base.id,{question});
  const hit=expected?result.evidence.some(e=>e.text.includes(expected)):null;if(hit===false)failures++;
  console.log(JSON.stringify({question,expectedSourceFound:hit,status:result.status,evidence:result.evidence.map(e=>({chunkId:e.chunkId,heading:e.headingPath,score:e.score})),elapsedMs:Date.now()-start}));
 }
 if(failures)throw new Error(`${failures} 条应有来源未召回`);
}finally{await pool.end();}
