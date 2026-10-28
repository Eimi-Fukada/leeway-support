import { randomBytes,createHash } from "node:crypto";
import { mkdir,writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createPool } from "../src/database.ts";
process.loadEnvFile(fileURLToPath(new URL("../.env",import.meta.url)));
const pool=createPool(),token=randomBytes(32).toString("hex");
try{
 const user=(await pool.query("SELECT id FROM public.knowledge_users WHERE username='support' AND active=true")).rows[0];if(!user)throw new Error("测试管理员不存在");
 await pool.query("INSERT INTO public.knowledge_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')",[createHash("sha256").update(token).digest("hex"),user.id]);
 const folder=new URL("../../../output/playwright/knowledge-chat/",import.meta.url);await mkdir(folder,{recursive:true});
 await writeFile(new URL("session.json",folder),JSON.stringify({cookies:[{name:"leeway_knowledge_session",value:token,domain:"127.0.0.1",path:"/",expires:Math.floor(Date.now()/1000)+900,httpOnly:true,secure:false,sameSite:"Lax"}],origins:[]}));
 console.log("短时浏览器测试会话已写入 output/playwright/knowledge-chat/session.json，不输出 cookie。");
}finally{await pool.end();}
