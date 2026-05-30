const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const os = require('os');

const execFilePromise = util.promisify(execFile);

class OCRService {
  constructor() {
    this.tesseractCmd = process.env.TESSERACT_CMD || 'tesseract';
  }

  async extractTextFromImage(imagePath) {
    try {
      console.log(`Extracting text from image: ${imagePath}`);

      try {
        await fs.access(imagePath);
      } catch (e) {
        throw new Error(`Image file not found: ${imagePath}`);
      }

      const tempDir = os.tmpdir();
      const tempBase = path.join(tempDir, `ocr_${Date.now()}_${Math.random().toString(36).slice(2)}`);
      const resultPath = `${tempBase}.txt`;

      try {
        const { stderr } = await execFilePromise(
          this.tesseractCmd,
          [imagePath, tempBase, '-l', 'rus+eng', '--psm', '3']
        );

        if (stderr && /error/i.test(stderr)) {
          console.warn('Tesseract stderr warning:', stderr.trim());
        }

        let text = '';
        try {
          text = await fs.readFile(resultPath, 'utf8');
        } catch (e) {
          console.warn('Could not read OCR result file:', e.message);
        }

        const cleanText = text ? text.trim() : '';
        console.log(`OCR extracted ${cleanText.length} characters from ${imagePath}`);
        return cleanText;
      } finally {
        try {
          await fs.unlink(resultPath);
        } catch {
        }
      }
    } catch (error) {
      console.error('OCR extraction failed:', error.message);
      return '';
    }
  }

  async isAvailable() {
    try {
      const { stdout, stderr } = await execFilePromise(this.tesseractCmd, ['--version']);
      return (stdout + stderr).toLowerCase().includes('tesseract');
    } catch (error) {
      console.warn('Tesseract not available:', error.message);
      return false;
    }
  }
}

module.exports = new OCRService();
