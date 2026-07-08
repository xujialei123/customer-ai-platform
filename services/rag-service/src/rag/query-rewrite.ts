import { extractKeywords } from './keyword.js';
import { classifyIntent } from './intent-classifier.js';
import type { QueryRewriteResult } from './types.js';

const templates: Record<string, string[]> = {
  parking: ['门店是否有停车场', '附近停车位置', '停车是否收费', '开车到店是否方便'],
  refund: ['团购券退款规则', '未使用套餐能否退款', '退款条件和到账时间'],
  reservation: ['是否需要提前预约', '预约方式和提前时间', '不预约能否到店使用'],
  business_hours: ['门店营业时间', '最晚接待和关门时间', '周末节假日是否营业'],
  address: ['门店详细地址', '门店位置和导航信息'],
  price: ['服务项目价格', '收费标准和附加费用'],
  package: ['套餐包含项目', '套餐使用时间和限制', '团购券适用规则'],
  service: ['服务范围和处理时效']
};

export function rewriteQuery(query: string): QueryRewriteResult {
  const intent = classifyIntent(query);
  const rewrites = templates[intent.category] ?? [];
  return {
    originalQuery: query,
    rewrittenQueries: [...new Set([query, ...rewrites])].slice(0, 5),
    keywords: extractKeywords(`${query} ${rewrites.join(' ')}`).slice(0, 30)
  };
}
