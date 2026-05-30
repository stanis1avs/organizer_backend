// Store the mock OpenSearch instance on the mock constructor so tests can reach it.
jest.mock('@opensearch-project/opensearch', () => {
  const mockInstance = { index: jest.fn().mockResolvedValue({}) };
  const Client = jest.fn().mockImplementation(() => mockInstance);
  Client._instance = mockInstance; // stable reference, survives clearAllMocks
  return { Client };
});

jest.mock('axios', () => {
  const qdrantClient = {
    put: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn().mockResolvedValue({ data: {} }),
    get: jest.fn().mockResolvedValue({ data: {} }),
  };
  return {
    create: jest.fn(() => qdrantClient),
    post: jest.fn().mockResolvedValue({
      data: { embedding: new Array(512).fill(0.1) },
    }),
    get: jest.fn(),
    _qdrant: qdrantClient,
  };
});

jest.mock('../helpers', () => ({
  getQueryEmbedding: jest.fn().mockResolvedValue(new Array(384).fill(0.1)),
  fuseResults: jest.fn().mockReturnValue([]),
}));

jest.mock('../ocrService', () => ({
  extractTextFromImage: jest.fn().mockResolvedValue(''),
}));

const axios = require('axios');
const { Client } = require('@opensearch-project/opensearch');
const { getQueryEmbedding } = require('../helpers');
const { indexMessage, indexToOpenSearch } = require('../indexMessage');

// Access mock instances via the stable references we attached in the factories.
const osClient = Client._instance;
const qdrant = axios._qdrant;

beforeEach(() => {
  jest.clearAllMocks();
  osClient.index.mockResolvedValue({});
  qdrant.put.mockResolvedValue({ data: {} });
  qdrant.post.mockResolvedValue({ data: {} });
  getQueryEmbedding.mockResolvedValue(new Array(384).fill(0.1));
  axios.post.mockResolvedValue({ data: { embedding: new Array(512).fill(0.1) } });
});

// ─── indexToOpenSearch ────────────────────────────────────────────────────

describe('indexToOpenSearch', () => {
  test('calls osClient.index with message_id as document id', async () => {
    await indexToOpenSearch({ message_id: 'msg-1', text: 'Hello', type: 'text', date: null });
    expect(osClient.index).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'msg-1', index: 'messages_bm25' })
    );
  });

  test('stores text, type, and a valid ISO date in the body', async () => {
    await indexToOpenSearch({ message_id: 'msg-2', text: 'World', type: 'text', date: null });
    const body = osClient.index.mock.calls[0][0].body;
    expect(body.text).toBe('World');
    expect(body.type).toBe('text');
    expect(() => new Date(body.date).toISOString()).not.toThrow();
  });

  test('preserves a valid ISO date string as-is', async () => {
    await indexToOpenSearch({
      message_id: 'msg-3',
      text: 'Test',
      type: 'text',
      date: '2024-03-15T10:00:00.000Z',
    });
    const body = osClient.index.mock.calls[0][0].body;
    expect(body.date).toBe('2024-03-15T10:00:00.000Z');
  });

  test('does not throw when osClient.index rejects', async () => {
    osClient.index.mockRejectedValueOnce(new Error('Connection refused'));
    await expect(
      indexToOpenSearch({ message_id: 'msg-4', text: 'X', type: 'text', date: null })
    ).resolves.toBeUndefined();
  });
});

// ─── indexMessage — text type ─────────────────────────────────────────────

describe('indexMessage — type: text', () => {
  test('resolves without throwing for a valid text message', async () => {
    await expect(
      indexMessage({ message_id: 'txt-1', text: 'Hello world', type: 'text' })
    ).resolves.toBeUndefined();
  });

  test('calls getQueryEmbedding with the message text and size 384', async () => {
    await indexMessage({ message_id: 'txt-2', text: 'Test message', type: 'text' });
    expect(getQueryEmbedding).toHaveBeenCalledWith('Test message', 384);
  });

  test('upserts the text vector to the messages_text_vectors Qdrant collection', async () => {
    await indexMessage({ message_id: 'txt-3', text: 'Hello', type: 'text' });
    expect(qdrant.put).toHaveBeenCalledWith(
      expect.stringContaining('messages_text_vectors'),
      expect.objectContaining({ points: expect.any(Array) }),
      expect.any(Object)
    );
  });

  test('Qdrant point id matches the message_id', async () => {
    await indexMessage({ message_id: 'txt-4', text: 'Hello', type: 'text' });
    const body = qdrant.put.mock.calls[0][1];
    expect(body.points[0].id).toBe('txt-4');
  });

  test('does not throw when Qdrant put rejects', async () => {
    qdrant.put.mockRejectedValueOnce(new Error('Qdrant timeout'));
    await expect(
      indexMessage({ message_id: 'txt-5', text: 'Hello', type: 'text' })
    ).resolves.toBeUndefined();
  });

  test('uses current ISO date when no date is provided', async () => {
    const before = Date.now();
    await indexMessage({ message_id: 'txt-6', text: 'Hello', type: 'text' });
    const after = Date.now();
    const body = osClient.index.mock.calls[0][0].body;
    const indexed = new Date(body.date).getTime();
    expect(indexed).toBeGreaterThanOrEqual(before);
    expect(indexed).toBeLessThanOrEqual(after);
  });
});

// ─── indexMessage — image type ────────────────────────────────────────────

describe('indexMessage — type: image', () => {
  test('resolves without throwing for a valid image message', async () => {
    await expect(
      indexMessage({ message_id: 'img-1', text: '', type: 'image', imagePath: '/tmp/photo.jpg' })
    ).resolves.toBeUndefined();
  });

  test('upserts image vector to images_vectors Qdrant collection', async () => {
    await indexMessage({ message_id: 'img-2', text: '', type: 'image', imagePath: '/tmp/photo.jpg' });
    const calledUrls = qdrant.put.mock.calls.map((c) => c[0]);
    expect(calledUrls.some((url) => url.includes('images_vectors'))).toBe(true);
  });

  test('does not throw when image embedding API fails', async () => {
    axios.post.mockRejectedValueOnce(new Error('Embedding service down'));
    await expect(
      indexMessage({ message_id: 'img-3', text: '', type: 'image', imagePath: '/tmp/photo.jpg' })
    ).resolves.toBeUndefined();
  });
});
