// @ts-nocheck
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
