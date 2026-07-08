// @ts-nocheck
// 抖音 RPA Adapter。
// 第一版默认只生成建议回复，不自动发送。后续可以用 Playwright 操作抖音来客后台。
export class DouyinRpaAdapter {
    platform = 'douyin';
    async parseInbound(raw) {
        return {
            id: raw.id,
            platform: 'douyin',
            shopId: raw.shopId,
            conversationId: raw.conversationId,
            customerId: raw.customerId,
            customerName: raw.customerName,
            messageType: raw.messageType ?? 'text',
            content: raw.content ?? '',
            attachments: raw.attachments ?? [],
            raw,
            createdAt: raw.createdAt ?? new Date().toISOString()
        };
    }
    async sendMessage(params) {
        // 注意：RPA 自动发送风险较高，默认不要调用真实发送。
        // 后续可以在 rpa/douyin.sender.ts 中实现输入框填充和点击发送。
        return {
            success: false,
            error: '抖音 RPA 自动发送默认关闭，请先人工审核'
        };
    }
}
