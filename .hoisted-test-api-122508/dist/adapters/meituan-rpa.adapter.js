// @ts-nocheck
// 美团到店团购 RPA Adapter。
// 注意：公开的美团 IM 回调主要偏外卖/闪购，到店团购第一版先用 RPA 骨架。
export class MeituanRpaAdapter {
    platform = 'meituan';
    async parseInbound(raw) {
        return {
            id: raw.id,
            platform: 'meituan',
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
        // 第一版不建议自动发美团消息，先做人工确认。
        return {
            success: false,
            error: '美团 RPA 自动发送默认关闭，请先人工审核'
        };
    }
}
