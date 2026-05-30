const { normalizeArray, fuseResults } = require('../helpers');

// ─── normalizeArray ────────────────────────────────────────────────────────

describe('normalizeArray', () => {
  test('returns empty array for empty input', () => {
    expect(normalizeArray([])).toEqual([]);
  });

  test('returns empty array for null input', () => {
    expect(normalizeArray(null)).toEqual([]);
  });

  test('normalizes values to [0, 1] range', () => {
    const result = normalizeArray([0, 5, 10]);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(0.5);
    expect(result[2]).toBe(1);
  });

  test('returns all 1s when every value is the same (no range)', () => {
    expect(normalizeArray([5, 5, 5])).toEqual([1, 1, 1]);
  });

  test('single-element array returns [1]', () => {
    expect(normalizeArray([42])).toEqual([1]);
  });

  test('handles negative values correctly', () => {
    const result = normalizeArray([-10, 0, 10]);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(0.5);
    expect(result[2]).toBe(1);
  });

  test('handles array with min=0 and varying positives', () => {
    const result = normalizeArray([0, 2, 4]);
    expect(result[0]).toBeCloseTo(0);
    expect(result[1]).toBeCloseTo(0.5);
    expect(result[2]).toBeCloseTo(1);
  });
});

// ─── fuseResults ──────────────────────────────────────────────────────────

describe('fuseResults', () => {
  test('returns empty array when both maps are empty', () => {
    expect(fuseResults(new Map(), new Map())).toEqual([]);
  });

  test('sorts results by combined score descending', () => {
    const bmMap = new Map([
      ['a', { bmScore: 1.0, doc: { text: 'a' } }],
      ['b', { bmScore: 0.1, doc: { text: 'b' } }],
    ]);
    const vecMap = new Map([
      ['a', { vecScore: 0.9, payload: {} }],
      ['b', { vecScore: 0.2, payload: {} }],
    ]);
    const results = fuseResults(bmMap, vecMap, 0.6);
    expect(results[0].id).toBe('a');
    expect(results[1].id).toBe('b');
    expect(results[0].combined).toBeGreaterThan(results[1].combined);
  });

  test('handles IDs present only in BM25 map', () => {
    const bmMap = new Map([['x', { bmScore: 2.0, doc: { text: 'x' } }]]);
    const results = fuseResults(bmMap, new Map(), 0.6);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('x');
    expect(results[0].vecScore).toBe(0);
  });

  test('handles IDs present only in vector map', () => {
    const vecMap = new Map([['y', { vecScore: 0.9, payload: { text: 'y' } }]]);
    const results = fuseResults(new Map(), vecMap, 0.6);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('y');
    expect(results[0].bmScore).toBe(0);
  });

  test('each result includes id, bmScore, vecScore, combined, doc, payload', () => {
    const bmMap = new Map([['a', { bmScore: 1.5, doc: { text: 'hello' } }]]);
    const vecMap = new Map([['a', { vecScore: 0.8, payload: { x: 1 } }]]);
    const [result] = fuseResults(bmMap, vecMap, 0.6);
    expect(result).toMatchObject({
      id: 'a',
      bmScore: 1.5,
      vecScore: 0.8,
      doc: { text: 'hello' },
      payload: { x: 1 },
    });
    expect(typeof result.combined).toBe('number');
    expect(typeof result.bmNorm).toBe('number');
    expect(typeof result.vecNorm).toBe('number');
  });

  test('with alpha=1.0 combined score equals vecNorm', () => {
    const bmMap = new Map([
      ['a', { bmScore: 0, doc: null }],
      ['b', { bmScore: 0, doc: null }],
    ]);
    const vecMap = new Map([
      ['a', { vecScore: 10, payload: null }],
      ['b', { vecScore: 5, payload: null }],
    ]);
    const results = fuseResults(bmMap, vecMap, 1.0);
    // vecNorm: max item → 1.0, min item → 0.0 (min-max normalization)
    expect(results[0].id).toBe('a');
    expect(results[0].combined).toBeCloseTo(1.0);
    expect(results[1].combined).toBeCloseTo(0.0);
  });

  test('with alpha=0.0 combined score equals bmNorm', () => {
    const bmMap = new Map([
      ['a', { bmScore: 8, doc: null }],
      ['b', { bmScore: 2, doc: null }],
    ]);
    const vecMap = new Map([
      ['a', { vecScore: 0, payload: null }],
      ['b', { vecScore: 0, payload: null }],
    ]);
    const results = fuseResults(bmMap, vecMap, 0.0);
    expect(results[0].id).toBe('a');
    expect(results[0].combined).toBeCloseTo(1.0);
    expect(results[1].combined).toBeCloseTo(0.0);
  });

  test('merges IDs from both maps into one result list', () => {
    const bmMap = new Map([['a', { bmScore: 1, doc: null }]]);
    const vecMap = new Map([['b', { vecScore: 1, payload: null }]]);
    const results = fuseResults(bmMap, vecMap, 0.5);
    expect(results.length).toBe(2);
    const ids = results.map((r) => r.id);
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });
});
