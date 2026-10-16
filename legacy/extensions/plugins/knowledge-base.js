import knowledgeBaseExtension from "../knowledge-base.js";
const knowledgeBasePlugin = {
  id: "knowledge_base",
  name: "知识库",
  description: "本地 SQLite 中文检索，提供 search_knowledge_base、read_knowledge_base、list_knowledge_base 工具。",
  icon: "kb",
  version: "1.0.0",
  apply(ctx) {
    knowledgeBaseExtension(ctx.pi);
  }
};
export {
  knowledgeBasePlugin
};
