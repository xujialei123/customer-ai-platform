/**
 * @file apps/api/src/services/order-routing.test.ts
 * @module API Service 与 Worker
 * @description 回归测试：多轮纯订单号路由和普通编号防误判。
 * @see 联动关注：OrderService 与 ReplyWorker 路由顺序。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { OrderService } from './order.service.js';

test('上一轮索要订单号时，当前纯订单号应进入订单路由', () => {
  const service = new OrderService();
  const history = [
    { role: 'user', content: '我的衣服洗好了吗？' },
    { role: 'assistant', content: '请提供订单号或取件码，我马上帮您查询。' }
  ];
  assert.equal(service.isAwaitingOrderIdentifier(history), true);
  assert.equal(service.extractOrderNoCandidate('yl_20260704D7Bm7'), 'yl_20260704D7Bm7');
});

test('口语索要单号与近轮订单上下文也应允许纯单号路由', () => {
  const service = new OrderService();
  const softAsk = [
    { role: 'user', content: '查上面订单具体信息啊' },
    { role: 'assistant', content: '我这边需要完整的订单号才能调取详情，麻烦您把完整单号发我一下。' }
  ];
  assert.equal(service.isAwaitingOrderIdentifier(softAsk), true);
  assert.equal(service.hasRecentOrderContext(softAsk), true);

  const userOnly = [{ role: 'user', content: '查上面订单具体信息啊' }];
  assert.equal(service.hasRecentOrderContext(userOnly), true);
  assert.equal(service.isAwaitingOrderIdentifier(userOnly), false);
});

test('普通会话中的字母数字串不能脱离上下文误判为订单查询', () => {
  const service = new OrderService();
  const history = [{ role: 'assistant', content: '您好，请问有什么可以帮您？' }];
  assert.equal(service.isAwaitingOrderIdentifier(history), false);
  assert.equal(service.hasRecentOrderContext(history), false);
  assert.equal(service.extractOrderNo('abc123456'), null);
});
