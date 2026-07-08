import { nanoid } from 'nanoid';
import type { KnowledgeCard, KnowledgeGraphEdge } from './types.js';

export class GraphBuilder {
  build(cards: KnowledgeCard[]): KnowledgeGraphEdge[] {
    const edges: KnowledgeGraphEdge[] = [];
    const edgeCounts = new Map<string, number>();
    for (let leftIndex = 0; leftIndex < cards.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < cards.length; rightIndex += 1) {
        const left = cards[leftIndex];
        const right = cards[rightIndex];
        const sharedTags = left.tags.some((tag) => right.tags.includes(tag));
        const sameCategory = left.category === right.category;
        if (!sharedTags && !sameCategory)
          continue;
        if ((edgeCounts.get(left.id) ?? 0) >= 5 || (edgeCounts.get(right.id) ?? 0) >= 5)
          continue;
        const relation = sameCategory ? 'same_topic' : 'related';
        // 关系双向保存，Graph 扩展从任一命中卡片都能找到配套规则。
        edges.push({ id: `edge_${nanoid()}`, fromId: left.id, toId: right.id, relation });
        edges.push({ id: `edge_${nanoid()}`, fromId: right.id, toId: left.id, relation });
        edgeCounts.set(left.id, (edgeCounts.get(left.id) ?? 0) + 1);
        edgeCounts.set(right.id, (edgeCounts.get(right.id) ?? 0) + 1);
      }
    }
    return edges;
  }
}
