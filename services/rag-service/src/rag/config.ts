export const ragRetrievalConfig = {
  vectorTopK: 30,
  keywordTopK: 20,
  graphExpandTopK: 5,
  rerankTopK: 8,
  finalTopK: 3,
  scoreThreshold: 0.68,
  strictScoreThreshold: 0.75,
  weights: {
    vector: 0.45,
    keyword: 0.25,
    metadata: 0.2,
    graph: 0.1
  }
} as const;
