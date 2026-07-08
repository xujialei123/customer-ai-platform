// @ts-nocheck
import { env } from '../config/env.js';
import { getAdapter } from '../adapters/index.js';
export class SendService {
    // 统一发送出口。
    // RPA 平台默认禁止自动发送，避免测试阶段误回复客户。
    async send(params) {
        if ((params.platform === 'douyin' || params.platform === 'meituan') && !env.RPA_AUTO_SEND_ENABLED) {
            return {
                success: false,
                error: 'RPA 自动发送未开启'
            };
        }
        const adapter = getAdapter(params.platform);
        return adapter.sendMessage(params);
    }
}
