import { fileURLToPath } from "node:url";
import { createPool } from "../src/database.ts";
process.loadEnvFile(fileURLToPath(new URL("../.env",import.meta.url)));
const ids=process.argv.slice(2);if(!ids.length||ids.some(id=>!/^[a-f0-9-]{36}$/i.test(id)))throw new Error("请显式提供要授权给 knowledge-chat 的知识库 UUID。");
const pool=createPool();
try{for(const id of ids){const result=await pool.query("INSERT INTO public.knowledge_application_grants(application_id,knowledge_base_id) SELECT 'knowledge-chat',id FROM public.knowledge_bases WHERE id=$1 ON CONFLICT(application_id,knowledge_base_id) DO UPDATE SET active=true,revision=knowledge_application_grants.revision+1 RETURNING knowledge_base_id",[id]);if(!result.rowCount)throw new Error("指定知识库不存在。");console.log(`已授权 knowledge-chat：${id}`);}}finally{await pool.end();}
