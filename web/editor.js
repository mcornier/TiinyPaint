'use strict';

// Éditeur d'image sur canvas : masque, restauration, tampon, recadrage, extension, annulation.
// La génération locale est préparée ici (prepareLocal) et réintégrée à travers le masque (commitLocal).

const MASK_COLOR = '#ff00ff';
const MAX_UNDO = 12;

function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function cloneCanvas(src) {
  const copy = makeCanvas(src.width, src.height);
  copy.getContext('2d').drawImage(src, 0, 0);
  return copy;
}

class Editor {
  constructor(view, { onChange }) {
    this.view = view;
    this.ctx = view.getContext('2d');
    this.onChange = onChange;
    this.tool = 'mask';
    this.brush = 64;
    this.feather = 16;
    this.showMask = true;
    this.cropRatio = null;
    this.crop = null;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.sourceImage = null;
    this.stampSource = null;
    this.previewImage = null;
    this.previewRegion = null;
    this.active = null;
    this.pointer = null;
    this.pending = false;
    this._bind();
  }

  /* ---------- Document ---------- */

  load(image) {
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    this.base = makeCanvas(w, h);
    this.base.getContext('2d').drawImage(image, 0, 0);
    this.mask = makeCanvas(w, h);
    this.origin = cloneCanvas(this.base);
    this.undoStack = [];
    this.redoStack = [];
    this.sourceImage = null;
    this.sourceCache = null;
    this.crop = null;
    this.stampSource = null;
    this.resetZoom();
    this._syncSize();
  }

  _syncSize() {
    this.view.width = this.base.width;
    this.view.height = this.base.height;
    this.tint = makeCanvas(this.base.width, this.base.height);
    this.sourceCache = null;
    this.redraw();
    this.onChange?.();
  }

  get width() { return this.base.width; }
  get height() { return this.base.height; }

  _snapshot() {
    return { base: cloneCanvas(this.base), mask: cloneCanvas(this.mask), origin: this.origin };
  }

  pushUndo() {
    this.undoStack.push(this._snapshot());
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.onChange?.();
  }

  _restore(snapshot) {
    const resized = snapshot.base.width !== this.base.width || snapshot.base.height !== this.base.height;
    Object.assign(this, snapshot);
    this.crop = null;
    if (resized) this._syncSize();
    else {
      this.redraw();
      this.onChange?.();
    }
  }

  undo() {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return;
    this.redoStack.push(this._snapshot());
    this._restore(snapshot);
  }

  redo() {
    const snapshot = this.redoStack.pop();
    if (!snapshot) return;
    this.undoStack.push(this._snapshot());
    this._restore(snapshot);
  }

  /* ---------- Outils de masque ---------- */

  clearMask() {
    this.pushUndo();
    this.mask.getContext('2d').clearRect(0, 0, this.width, this.height);
    this.redraw();
    this.onChange?.();
  }

  invertMask() {
    this.pushUndo();
    const inverted = makeCanvas(this.width, this.height);
    const ctx = inverted.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(this.mask, 0, 0);
    this.mask = inverted;
    this.redraw();
    this.onChange?.();
  }

