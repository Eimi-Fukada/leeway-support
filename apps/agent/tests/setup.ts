// 测试只向本地接收端显式传入 callback，不读取真实云追踪配置。
// PostgreSQL 测试加载应用 .env 时也不能覆盖这些已有环境变量。
process.env.LANGSMITH_TRACING = "false";
process.env.LANGCHAIN_TRACING_V2 = "false";
process.env.LANGCHAIN_TRACING = "false";
