import type { Platform, RagChatRequest, RagChatResponse } from '@customer-ai/shared';
export interface AskRagServiceInput extends RagChatRequest {
    ragServiceUrl?: string;
    apiKey?: string;
}
export declare function createMessageHash(platform: Platform, shopId: string, sessionId: string, text: string): string;
export declare function askRagService(input: AskRagServiceInput): Promise<RagChatResponse>;
