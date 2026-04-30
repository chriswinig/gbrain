import { describe, it, expect } from 'bun:test';
import { collapseToPageLevel, applySlugWeights } from '../src/core/search/hybrid.ts';
import type { SearchResult } from '../src/core/types.ts';

function mockResult(slug: string, score: number, chunk_text = 'text'): SearchResult {
  return {
    slug,
    score,
    chunk_text,
    page_id: 1,
    title: slug,
    type: 'concept',
    chunk_source: 'compiled_truth',
    chunk_id: Math.abs(slug.split('').reduce((n, ch) => ((n << 5) - n) + ch.charCodeAt(0), 0)),
    chunk_index: 0,
    stale: false,
  };
}

describe('collapseToPageLevel', () => {
  it('collapses multiple chunks from the same slug to the highest score', () => {
    const input = [
      mockResult('collectors/digest-1', 0.9, 'chunk A'),
      mockResult('people/john', 0.8, 'chunk B'),
      mockResult('collectors/digest-1', 0.7, 'chunk C'),
      mockResult('collectors/digest-1', 0.5, 'chunk D'),
    ];
    const result = collapseToPageLevel(input);
    expect(result).toHaveLength(2);
    expect(result[0].slug).toBe('collectors/digest-1');
    expect(result[0].score).toBe(0.9);
    expect(result[1].slug).toBe('people/john');
    expect(result[1].score).toBe(0.8);
  });

  it('returns empty array for empty input', () => {
    expect(collapseToPageLevel([])).toEqual([]);
  });

  it('preserves all results when slugs are unique', () => {
    const input = [
      mockResult('people/alice', 0.9),
      mockResult('people/bob', 0.7),
      mockResult('companies/acme', 0.5),
    ];
    const result = collapseToPageLevel(input);
    expect(result).toHaveLength(3);
    expect(result.map(r => r.slug)).toEqual(['people/alice', 'people/bob', 'companies/acme']);
  });

  it('keeps highest score among 5 chunks from same slug', () => {
    const input = [
      mockResult('collectors/big-page', 0.3, 'a'),
      mockResult('collectors/big-page', 0.8, 'b'),
      mockResult('collectors/big-page', 0.1, 'c'),
      mockResult('collectors/big-page', 0.6, 'd'),
      mockResult('collectors/big-page', 0.4, 'e'),
    ];
    const result = collapseToPageLevel(input);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.8);
  });

  it('sorts output by score descending', () => {
    const input = [
      mockResult('a/low', 0.1),
      mockResult('b/high', 0.9),
      mockResult('c/mid', 0.5),
    ];
    const result = collapseToPageLevel(input);
    expect(result.map(r => r.score)).toEqual([0.9, 0.5, 0.1]);
  });
});

describe('applySlugWeights', () => {
  it('penalizes collectors/ prefix with 0.3 weight', () => {
    const input = [mockResult('collectors/email-digest', 1.0)];
    const result = applySlugWeights(input);
    expect(result[0].score).toBeCloseTo(0.3, 5);
  });

  it('penalizes cron/ prefix with 0.2 weight', () => {
    const input = [mockResult('cron/daily-output', 1.0)];
    const result = applySlugWeights(input);
    expect(result[0].score).toBeCloseTo(0.2, 5);
  });

  it('leaves non-matching slugs at full weight', () => {
    const input = [mockResult('people/john-doe', 1.0)];
    const result = applySlugWeights(input);
    expect(result[0].score).toBe(1.0);
  });

  it('re-sorts after weighting so curated pages outrank penalized noise', () => {
    const input = [
      mockResult('collectors/digest', 0.5),
      mockResult('people/alice', 0.4),
    ];
    const result = applySlugWeights(input);
    // collectors: 0.5 * 0.3 = 0.15
    // people: 0.4 * 1.0 = 0.4
    expect(result[0].slug).toBe('people/alice');
    expect(result[0].score).toBeCloseTo(0.4, 5);
    expect(result[1].slug).toBe('collectors/digest');
    expect(result[1].score).toBeCloseTo(0.15, 5);
  });

  it('handles empty array', () => {
    expect(applySlugWeights([])).toEqual([]);
  });

  it('does not mutate original results', () => {
    const original = mockResult('collectors/x', 1.0);
    applySlugWeights([original]);
    expect(original.score).toBe(1.0);
  });
});

describe('noise suppression integration', () => {
  it('curated page outranks noise page with many chunks after collapse + weight', () => {
    // Simulate: collectors/digest has 20 chunks in a vector list, people/john has 2
    const vectorList = [
      ...Array.from({ length: 20 }, (_, i) =>
        mockResult('collectors/digest-1', 0.9 - i * 0.01, `digest chunk ${i}`),
      ),
      mockResult('people/john', 0.85, 'john chunk 1'),
      mockResult('people/john', 0.80, 'john chunk 2'),
    ];

    // Step 1: Collapse — each page gets 1 entry
    const collapsed = collapseToPageLevel(vectorList);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0].slug).toBe('collectors/digest-1'); // 0.9 > 0.85

    // Step 2: Apply slug weights — collectors gets penalized
    const weighted = applySlugWeights(collapsed);
    // collectors: 0.9 * 0.3 = 0.27
    // people: 0.85 * 1.0 = 0.85
    expect(weighted[0].slug).toBe('people/john');
    expect(weighted[0].score).toBeCloseTo(0.85, 5);
    expect(weighted[1].slug).toBe('collectors/digest-1');
    expect(weighted[1].score).toBeCloseTo(0.27, 5);
  });
});
