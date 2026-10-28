import { createHash } from "node:crypto";

export type EmbeddingProvider = "ollama" | "openai-compatible";
export interface EmbeddingConfig {
  provider: EmbeddingProvider; baseUrl: string; model: string; revision: string; dimensions: number;
  apiKey?: string; timeoutMs: number; batchSize: number; documentPrefix: string; queryPrefix: string;
}
export interface EmbeddingProfile {
  id: string; provider: EmbeddingProvider; endpointHash: string; model: string; revision: string;
  dimensions: number; documentPrefix: string; queryPrefix: string;
}
export interface EmbeddingClient {
  readonly profile: EmbeddingProfile;
  readonly batchSize: number;
  embedDocuments(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  embedQuery(text: string, signal?: AbortSignal): Promise<number[]>;
}
export class EmbeddingError extends Error {
  constructor(public readonly reason: "configuration" | "request" | "response" | "cancelled", message: string) { super(message); }
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export function readEmbeddingConfig(env: Record<string,string|undefined> = process.env): EmbeddingConfig {
  const invalid = () => new EmbeddingError("configuration", "嵌入配置无效：请检查 EMBEDDING_* 环境变量。");
  const required = (name: string) => { const value = env[name]?.trim(); if (!value || /[\r\n]/.test(value)) throw invalid(); return value; };
  const integer = (name: string, fallback: string, max: number) => {
    const raw = env[name]?.trim() ?? fallback; const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value<1 || value>max) throw invalid();
    return value;
  };
  const provider = required("EMBEDDING_PROVIDER");
  if (provider !== "ollama" && provider !== "openai-compatible") throw invalid();
  let url: URL;
  try { url = new URL(required("EMBEDDING_BASE_URL")); } catch { throw invalid(); }
  if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || /\/(embed|embeddings)\/?$/.test(url.pathname)) throw invalid();
  const apiKey = env.EMBEDDING_API_KEY?.trim() || undefined;
  if (apiKey && /[\r\n]/.test(apiKey) || provider === "openai-compatible" && !apiKey) throw invalid();
  const documentPrefix = env.EMBEDDING_DOCUMENT_PREFIX ?? "";
  const queryPrefix = (env.EMBEDDING_QUERY_PREFIX ?? "").replaceAll("\\n", "\n");
  if (documentPrefix.length>2000 || queryPrefix.length>2000) throw invalid();
  return { provider, baseUrl: url.href.replace(/\/$/,""), model: required("EMBEDDING_MODEL"), revision: required("EMBEDDING_MODEL_REVISION"),
    dimensions: integer("EMBEDDING_DIMENSIONS","1024",8192), apiKey,
    timeoutMs: integer("EMBEDDING_TIMEOUT_MS","120000",600000), batchSize: integer("EMBEDDING_BATCH_SIZE","8",32), documentPrefix, queryPrefix };
}

export function validateVectors(value: unknown, count: number, dimensions: number): number[][] {
  if (!Array.isArray(value) || value.length !== count) throw new EmbeddingError("response", "嵌入服务返回的向量数量不符。");
  for (const vector of value) {
    if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every((number: unknown) => typeof number === "number" && Number.isFinite(number))
      || !vector.some((number: number) => number !== 0)) throw new EmbeddingError("response", "嵌入服务返回的向量维度或数值无效。");
  }
  return value as number[][];
}

export function createEmbeddingClient(config = readEmbeddingConfig(), transport: typeof fetch = fetch): EmbeddingClient {
  const specification = { provider:config.provider, endpointHash:digest(config.baseUrl), model:config.model,revision:config.revision,
    dimensions:config.dimensions,documentPrefix:config.documentPrefix,queryPrefix:config.queryPrefix };
  const profile = Object.freeze({ id:digest(JSON.stringify(specification)),...specification });
  async function embed(texts: string[], prefix: string, signal?: AbortSignal): Promise<number[][]> {
    if (!texts.length || texts.length>config.batchSize || texts.some((text) => !text.trim() || text.length>100000)) throw new EmbeddingError("request", "嵌入输入为空、过长或批次过大。");
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(),config.timeoutMs);
    try {
      combined.throwIfAborted();
      const input = texts.map((text) => prefix+text);
      const body = config.provider === "ollama" ? {model:config.model,input,truncate:false} : {model:config.model,input,encoding_format:"float"};
      const response = await transport(`${config.baseUrl}${config.provider === "ollama" ? "/api/embed" : "/embeddings"}`,{
        method:"POST",redirect:"error",headers:{"Content-Type":"application/json",...(config.apiKey ? {Authorization:`Bearer ${config.apiKey}`} : {})},
        body:JSON.stringify(body),signal:combined,
      });
      if (!response.ok) { await response.body?.cancel(); throw new EmbeddingError("request",`嵌入请求失败（HTTP ${response.status}）。`); }
      // 不使用无限制 response.json，响应体也受内存边界限制。
      if (!response.body) throw new EmbeddingError("response","嵌入响应为空。");
      const reader=response.body.getReader(); const parts:Uint8Array[]=[];let bytes=0;
      const maxBytes=Math.max(65536,texts.length*config.dimensions*32+16384);
      try { for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>maxBytes){await reader.cancel();throw new EmbeddingError("response","嵌入响应超过大小限制。");}parts.push(item.value);} }
      finally {reader.releaseLock();}
      combined.throwIfAborted();
      const data=JSON.parse(Buffer.concat(parts).toString("utf8"));
      if(config.provider === "ollama") {
        if(data.model !== config.model) throw new EmbeddingError("response","嵌入响应模型与配置不符。");
        return validateVectors(data.embeddings,texts.length,config.dimensions);
      }
      if(!Array.isArray(data.data) || data.data.length!==texts.length) throw new EmbeddingError("response","嵌入响应条目不符。");
      const vectors:unknown[]=new Array(texts.length);const seen=new Set<number>();
      for(const item of data.data){
        if(!Number.isInteger(item.index) || item.index<0 || item.index>=texts.length || seen.has(item.index)) throw new EmbeddingError("response","嵌入响应序号无效。");
        seen.add(item.index);vectors[item.index]=item.embedding;
      }
      return validateVectors(vectors,texts.length,config.dimensions);
    } catch(error){
      if(combined.aborted) throw new EmbeddingError("cancelled","嵌入请求已取消或超时。");
      if(error instanceof EmbeddingError) throw error;
      throw new EmbeddingError("request","嵌入服务暂不可用或响应无效。");
    } finally {clearTimeout(timeout);}
  }
  return {profile,batchSize:config.batchSize,embedDocuments:(texts,signal)=>embed(texts,config.documentPrefix,signal),
    embedQuery:async(text,signal)=>(await embed([text],config.queryPrefix,signal))[0]!};
}
