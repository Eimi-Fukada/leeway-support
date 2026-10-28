import {readFile,appendFile} from "node:fs/promises";
import {randomBytes} from "node:crypto";
const paths=[new URL("../apps/agent/.env",import.meta.url),new URL("../apps/knowledge/.env",import.meta.url)];
const contents=await Promise.all(paths.map(p=>readFile(p,"utf8")));
for(const name of ["AGENT_KNOWLEDGE_WEB_SECRET","KNOWLEDGE_SUPPORT_AGENT_SECRET"]){
 const values=contents.map(t=>t.match(new RegExp(`^${name}=(.+)$`,"m"))?.[1]?.trim());
 if(values[0]&&values[1]&&values[0]!==values[1])throw new Error("已有服务密钥不一致，请核对两端配置；未覆盖。");
 const value=values.find(Boolean)??randomBytes(32).toString("hex");
 if(value.length<32)throw new Error("已有服务密钥过短；未覆盖。");
 for(let i=0;i<paths.length;i++)if(!values[i])await appendFile(paths[i],`\n${name}=${value}\n`);
}
console.log("双向服务密钥已配置到两端本机 .env；未显示或覆盖已有密钥。");
