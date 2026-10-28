import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type pg from "pg";

export function secret(name:string) {const value=process.env[name];if(!value||value.length<32)throw new Error("服务接入密钥缺失或过短。");return value;}
function canonical(caller:string,audience:string,path:string,body:string,time:string,nonce:string){return JSON.stringify([1,caller,audience,"POST",path,createHash("sha256").update(body).digest("hex"),time,nonce]);}
export function signedHeaders(caller:string,audience:string,path:string,body:string,key:string){
 const time=String(Date.now()),nonce=randomUUID();return {"Content-Type":"application/json","x-service-caller":caller,"x-service-audience":audience,"x-service-time":time,"x-service-nonce":nonce,
 "x-service-signature":createHmac("sha256",key).update(canonical(caller,audience,path,body,time,nonce)).digest("hex")};
}
export async function verifyService(request:Request,body:string,key:string,pool:pg.Pool,table:"knowledge_service_nonces"|"support_service_nonces",caller:string,audience:string){
 const time=request.headers.get("x-service-time")??"",nonce=request.headers.get("x-service-nonce")??"",signature=request.headers.get("x-service-signature")??"";
 if(request.method!=="POST"||request.headers.get("x-service-caller")!==caller||request.headers.get("x-service-audience")!==audience||!/^\d{13}$/.test(time)
  ||Date.now()-Number(time)>60000||Number(time)-Date.now()>30000||!/^[a-f0-9-]{36}$/.test(nonce)||!/^[a-f0-9]{64}$/.test(signature))throw new Error("服务认证失败。");
 const expected=createHmac("sha256",key).update(canonical(caller,audience,new URL(request.url).pathname,body,time,nonce)).digest();
 if(!timingSafeEqual(expected,Buffer.from(signature,"hex")))throw new Error("服务认证失败。");
 const inserted=await pool.query(`INSERT INTO public.${table}(caller,nonce,expires_at) VALUES($1,$2,now()+interval '2 minutes') ON CONFLICT DO NOTHING RETURNING nonce`,[caller,nonce]);
 if(!inserted.rowCount)throw new Error("服务请求已使用。");
 await pool.query(`DELETE FROM public.${table} WHERE expires_at<now()`);
}
export async function boundedBody(request:Request){
 if(!request.headers.get("content-type")?.startsWith("application/json")||!request.body)throw new Error("请求格式无效。");
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>65536){await reader.cancel();throw new Error("请求过大。");}chunks.push(item.value);}return Buffer.concat(chunks).toString("utf8");}finally{reader.releaseLock();}
}
