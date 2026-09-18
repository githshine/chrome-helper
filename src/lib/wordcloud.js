/**
 * Minimal dependency-free word cloud renderer.
 * Places words along an Archimedean spiral with rectangle collision detection.
 */

const PALETTES = {
  default: ['#2f6feb', '#1a7f37', '#9a6700', '#cf222e', '#8250df', '#0a7ea4', '#bc4c00'],
  cool: ['#0a7ea4', '#2f6feb', '#8250df', '#1a7f37', '#57606a'],
  warm: ['#cf222e', '#bc4c00', '#9a6700', '#8250df', '#d1242f']
};

const FONT_STACK = '"Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Hiragino Sans GB", sans-serif';

function overlaps(a, b, pad) {
  return !(
    a.x + a.w + pad < b.x ||
    b.x + b.w + pad < a.x ||
    a.y + a.h + pad < b.y ||
    b.y + b.h + pad < a.y
  );
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{text:string, weight:number, lang?:string}>} terms
 * @param {object} [opts]
 * @returns {Array} placed word boxes (CSS pixel coordinates) for hit testing
 */
export function renderWordCloud(canvas, terms, opts = {}) {
  const {
    minFontSize = 12,
    maxFontSize = 74,
    palette = 'default',
    rotateRatio = 0.12,
    padding = 2,
    background = null
  } = opts;

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.textBaseline = 'top';

  if (!terms.length) return [];

  const colors = PALETTES[palette] || PALETTES.default;
  const weights = terms.map((t) => t.weight);
  const maxWeight = Math.max(...weights);
  const minWeight = Math.min(...weights);
  const span = Math.max(1e-6, Math.sqrt(maxWeight) - Math.sqrt(minWeight));

  const placed = [];
  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.hypot(width, height) / 2;

  terms.forEach((term, index) => {
    const norm = (Math.sqrt(term.weight) - Math.sqrt(minWeight)) / span;
    const fontSize = Math.max(minFontSize, Math.round(minFontSize + norm * (maxFontSize - minFontSize)));
    const rotated = index > 0 && Math.random() < rotateRatio;
    ctx.font = `${fontSize >= 28 ? 700 : 500} ${fontSize}px ${FONT_STACK}`;
    const metrics = ctx.measureText(term.text);
    const textWidth = Math.ceil(metrics.width);
    const textHeight = Math.ceil(
      (metrics.actualBoundingBoxAscent || fontSize * 0.8) + (metrics.actualBoundingBoxDescent || fontSize * 0.25)
    );
    const boxW = rotated ? textHeight : textWidth;
    const boxH = rotated ? textWidth : textHeight;
    if (boxW > width || boxH > height) return;

    let angle = Math.random() * Math.PI * 2;
    let radius = 0;
    let box = null;
    const step = 0.35;
    const growth = Math.max(1.5, Math.min(width, height) / 90);

    while (radius < maxRadius) {
      const x = Math.round(cx + radius * Math.cos(angle) - boxW / 2);
      const y = Math.round(cy + radius * Math.sin(angle) * 0.62 - boxH / 2);
      const candidate = { x, y, w: boxW, h: boxH };
      const inBounds = x >= 0 && y >= 0 && x + boxW <= width && y + boxH <= height;
      if (inBounds && !placed.some((p) => overlaps(p, candidate, padding))) {
        box = candidate;
        break;
      }
      angle += step;
      radius += (growth * step) / (Math.PI * 2);
    }
    if (!box) return;

    const color = colors[index % colors.length];
    ctx.fillStyle = color;
    ctx.save();
    if (rotated) {
      ctx.translate(box.x, box.y + boxH);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(term.text, 0, 0);
    } else {
      ctx.fillText(term.text, box.x, box.y);
    }
    ctx.restore();

    placed.push({ ...box, term, fontSize, color, rotated });
  });

  return placed;
}

/** Find the word under a point, in CSS pixels relative to the canvas. */
export function hitTest(placed, x, y) {
  for (let i = placed.length - 1; i >= 0; i -= 1) {
    const p = placed[i];
    if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return p;
  }
  return null;
}
