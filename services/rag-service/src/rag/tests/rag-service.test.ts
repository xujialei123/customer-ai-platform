import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyIntent, detectIntentCategories } from '../intent-classifier.js';
import { rewriteQuery } from '../query-rewrite.js';
import { shouldFallback } from '../fallback.js';
import type { RetrievalCandidate } from '../types.js';

function candidate(score: number, category: ReturnType<typeof classifyIntent>['category']): RetrievalCandidate {
  const now = new Date(0).toISOString();
  return {
    card: {
      id: 'card_test', kbId: 'kb_test', title: '测试卡片', content: '测试答案', answer: '测试答案',
      questionVariants: [], keywords: [], tags: [], category, relatedCardIds: [], sourceType: 'manual',
      priority: 100, enabled: true, createdAt: now, updatedAt: now
    },
    vectorScore: score, keywordScore: score, metadataScore: 1, graphScore: 0,
    hybridScore: score, score
  };
}

test('停车问题识别为 parking，严格命中达到阈值后可回答', () => {
  const intent = classifyIntent('停车方便吗？');
  assert.equal(intent.category, 'parking');
  assert.equal(shouldFallback([candidate(0.8, 'parking')], intent), false);
});

test('退款问题识别为 refund，供上层风控强制转人工', () => {
  assert.equal(classifyIntent('买了券不想去了能退吗？').category, 'refund');
});

test('预约问题识别为 reservation', () => {
  assert.equal(classifyIntent('需要提前预约吗？').category, 'reservation');
});

test('关门时间识别为 business_hours', () => {
  assert.equal(classifyIntent('几点关门？').category, 'business_hours');
});

test('套餐内容识别为 package', () => {
  assert.equal(classifyIntent('这个套餐包含什么？').category, 'package');
});

test('没有优惠证据时严格价格问题转人工', () => {
  const intent = classifyIntent('能不能便宜点？');
  assert.equal(intent.category, 'price');
  assert.equal(shouldFallback([], intent), true);
});

test('知识库无关问题转人工', () => {
  const intent = classifyIntent('你们老板是谁？');
  assert.equal(intent.category, 'other');
  assert.equal(shouldFallback([candidate(0.4, 'other')], intent), true);
});

test('组合问题同时扩展退款和套餐检索意图', () => {
  const query = '套餐A能不能退款，周末能用吗？';
  const categories = detectIntentCategories(query);
  const rewrite = rewriteQuery(query);
  assert.ok(categories.includes('refund'));
  assert.ok(categories.includes('package'));
  assert.ok(rewrite.rewrittenQueries.some((item) => item.includes('退款')));
  assert.ok(rewrite.rewrittenQueries.some((item) => item.includes('套餐')));
});
