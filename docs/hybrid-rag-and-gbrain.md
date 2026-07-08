# LLM Wiki、GBrain 与 Hybrid RAG

## 处理链路

```text
原始文件 -> ParsedDocument -> WikiPage -> KnowledgeCard
         -> Embedding + 中文关键词 -> Hybrid Retrieval
         -> Graph 扩展 -> 可选 Rerank -> OpenClaw 客服回答
         -> 低置信度或高风险转人工 + KnowledgeGap
```

旧文件不需要删除或重新上传。在知识库管理页对文件点击“编译”，即可在原有 Chunk/Embedding 之外生成 Wiki、知识卡片和知识关系。同一文件重复编译会先清理该文件之前生成的 Wiki、卡片和关系，避免重复数据。

文件级编译默认生成 `platform=all` 的通用知识。门店或平台专属规则应在知识卡片编辑器中明确设置，避免把管理页的临时测试门店 ID 写入全部卡片。

## 检索规则

- Query Rewrite 生成口语问题的检索变体，但强匹配只认可客户原问题中的词。
- Intent Classifier 对价格、退款、预约、营业时间、地址、套餐和停车启用严格阈值。
- Hybrid Retrieval 综合向量、中文关键词、平台/门店/分类元数据和 Graph 关系。
- Rerank 开启后可使用 LLM 重排；失败自动回退 Hybrid 分数。
- 无结果、普通问题低于 `0.68`、严格问题低于 `0.75` 时转人工并记录知识缺口。
- 退款、投诉、差评、赔偿和法律等风险问题无论检索分数多高都转人工。

## 兼容策略

- `/api/rag/search` 和 `/api/rag/chat` 保留。
- 新接口 `/api/rag/retrieve` 返回经过安全阈值的知识卡片证据。
- 新接口 `/api/rag/answer` 返回统一客服答案、置信度、意图和转人工状态。
- ReplyWorker 优先使用知识卡片 Hybrid 检索；尚未编译卡片的知识库自动回退旧 Chunk 向量检索。

## Mock 多会话

Mock 自动来消息使用 30–70 秒随机空档，同一客户不会连续收到相同问题，最近 10 条全局问题也不会重复。只有没有未读积压的非当前会话才会生成新消息。

Chrome 扩展对每个未读会话只用最新消息触发一次回复，并最多等待 120 秒。低风险草稿自动发送；转人工草稿保留在服务端，不占住输入框，也不会阻断后续未读会话。
