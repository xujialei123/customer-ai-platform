import type { KnowledgeCategory } from '../brain/types.js';
import type { IntentClassifyResult } from './types.js';

const intentRules: Array<{ category: KnowledgeCategory; keywords: string[] }> = [
  { category: 'refund', keywords: ['退款', '退券', '不想去', '退掉', '退钱'] },
  { category: 'price', keywords: ['多少钱', '价格', '费用', '收费', '便宜', '优惠'] },
  { category: 'reservation', keywords: ['预约', '提前约', '排队', '到店时间'] },
  { category: 'parking', keywords: ['停车', '停车场', '车位', '开车'] },
  { category: 'business_hours', keywords: ['营业', '几点开门', '几点关门', '下班', '营业时间'] },
  { category: 'address', keywords: ['地址', '位置', '怎么走', '在哪', '导航'] },
  { category: 'package', keywords: ['套餐', '团购', '券', '包含什么', '使用规则', '周末能用'] },
  { category: 'service', keywords: ['服务', '上门', '取送', '多久', '洗好'] }
];

const strictCategories = new Set<KnowledgeCategory>(['price', 'refund', 'reservation', 'business_hours', 'address', 'package', 'parking']);

export function classifyIntent(query: string): IntentClassifyResult {
  // 严格意图按规则优先级命中，避免“预约取送”因 service 词更多而覆盖 reservation。
  const matchedRule = intentRules.find((rule) => rule.keywords.some((keyword) => query.includes(keyword)));
  const category = matchedRule?.category ?? 'other';
  const matchCount = matchedRule?.keywords.filter((keyword) => query.includes(keyword)).length ?? 0;
  return {
    category,
    confidence: matchCount ? Math.min(1, 0.65 + matchCount * 0.15) : 0.35,
    needStrictAnswer: strictCategories.has(category)
  };
}

export function detectIntentCategories(query: string): KnowledgeCategory[] {
  return intentRules.filter((rule) => rule.keywords.some((keyword) => query.includes(keyword))).map((rule) => rule.category);
}
