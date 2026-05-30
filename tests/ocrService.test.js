// util.promisify wraps child_process.execFile; mock both before the module loads.
jest.mock('util', () => {
  const actual = jest.requireActual('util');
  return {
    ...actual,
    // Return a promise-based wrapper that passes {stdout, stderr} on success
    promisify: (fn) =>
      (...args) =>
        new Promise((resolve, reject) => {
          fn(...args, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout: stdout || '', stderr: stderr || '' });
          });
        }),
  };
});

jest.mock('child_process', () => ({ execFile: jest.fn() }));

jest.mock('fs', () => ({
  promises: {
    access: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue(''),
    unlink: jest.fn().mockResolvedValue(undefined),
  },
}));

const { execFile } = require('child_process');
const fs = require('fs');
const ocrService = require('../ocrService');

beforeEach(() => {
  jest.clearAllMocks();
  // Default: file exists and tesseract exits cleanly
  fs.promises.access.mockResolvedValue(undefined);
  fs.promises.readFile.mockResolvedValue('');
  fs.promises.unlink.mockResolvedValue(undefined);
  execFile.mockImplementation((_cmd, _args, cb) => cb(null, '', ''));
});

// ─── extractTextFromImage ──────────────────────────────────────────────────

describe('OCRService.extractTextFromImage', () => {
  test('returns extracted text on success', async () => {
    fs.promises.readFile.mockResolvedValue('  Hello World  \n');
    const result = await ocrService.extractTextFromImage('/tmp/image.png');
    expect(result).toBe('Hello World');
  });

  test('returns empty string when OCR output file is empty', async () => {
    fs.promises.readFile.mockResolvedValue('');
    const result = await ocrService.extractTextFromImage('/tmp/image.png');
    expect(result).toBe('');
  });

  test('returns empty string when image file is not found', async () => {
    fs.promises.access.mockRejectedValue(new Error('ENOENT'));
    const result = await ocrService.extractTextFromImage('/tmp/missing.png');
    expect(result).toBe('');
  });

  test('returns empty string when tesseract exits with an error', async () => {
    execFile.mockImplementation((_cmd, _args, cb) =>
      cb(new Error('tesseract failed'), '', 'Error: Cannot open input file')
    );
    const result = await ocrService.extractTextFromImage('/tmp/image.png');
    expect(result).toBe('');
  });

  test('passes the image path as first argument to tesseract', async () => {
    await ocrService.extractTextFromImage('/tmp/test.jpg');
    const [, args] = execFile.mock.calls[0];
    expect(args[0]).toBe('/tmp/test.jpg');
  });

  test('uses rus+eng language flags', async () => {
    await ocrService.extractTextFromImage('/tmp/test.jpg');
    const [, args] = execFile.mock.calls[0];
    expect(args).toContain('-l');
    expect(args).toContain('rus+eng');
  });

  test('cleans up the temp result file after extraction', async () => {
    await ocrService.extractTextFromImage('/tmp/image.png');
    expect(fs.promises.unlink).toHaveBeenCalled();
  });

  test('returns empty string when readFile throws (temp file missing)', async () => {
    fs.promises.readFile.mockRejectedValue(new Error('ENOENT'));
    const result = await ocrService.extractTextFromImage('/tmp/image.png');
    expect(result).toBe('');
  });
});

// ─── isAvailable ──────────────────────────────────────────────────────────

describe('OCRService.isAvailable', () => {
  test('returns true when tesseract --version outputs "tesseract"', async () => {
    execFile.mockImplementation((_cmd, _args, cb) =>
      cb(null, 'tesseract 4.1.1', '')
    );
    const result = await ocrService.isAvailable();
    expect(result).toBe(true);
  });

  test('returns true when version info is in stderr (some platforms)', async () => {
    execFile.mockImplementation((_cmd, _args, cb) =>
      cb(null, '', 'tesseract 5.0.0')
    );
    const result = await ocrService.isAvailable();
    expect(result).toBe(true);
  });

  test('returns false when tesseract is not found', async () => {
    execFile.mockImplementation((_cmd, _args, cb) =>
      cb(new Error('spawn ENOENT'), '', '')
    );
    const result = await ocrService.isAvailable();
    expect(result).toBe(false);
  });
});
