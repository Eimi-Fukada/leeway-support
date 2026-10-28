import { createModel } from "../config/model.ts";
import { createDatabasePool } from "../config/database.ts";
import { createCheckpointer } from "../config/checkpoint.ts";
import { createMemory } from "../config/memory.ts";
import { InformationService } from "../interactions/service.ts";
import { ConversationService } from "../conversations/service.ts";
import { createSupportAgent } from "../agent/agent.ts";
import { readSupportSchema } from "../config/schema.ts";
import { createTracing } from "../config/tracing.ts";

async function initializeStorage(){
 const pool=createDatabasePool(),checkpointer=await createCheckpointer(),memory=await createMemory();
 try{
  await pool.query(await readSupportSchema("004_knowledge_runs.sql"));
  const information=new InformationService(pool);await information.setup();
  const conversation=new ConversationService(pool);await conversation.setup();
  const tracing=createTracing();
  return {pool,checkpointer,memory,information,conversation,tracing,close:async()=>{await tracing.flush();await pool.end();await checkpointer.end();await memory.close();}};
 }catch(error){await pool.end();await checkpointer.end();await memory.close();throw error;}
}
const shared=globalThis as typeof globalThis&{knowledgeAgentStorageV1?:ReturnType<typeof initializeStorage>};
async function initialize(){
 const storage=await (shared.knowledgeAgentStorageV1??=initializeStorage().catch(error=>{delete shared.knowledgeAgentStorageV1;throw error;}));
 return {...storage,agent:createSupportAgent(createModel(),storage.checkpointer,{}, {},storage.memory.service,storage.information,true).withConfig({callbacks:storage.tracing.callbacks})};
}
let services:ReturnType<typeof initialize>|undefined;
// Agent 定义跟随模块热更新，不能将旧中间件与能力开关永久缓存到 globalThis。
export function knowledgeServices(){return services??=initialize().catch(error=>{services=undefined;throw error;});}
