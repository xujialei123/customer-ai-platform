/**
 * @file packages/rpa-sdk/src/index.ts
 * @module 数据库、共享包与交付
 * @description RPA SDK：askRagService、createMessageHash 等辅助函数。
 * @see 联动关注：Watcher 和 Chrome 插件 inbound 链路。
 */
import { createHash } from 'node:crypto';
import type { Platform, RagChatRequest, RagChatResponse } from '@customer-ai/shared';

export interface AskRagServiceInput extends RagChatRequest {
  ragServiceUrl?: string;
  apiKey?: string;
}

export function createMessageHash(platform: Platform, shopId: string, sessionId: string, text: string) {
  // RPA 去重必须使用稳定 hash，避免直接拼接文本时出现分隔符冲突或泄露完整用户问题。
  return createHash('sha256')
    .update([platform, shopId, sessionId, text.trim()].join('\u001f'), 'utf-8')
    .digest('hex');
}

export async function askRagService(input: AskRagServiceInput): Promise<RagChatResponse> {
  // SDK 只负责统一请求和故障降级，平台 DOM、发送按钮与登录态仍由各自 Adapter 管理。
  const ragServiceUrl = input.ragServiceUrl ?? process.env.RAG_SERVICE_URL ?? 'http://127.0.0.1:8787';
  const apiKey = input.apiKey ?? process.env.RAG_API_KEY ?? 'local-dev-key';
  const payload: RagChatRequest = {
    platform: input.platform,
    shopId: input.shopId,
    sessionId: input.sessionId,
    externalUserId: input.externalUserId,
    externalUserName: input.externalUserName,
    userMessage: input.userMessage,
    history: input.history
  };

  try {
    const response = await fetch(`${ragServiceUrl}/api/rag/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'x-api-key': apiKey
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`RAG 服务返回错误：${response.status} ${text}`);
    }

    return await response.json() as RagChatResponse;
  } catch (error) {
    // RPA 侧不能因为 RAG 服务未启动就崩溃；真实平台接入时这条日志会提示人工接管。
    return {
      answer: '这个问题我需要帮您转人工确认一下，请稍等。',
      confidence: 0,
      shouldReply: false,
      needHuman: true,
      reason: 'RAG 服务暂时不可用，建议人工接待',
      sources: []
    };
  }
}
