// ─────────────────────────────────────────────────────────────
//  BitMask — Minimal QR Code Generator
// ─────────────────────────────────────────────────────────────
//  Generates QR codes for short alphanumeric strings (Peer IDs).
//  Supports Version 1–4, EC Level L, Alphanumeric mode.
//  Renders to an SVG string or Canvas element.
// ─────────────────────────────────────────────────────────────

const BitMaskQR = (() => {

  // ── Galois Field GF(256) with primitive polynomial 0x11D ───

  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x = (x << 1) ^ (x >= 128 ? 0x11D : 0);
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  // ── Reed-Solomon Error Correction ──────────────────────────

  function rsGenPoly(nsym) {
    let g = [1];
    for (let i = 0; i < nsym; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        ng[j] ^= g[j];
        ng[j + 1] ^= gfMul(g[j], GF_EXP[i]);
      }
      g = ng;
    }
    return g;
  }

  function rsEncode(data, nsym) {
    const gen = rsGenPoly(nsym);
    const msg = new Array(data.length + nsym).fill(0);
    for (let i = 0; i < data.length; i++) msg[i] = data[i];
    for (let i = 0; i < data.length; i++) {
      const coef = msg[i];
      if (coef !== 0) {
        for (let j = 0; j < gen.length; j++) {
          msg[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    return msg.slice(data.length);
  }

  // ── QR Version Parameters (EC Level L) ─────────────────────

  const VERSIONS = [
    null, // index 0 unused
    { size: 21, dataCodewords: 19, ecCodewords: 7, alnumCapacity: 25 },
    { size: 25, dataCodewords: 34, ecCodewords: 10, alnumCapacity: 47 },
    { size: 29, dataCodewords: 55, ecCodewords: 15, alnumCapacity: 77 },
    { size: 33, dataCodewords: 80, ecCodewords: 20, alnumCapacity: 114 },
  ];

  // ── Alphanumeric Encoding ──────────────────────────────────

  const ALNUM_TABLE = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

  function encodeAlphanumeric(str, version) {
    const bits = [];
    const push = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };

    // Mode indicator: 0010 (alphanumeric)
    push(0b0010, 4);
    // Character count (9 bits for V1–9)
    push(str.length, 9);

    // Encode pairs
    for (let i = 0; i < str.length; i += 2) {
      const a = ALNUM_TABLE.indexOf(str[i]);
      if (i + 1 < str.length) {
        const b = ALNUM_TABLE.indexOf(str[i + 1]);
        push(a * 45 + b, 11);
      } else {
        push(a, 6);
      }
    }

    // Terminator
    const v = VERSIONS[version];
    const totalDataBits = v.dataCodewords * 8;
    const termLen = Math.min(4, totalDataBits - bits.length);
    push(0, termLen);

    // Pad to byte boundary
    while (bits.length % 8 !== 0) bits.push(0);

    // Convert to bytes
    const bytes = [];
    for (let i = 0; i < bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] || 0);
      bytes.push(b);
    }

    // Pad to required data codewords
    const padBytes = [0xEC, 0x11];
    let padIdx = 0;
    while (bytes.length < v.dataCodewords) {
      bytes.push(padBytes[padIdx % 2]);
      padIdx++;
    }

    return bytes;
  }

  // ── Matrix Operations ──────────────────────────────────────

  function createMatrix(size) {
    return Array.from({ length: size }, () => new Int8Array(size)); // 0=unset, 1=black, -1=white
  }

  function setModule(matrix, row, col, black) {
    if (row >= 0 && row < matrix.length && col >= 0 && col < matrix.length) {
      matrix[row][col] = black ? 1 : -1;
    }
  }

  function placeFinderPattern(matrix, row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const inInner = r >= 1 && r <= 5 && c >= 1 && c <= 5;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        if (inCore) setModule(matrix, row + r, col + c, true);
        else if (inInner) setModule(matrix, row + r, col + c, false);
        else if (inOuter) setModule(matrix, row + r, col + c, true);
        else setModule(matrix, row + r, col + c, false); // separator
      }
    }
  }

  function placeAlignmentPattern(matrix, row, col) {
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const dist = Math.max(Math.abs(r), Math.abs(c));
        setModule(matrix, row + r, col + c, dist !== 1);
      }
    }
  }

  const ALIGNMENT_POSITIONS = [null, [], [6, 18], [6, 22], [6, 26]];

  function placeFixedPatterns(matrix, version) {
    const size = matrix.length;

    // Finder patterns
    placeFinderPattern(matrix, 0, 0);
    placeFinderPattern(matrix, 0, size - 7);
    placeFinderPattern(matrix, size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      if (matrix[6][i] === 0) setModule(matrix, 6, i, i % 2 === 0);
      if (matrix[i][6] === 0) setModule(matrix, i, 6, i % 2 === 0);
    }

    // Alignment patterns
    const positions = ALIGNMENT_POSITIONS[version] || [];
    for (const r of positions) {
      for (const c of positions) {
        if (matrix[r][c] === 0) placeAlignmentPattern(matrix, r, c);
      }
    }

    // Dark module
    setModule(matrix, (4 * version) + 9, 8, true);

    // Reserve format info areas
    for (let i = 0; i < 8; i++) {
      if (matrix[8][i] === 0) matrix[8][i] = -2; // reserved
      if (matrix[i][8] === 0) matrix[i][8] = -2;
      if (matrix[8][size - 1 - i] === 0) matrix[8][size - 1 - i] = -2;
      if (matrix[size - 1 - i][8] === 0) matrix[size - 1 - i][8] = -2;
    }
    if (matrix[8][8] === 0) matrix[8][8] = -2;
  }

  // ── Data Placement ─────────────────────────────────────────

  function placeData(matrix, dataBits) {
    const size = matrix.length;
    let bitIdx = 0;
    let upward = true;

    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip timing column

      const rows = upward
        ? Array.from({ length: size }, (_, i) => size - 1 - i)
        : Array.from({ length: size }, (_, i) => i);

      for (const row of rows) {
        for (const col of [right, right - 1]) {
          if (matrix[row][col] === 0) {
            const bit = bitIdx < dataBits.length ? dataBits[bitIdx] : 0;
            matrix[row][col] = bit ? 1 : -1;
            bitIdx++;
          }
        }
      }
      upward = !upward;
    }
  }

  // ── Masking ────────────────────────────────────────────────

  const MASK_FNS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ];

  function applyMask(matrix, maskIdx) {
    const size = matrix.length;
    const masked = matrix.map(row => Int8Array.from(row));
    const fn = MASK_FNS[maskIdx];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (Math.abs(masked[r][c]) === 1 && isDataModule(matrix, r, c)) {
          if (fn(r, c)) {
            masked[r][c] = masked[r][c] === 1 ? -1 : 1;
          }
        }
      }
    }
    return masked;
  }

  function isDataModule(matrix, r, c) {
    // Data modules are those that weren't set during fixed pattern placement
    // We detect by checking if the original matrix had the module as 0 before data placement
    // Since we can't track that easily, we use position-based detection
    const size = matrix.length;
    // Finder + separator zones
    if (r < 9 && c < 9) return false;
    if (r < 9 && c >= size - 8) return false;
    if (r >= size - 8 && c < 9) return false;
    // Timing
    if (r === 6 || c === 6) return false;
    // Format info
    if (r === 8 && (c < 9 || c >= size - 8)) return false;
    if (c === 8 && (r < 9 || r >= size - 8)) return false;
    return true;
  }

  function penaltyScore(matrix) {
    const size = matrix.length;
    let score = 0;

    // Rule 1: runs of same color
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (matrix[r][c] === matrix[r][c - 1]) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else {
          run = 1;
        }
      }
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) {
        if (matrix[r][c] === matrix[r - 1][c]) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else {
          run = 1;
        }
      }
    }

    // Rule 2: 2x2 blocks
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = matrix[r][c];
        if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) {
          score += 3;
        }
      }
    }

    return score;
  }

  // ── Format Information ─────────────────────────────────────

  // Pre-computed format info bits for EC Level L (00), masks 0–7
  const FORMAT_INFO = [
    0x77C4, 0x72F3, 0x7DAA, 0x789D, 0x662F, 0x6318, 0x6C41, 0x6976,
  ];

  function placeFormatInfo(matrix, maskIdx) {
    const size = matrix.length;
    const info = FORMAT_INFO[maskIdx];

    // Around top-left finder
    const bits = [];
    for (let i = 14; i >= 0; i--) bits.push((info >> i) & 1);

    const positions1 = [
      [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
      [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
    ];

    const positions2 = [
      [8, size - 1], [8, size - 2], [8, size - 3], [8, size - 4],
      [8, size - 5], [8, size - 6], [8, size - 7],
      [size - 7, 8], [size - 6, 8], [size - 5, 8], [size - 4, 8],
      [size - 3, 8], [size - 2, 8], [size - 1, 8],
    ];

    // Clear reserved
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (matrix[r][c] === -2) matrix[r][c] = -1;
      }
    }

    for (let i = 0; i < 15; i++) {
      const black = bits[i] === 1;
      const [r1, c1] = positions1[i];
      matrix[r1][c1] = black ? 1 : -1;
      if (i < positions2.length) {
        const [r2, c2] = positions2[i];
        matrix[r2][c2] = black ? 1 : -1;
      }
    }
  }

  // ── Main Encode Function ───────────────────────────────────

  function encode(text) {
    const str = text.toUpperCase();

    // Find suitable version
    let version = 0;
    for (let v = 1; v <= 4; v++) {
      if (str.length <= VERSIONS[v].alnumCapacity) { version = v; break; }
    }
    if (!version) throw new Error('Text too long for QR (max 114 alnum chars)');

    const v = VERSIONS[version];
    const dataBytes = encodeAlphanumeric(str, version);
    const ecBytes = rsEncode(dataBytes, v.ecCodewords);

    // Interleave data + EC (single block for V1–4 Level L)
    const allBytes = [...dataBytes, ...ecBytes];

    // Convert to bits
    const bits = [];
    for (const byte of allBytes) {
      for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
    }

    // Create matrix and place fixed patterns
    const matrix = createMatrix(v.size);
    placeFixedPatterns(matrix, version);
    placeData(matrix, bits);

    // Try all masks and pick lowest penalty
    let bestMask = 0;
    let bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      const masked = applyMask(matrix, m);
      const s = penaltyScore(masked);
      if (s < bestScore) { bestScore = s; bestMask = m; }
    }

    const result = applyMask(matrix, bestMask);
    placeFormatInfo(result, bestMask);

    return result;
  }

  // ── Render to SVG ──────────────────────────────────────────

  function toSVG(text, options = {}) {
    const {
      size = 200,
      margin = 4,
      darkColor = '#e8e8ed',
      lightColor = '#0a0a0f',
    } = options;

    const matrix = encode(text);
    const modules = matrix.length;
    const cellSize = (size - margin * 2) / modules;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`;
    svg += `<rect width="${size}" height="${size}" fill="${lightColor}" rx="8"/>`;

    for (let r = 0; r < modules; r++) {
      for (let c = 0; c < modules; c++) {
        if (matrix[r][c] === 1) {
          const x = margin + c * cellSize;
          const y = margin + r * cellSize;
          svg += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(cellSize + 0.5).toFixed(2)}" height="${(cellSize + 0.5).toFixed(2)}" fill="${darkColor}" rx="1"/>`;
        }
      }
    }

    svg += '</svg>';
    return svg;
  }

  // ── Render to Canvas ───────────────────────────────────────

  function toCanvas(text, canvas, options = {}) {
    const {
      size = 200,
      margin = 4,
      darkColor = '#e8e8ed',
      lightColor = '#0a0a0f',
    } = options;

    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const matrix = encode(text);
    const modules = matrix.length;
    const cellSize = (size - margin * 2) / modules;

    ctx.fillStyle = lightColor;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = darkColor;

    for (let r = 0; r < modules; r++) {
      for (let c = 0; c < modules; c++) {
        if (matrix[r][c] === 1) {
          ctx.fillRect(
            margin + c * cellSize,
            margin + r * cellSize,
            cellSize + 0.5,
            cellSize + 0.5
          );
        }
      }
    }
  }

  return { encode, toSVG, toCanvas };
})();
