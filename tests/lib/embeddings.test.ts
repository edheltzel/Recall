import { describe, test, expect } from 'bun:test';
import {
  embeddingToBlob,
  blobToEmbedding,
  cosineSimilarity,
  reciprocalRankFusion,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL
} from '../../src/lib/embeddings';

describe('embeddingToBlob / blobToEmbedding', () => {
  test('round-trip: embeddingToBlob then blobToEmbedding returns original array', () => {
    const original = [1.0, 2.0, 3.0, -1.5];
    const blob = embeddingToBlob(original);
    const result = blobToEmbedding(blob);

    expect(result.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(result[i]).toBeCloseTo(original[i], 5);
    }
  });

  test('empty array round-trips correctly', () => {
    const original: number[] = [];
    const blob = embeddingToBlob(original);
    const result = blobToEmbedding(blob);

    expect(result).toEqual([]);
  });

  test('blob has correct byte length (4 bytes per float32)', () => {
    const embedding = [1.0, 2.0, 3.0, -1.5];
    const blob = embeddingToBlob(embedding);

    expect(blob.length).toBe(embedding.length * 4);
  });
});

describe('cosineSimilarity', () => {
  test('identical vectors return 1.0', () => {
    const v = [1.0, 2.0, 3.0];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  test('orthogonal vectors return 0.0', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  test('opposite vectors return -1.0', () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  test('throws if dimensions mismatch', () => {
    const a = [1.0, 2.0, 3.0];
    const b = [1.0, 2.0];
    expect(() => cosineSimilarity(a, b)).toThrow('Embeddings must have same dimensions');
  });
});

describe('reciprocalRankFusion', () => {
  test('single list returns RRF scores for each item', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const scores = reciprocalRankFusion([list]);

    // With k=60: rank 0 -> 1/61, rank 1 -> 1/62, rank 2 -> 1/63
    expect(scores.get('a')).toBeCloseTo(1 / 61, 5);
    expect(scores.get('b')).toBeCloseTo(1 / 62, 5);
    expect(scores.get('c')).toBeCloseTo(1 / 63, 5);
  });

  test('two lists with overlapping items sum scores correctly', () => {
    const list1 = [{ id: 'a' }, { id: 'b' }];
    const list2 = [{ id: 'b' }, { id: 'c' }];
    const scores = reciprocalRankFusion([list1, list2]);

    // 'a' appears only in list1 at rank 0: 1/61
    expect(scores.get('a')).toBeCloseTo(1 / 61, 5);
    // 'b' appears in list1 at rank 1 (1/62) and list2 at rank 0 (1/61)
    expect(scores.get('b')).toBeCloseTo(1 / 62 + 1 / 61, 5);
    // 'c' appears only in list2 at rank 1: 1/62
    expect(scores.get('c')).toBeCloseTo(1 / 62, 5);
  });

  test('empty lists return empty map', () => {
    const scores = reciprocalRankFusion([]);
    expect(scores.size).toBe(0);
  });

  test('items appearing in multiple lists get higher scores than single-list items', () => {
    const list1 = [{ id: 'shared' }, { id: 'only-in-1' }];
    const list2 = [{ id: 'shared' }, { id: 'only-in-2' }];
    const scores = reciprocalRankFusion([list1, list2]);

    const sharedScore = scores.get('shared')!;
    const singleScore1 = scores.get('only-in-1')!;
    const singleScore2 = scores.get('only-in-2')!;

    expect(sharedScore).toBeGreaterThan(singleScore1);
    expect(sharedScore).toBeGreaterThan(singleScore2);
  });
});

describe('constants', () => {
  test('EMBEDDING_DIMENSIONS is 768', () => {
    expect(EMBEDDING_DIMENSIONS).toBe(768);
  });

  test("EMBEDDING_MODEL is 'nomic-embed-text'", () => {
    expect(EMBEDDING_MODEL).toBe('nomic-embed-text');
  });
});