  // Rectangle englobant du masque, ou null s'il est vide.
  maskBBox() {
    const { data } = this.mask.getContext('2d').getImageData(0, 0, this.width, this.height);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0, i = 3; y < this.height; y++) {
      for (let x = 0; x < this.width; x++, i += 4) {
        if (data[i] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  hasMask() {
    return !!this.maskBBox();
  }

  /* ---------- Source de restauration ---------- */

  setSource(image) {
    this.sourceImage = image;
    this.sourceCache = null;
  }

  // Source à la taille du document : l'origine suit les recadrages, une autre image est mise à l'échelle.
  _sourceCanvas() {
    if (!this.sourceImage) return this.origin;
    if (!this.sourceCache) {
      this.sourceCache = makeCanvas(this.width, this.height);
      this.sourceCache.getContext('2d').drawImage(this.sourceImage, 0, 0, this.width, this.height);
    }
    return this.sourceCache;
  }

  copySourceIntoMask() {
    if (!this.hasMask()) return false;
    this.pushUndo();
    const layer = makeCanvas(this.width, this.height);
    const ctx = layer.getContext('2d');
    ctx.drawImage(this._sourceCanvas(), 0, 0);
    this._applyMaskTo(ctx);
    this.base.getContext('2d').drawImage(layer, 0, 0);
    this.redraw();
    return true;
  }

  // Ne garde du calque que la zone du masque, avec le bord adouci.
  _applyMaskTo(ctx) {
    ctx.globalCompositeOperation = 'destination-in';
    if (this.feather > 0 && 'filter' in ctx) ctx.filter = `blur(${this.feather}px)`;
    ctx.drawImage(this.mask, 0, 0);
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---------- Géométrie ---------- */

  _transformAll(width, height, draw) {
    const apply = (src) => {
      const out = makeCanvas(width, height);
      draw(out.getContext('2d'), src);
      return out;
    };
    this.pushUndo();
    this.base = apply(this.base);
    this.mask = apply(this.mask);
    this.origin = apply(this.origin);
    this.crop = null;
    this._syncSize();
  }

  applyCrop() {
    const c = this.crop;
    if (!c || c.w < 32 || c.h < 32) return false;
    this._transformAll(Math.round(c.w), Math.round(c.h), (ctx, src) => ctx.drawImage(src, -Math.round(c.x), -Math.round(c.y)));
    return true;
  }

  rotate() {
    const w = this.width;
    const h = this.height;
    this._transformAll(h, w, (ctx, src) => {
      ctx.translate(h, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(src, 0, 0);
    });
  }

  flip() {
    const w = this.width;
    this._transformAll(w, this.height, (ctx, src) => {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(src, 0, 0);
    });
  }

  // Agrandit la toile d'un côté et masque la nouvelle zone, prête à être générée.
  extend(side, ratio = 0.25) {
    const dx = side === 'left' ? Math.round(this.width * ratio) : 0;
    const dy = side === 'top' ? Math.round(this.height * ratio) : 0;
    const w = this.width + (side === 'left' || side === 'right' ? Math.round(this.width * ratio) : 0);
    const h = this.height + (side === 'top' || side === 'bottom' ? Math.round(this.height * ratio) : 0);
    const oldW = this.width;
    const oldH = this.height;
    this._transformAll(w, h, (ctx, src) => ctx.drawImage(src, dx, dy));
    const ctx = this.mask.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.clearRect(dx, dy, oldW, oldH);
    this.redraw();
    this.onChange?.();
  }

  /* ---------- Génération locale ---------- */

  // Prépare les images à envoyer. Renvoie null si le masque est vide.
  prepareLocal({ side, wholeImage, keepContent, sizeFor }) {
    const box = this.maskBBox();
    if (!box) return null;
    let region = { x: 0, y: 0, w: this.width, h: this.height };
    if (!wholeImage) {
      const pad = Math.max(64, Math.round(Math.max(box.w, box.h) * 0.35));
      const x = Math.max(0, box.x - pad);
      const y = Math.max(0, box.y - pad);
      region = {
        x,
        y,
        w: Math.min(this.width, box.x + box.w + pad) - x,
        h: Math.min(this.height, box.y + box.h + pad) - y,
      };
    }
    const [w, h] = sizeFor(region.w / region.h, side);

    const scaled = (src) => {
      const out = makeCanvas(w, h);
      out.getContext('2d').drawImage(src, region.x, region.y, region.w, region.h, 0, 0, w, h);
      return out;
    };
    const image = scaled(this.base);
    const maskCrop = scaled(this.mask);

    const tinted = (alpha) => {
      const layer = cloneCanvas(maskCrop);
      const ctx = layer.getContext('2d');
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = MASK_COLOR;
      ctx.fillRect(0, 0, w, h);
      const out = cloneCanvas(image);
      const outCtx = out.getContext('2d');
      outCtx.globalAlpha = alpha;
      outCtx.drawImage(layer, 0, 0);
      return out;
    };

    const result = { region, width: w, height: h };
    if (keepContent) {
      const maskImage = makeCanvas(w, h);
      const ctx = maskImage.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      const white = cloneCanvas(maskCrop);
      const whiteCtx = white.getContext('2d');
      whiteCtx.globalCompositeOperation = 'source-in';
      whiteCtx.fillStyle = '#fff';
      whiteCtx.fillRect(0, 0, w, h);
      ctx.drawImage(white, 0, 0);
      result.image = image.toDataURL('image/png');
      result.maskImage = maskImage.toDataURL('image/png');
      result.marked = tinted(0.4).toDataURL('image/png');
    } else {
      result.image = tinted(1).toDataURL('image/png');
      result.marked = result.image;
    }
    return result;
  }

  setPreview(image, region) {
    this.previewImage = image;
    this.previewRegion = region;
    this.redraw();
  }

  clearPreview() {
    this.previewImage = null;
    this.previewRegion = null;
    this.redraw();
  }

  _maskedLayer(image, region) {
    const layer = makeCanvas(this.width, this.height);
    const ctx = layer.getContext('2d');
    ctx.drawImage(image, region.x, region.y, region.w, region.h);
    this._applyMaskTo(ctx);
    return layer;
  }

  // Réintègre le résultat à travers le masque : hors du masque, le document ne change pas.
  commitLocal(image, region) {
    this.pushUndo();
    this.base.getContext('2d').drawImage(this._maskedLayer(image, region), 0, 0);
    this.clearPreview();
  }

  // Sans masque : le résultat remplace toute l'image.
  commitWhole(image) {
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    const scaleOrigin = this.origin;
    this.pushUndo();
    this.base = makeCanvas(w, h);
    this.base.getContext('2d').drawImage(image, 0, 0);
    this.mask = makeCanvas(w, h);
    this.origin = makeCanvas(w, h);
    this.origin.getContext('2d').drawImage(scaleOrigin, 0, 0, w, h);
    this.previewImage = null;
    this._syncSize();
  }

  toBlob() {
    return new Promise((resolve) => this.base.toBlob(resolve, 'image/png'));
  }

  /* ---------- Vue ---------- */

  resetZoom() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this._applyView();
  }

  _applyView() {
    this.view.style.transform = this.zoom === 1 && !this.panX && !this.panY
      ? ''
      : `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }

  redraw() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this._paint();
    });
  }

  _paint() {
    if (!this.base) return;
    const { ctx } = this;
    const { width: w, height: h } = this.view;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.base, 0, 0);

    if (this.previewImage) {
      const hasMask = this.previewRegion.masked;
      ctx.drawImage(hasMask ? this._maskedLayer(this.previewImage, this.previewRegion) : this.previewImage, ...(hasMask ? [0, 0] : [0, 0, w, h]));
    } else if (this.showMask) {
      const tintCtx = this.tint.getContext('2d');
      tintCtx.globalCompositeOperation = 'source-over';
      tintCtx.clearRect(0, 0, w, h);
      tintCtx.drawImage(this.mask, 0, 0);
      tintCtx.globalCompositeOperation = 'source-in';
      tintCtx.fillStyle = MASK_COLOR;
      tintCtx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 0.45;
      ctx.drawImage(this.tint, 0, 0);
      ctx.globalAlpha = 1;
    }

    const lineWidth = Math.max(1.5, 2 * (w / this.view.getBoundingClientRect().width || 1));
    ctx.lineWidth = lineWidth;

    if (this.active?.type === 'lasso') {
      ctx.strokeStyle = MASK_COLOR;
      ctx.beginPath();
      this.active.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    if (this.active?.type === 'rect') {
      const r = this._rectFrom(this.active.start, this.active.end);
      ctx.strokeStyle = MASK_COLOR;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
    if (this.crop && this.tool === 'crop') {
      const c = this.crop;
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.beginPath();
      ctx.rect(0, 0, w, h);
      ctx.rect(c.x, c.y, c.w, c.h);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([lineWidth * 4, lineWidth * 3]);
      ctx.strokeRect(c.x, c.y, c.w, c.h);
      ctx.setLineDash([]);
    }
    if (this.stampSource && this.tool === 'stamp') {
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.arc(this.stampSource.x, this.stampSource.y, 8 * lineWidth, 0, Math.PI * 2);
      ctx.moveTo(this.stampSource.x - 12 * lineWidth, this.stampSource.y);
      ctx.lineTo(this.stampSource.x + 12 * lineWidth, this.stampSource.y);
      ctx.moveTo(this.stampSource.x, this.stampSource.y - 12 * lineWidth);
      ctx.lineTo(this.stampSource.x, this.stampSource.y + 12 * lineWidth);
      ctx.stroke();
    }
    if (this.pointer && ['mask', 'erase', 'restore', 'stamp'].includes(this.tool)) {
      ctx.beginPath();
      ctx.arc(this.pointer.x, this.pointer.y, this.brush / 2, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(this.pointer.x, this.pointer.y, this.brush / 2 + lineWidth, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.stroke();
    }
  }

  /* ---------- Pointeur ---------- */

  _point(event) {
    const rect = this.view.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * this.width,
      y: ((event.clientY - rect.top) / rect.height) * this.height,
    };
  }

  _rectFrom(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }

  _strokeStyle(type) {
    if (type === 'restore') return this.base.getContext('2d').createPattern(this._sourceCanvas(), 'no-repeat');
    return '#fff';
  }

  _stroke(target, style, from, to, composite = 'source-over') {
    const ctx = target.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = composite;
    ctx.strokeStyle = style;
    ctx.lineWidth = this.brush;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    // Un trait de longueur nulle ne dessine rien : on décale à peine pour marquer un simple clic.
    ctx.lineTo(to.x + (from.x === to.x && from.y === to.y ? 0.01 : 0), to.y);
    ctx.stroke();
    ctx.restore();
  }

  _down(event) {
    if (!this.base || this.disabled) return;
    if (event.button === 1 || (event.button === 0 && event.shiftKey)) {
      this.active = { type: 'pan', x: event.clientX, y: event.clientY, panX: this.panX, panY: this.panY };
      this.view.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    if (event.button !== 0) return;
    const p = this._point(event);
    this.view.setPointerCapture(event.pointerId);

    switch (this.tool) {
      case 'mask':
        this.pushUndo();
        this.active = { type: 'paint', target: this.mask, style: '#fff', composite: 'source-over', last: p };
        this._stroke(this.mask, '#fff', p, p);
        break;
      case 'erase':
        this.pushUndo();
        this.active = { type: 'paint', target: this.mask, style: '#fff', composite: 'destination-out', last: p };
        this._stroke(this.mask, '#fff', p, p, 'destination-out');
        break;
      case 'restore': {
        this.pushUndo();
        const style = this._strokeStyle('restore');
        this.active = { type: 'paint', target: this.base, style, composite: 'source-over', last: p };
        this._stroke(this.base, style, p, p);
        break;
      }
      case 'stamp': {
        if (event.altKey) {
          this.stampSource = p;
          this.active = null;
          break;
        }
        if (!this.stampSource) {
          this.onMessage?.('needStampSource');
          break;
        }
        this.pushUndo();
        // Le motif vient d'une copie figée : on ne reclone pas ce que le trait vient de peindre.
        const pattern = this.base.getContext('2d').createPattern(cloneCanvas(this.base), 'no-repeat');
        pattern.setTransform(new DOMMatrix().translate(p.x - this.stampSource.x, p.y - this.stampSource.y));
        this.active = { type: 'paint', target: this.base, style: pattern, composite: 'source-over', last: p };
        this._stroke(this.base, pattern, p, p);
        break;
      }
      case 'lasso':
        this.active = { type: 'lasso', points: [p] };
        break;
      case 'rect':
        this.active = { type: 'rect', start: p, end: p };
        break;
      case 'crop': {
        const c = this.crop;
        if (c && p.x > c.x && p.x < c.x + c.w && p.y > c.y && p.y < c.y + c.h) {
          this.active = { type: 'crop-move', dx: p.x - c.x, dy: p.y - c.y };
        } else {
          this.active = { type: 'crop-new', start: p };
          this.crop = null;
        }
        break;
      }
      default:
    }
    this.redraw();
  }

  _move(event) {
    if (!this.base) return;
    const p = this._point(event);
    this.pointer = p;
    const active = this.active;
    if (active) {
      switch (active.type) {
        case 'pan':
          this.panX = active.panX + event.clientX - active.x;
          this.panY = active.panY + event.clientY - active.y;
          this._applyView();
          break;
        case 'paint':
          for (const e of event.getCoalescedEvents?.() || [event]) {
            const q = this._point(e);
            this._stroke(active.target, active.style, active.last, q, active.composite);
            active.last = q;
          }
          break;
        case 'lasso':
          active.points.push(p);
          break;
        case 'rect':
          active.end = p;
          break;
        case 'crop-new': {
          let w = Math.abs(p.x - active.start.x);
          let h = Math.abs(p.y - active.start.y);
          if (this.cropRatio) {
            if (w / this.cropRatio > h) h = w / this.cropRatio;
            else w = h * this.cropRatio;
          }
          const x = p.x >= active.start.x ? active.start.x : active.start.x - w;
          const y = p.y >= active.start.y ? active.start.y : active.start.y - h;
          this.crop = this._clampRect({ x, y, w, h });
          break;
        }
        case 'crop-move':
          this.crop.x = Math.min(Math.max(0, p.x - active.dx), this.width - this.crop.w);
          this.crop.y = Math.min(Math.max(0, p.y - active.dy), this.height - this.crop.h);
          break;
        default:
      }
    }
    this.redraw();
  }

  _clampRect(r) {
    let { x, y, w, h } = r;
    const ratio = this.cropRatio;
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    w = Math.min(w, this.width - x);
    h = Math.min(h, this.height - y);
    if (ratio) {
      if (w / ratio > h) w = h * ratio;
      else h = w / ratio;
    }
    return { x, y, w, h };
  }

  _up() {
    const active = this.active;
    if (!active) return;
    this.active = null;
    if (active.type === 'lasso' && active.points.length > 2) {
      this.pushUndo();
      const ctx = this.mask.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      active.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
    } else if (active.type === 'rect') {
      const r = this._rectFrom(active.start, active.end);
      if (r.w > 2 && r.h > 2) {
        this.pushUndo();
        const ctx = this.mask.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
    }
    this.redraw();
    this.onChange?.();
  }

  _bind() {
    const view = this.view;
    view.addEventListener('pointerdown', (e) => this._down(e));
    view.addEventListener('pointermove', (e) => this._move(e));
    view.addEventListener('pointerup', () => this._up());
    view.addEventListener('pointercancel', () => this._up());
    view.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.redraw();
    });
    view.addEventListener('auxclick', (e) => e.preventDefault());
    view.parentElement.addEventListener('wheel', (e) => {
      if (!this.base || view.hidden) return;
      e.preventDefault();
      this.zoom = Math.min(8, Math.max(1, this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      if (this.zoom === 1) {
        this.panX = 0;
        this.panY = 0;
      }
      this._applyView();
      this.redraw();
    }, { passive: false });
  }
}
