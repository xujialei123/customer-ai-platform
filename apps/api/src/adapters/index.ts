// @ts-nocheck
/**
 * @file apps/api/src/adapters/index.ts
 * @module API Adapter 与路由
 * @description 按 platform 字段选择对应 Adapter。
 * @see 联动关注：新增平台时在此注册。
 */
import { DouyinRpaAdapter } from './douyin-rpa.adapter.js';
import { MeituanRpaAdapter } from './meituan-rpa.adapter.js';
import { WeComAdapter } from './wecom.adapter.js';
const adapters = {
    wecom: new WeComAdapter(),
    douyin: new DouyinRpaAdapter(),
    meituan: new MeituanRpaAdapter()
};
export function getAdapter(platform) {
    return adapters[platform];
}
