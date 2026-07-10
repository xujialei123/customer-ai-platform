// @ts-nocheck
/**
 * @file apps/api/src/lib/queue.ts
 * @module API 入口与基础设施
 * @description 创建 Redis/BullMQ 连接与 inbound 消息队列。
 * @see 联动关注：ReplyWorker 和队列排障。
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
// BullMQ 需要 Redis。这里统一创建连接，后续 Worker 和 Queue 共用配置。
export const redisConnection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null
});
// 新消息队列：所有平台进来的消息都进入这个队列异步处理。
export const inboundMessageQueue = new Queue('inbound-message', {
    connection: redisConnection
});
