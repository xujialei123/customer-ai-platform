import { ragRetrievalConfig } from './config.js';
export const NO_ANSWER_TEXT = '当前资料里没有查到明确说明，建议帮您转人工确认一下。';
export function shouldFallback(results, intent) {
    const topScore = results[0]?.score ?? 0;
    if (!results.length || topScore < ragRetrievalConfig.scoreThreshold)
        return true;
    return intent.needStrictAnswer && topScore < ragRetrievalConfig.strictScoreThreshold;
}
