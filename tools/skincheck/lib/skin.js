'use strict';

const {
  LIMITS,
  SCREENS,
  TEXT_DEFAULTS,
  BACKGROUND_DEFAULTS,
  FALLBACK_COLOR,
} = require('./constants');
const { parseColor, toHex } = require('./color');
const {
  resolveDesign,
  resolveScreen,
  scaleFor,
  convertRect,
  convertPixels,
  clamp,
  isFiniteNumber,
} = require('./geometry');
const { assembleLine, truncateToBytes, utf8Bytes } = require('./text');

/*
 * Load and validate skin.json, then convert it from its declared design
 * canvas to a concrete screen. SKINS.html's philosophy: never reject the file;
 * stop reading at a limit and ignore the rest. The one exception is JSON that
 * does not parse, which turns the skin into no-text/black.
 *
 * loadSkin(jsonText, { screen: 'psp'|'vita', measure }) -> Skin
 *
 * A Skin is the *converted* description: every pixel already in target-screen
 * space, plus the runtime inputs (track, playback) kept out of it.
 */

function emptySkin(screenKey, reason) {
  const screen = resolveScreen(screenKey);
  return {
    screen,
    design: SCREENS.psp,
    designDeclared: 'psp',
    scale: { x: 1, y: 1 },
    name: '',
    background: null,
    backgroundColor: FALLBACK_COLOR,
    areas: [],
    degraded: true,
    degradationReason: reason,
    warnings: [],
    limits: LIMITS,
  };
}

function normalizeLine(raw) {
  if (typeof raw === 'string') {
    return [truncatePiece(raw)];
  }
  if (!Array.isArray(raw)) return null;
  const pieces = [];
  for (const piece of raw.slice(0, LIMITS.pieces)) {
    if (typeof piece === 'string') {
      pieces.push(truncatePiece(piece));
    } else if (typeof piece === 'number' && Number.isFinite(piece)) {
      pieces.push(truncatePiece(String(piece)));
    } else {
      // Unknown JSON value inside a line: print nothing for it.
      pieces.push('');
    }
  }
  return pieces.length ? pieces : null;
}

function truncatePiece(s) {
  return utf8Bytes(s) > LIMITS.pieceBytes ? truncateToBytes(s, LIMITS.pieceBytes) : s;
}

function normalizeAlign(v) {
  return v === 'center' || v === 'right' ? v : 'left';
}

function normalizeSize(v, fallback) {
  return isFiniteNumber(v) && v >= 1 && v <= LIMITS.maxPixel ? v : fallback;
}

function normalizeBackground(raw, warnings) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    const color = parseColor(raw);
    if (!color) {
      warnings.push(`background "${raw}" is not #RRGGBB; using black`);
      return { kind: 'static', colors: [FALLBACK_COLOR] };
    }
    return { kind: 'static', colors: [toHex(color)] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push('background must be a color or an object; using black');
    return { kind: 'static', colors: [FALLBACK_COLOR] };
  }

  const colors = [];
  if (Array.isArray(raw.colors)) {
    for (const entry of raw.colors.slice(0, LIMITS.colors)) {
      const parsed = parseColor(entry);
      if (parsed) colors.push(toHex(parsed));
      else warnings.push(`background color ${JSON.stringify(entry)} is not #RRGGBB; ignored`);
    }
  }
  if (colors.length === 0) {
    warnings.push('background has no readable colors; using black');
    colors.push(FALLBACK_COLOR);
  }

  let seconds = raw.seconds;
  if (!isFiniteNumber(seconds)) {
    seconds = BACKGROUND_DEFAULTS.seconds;
  } else {
    seconds = clamp(seconds, 1, 3600);
  }
  const blend = raw.blend === 'step' ? 'step' : 'fade';
  const whileMode = raw.while === 'always' ? 'always' : 'playing';

  return { kind: 'cycle', colors, seconds, blend, while: whileMode };
}

/**
 * Core loader. `measure` is optional; only needed for fit reporting.
 */
function loadSkin(jsonText, options = {}) {
  const screenKey = options.screen || 'psp';
  const screen = resolveScreen(screenKey);

  if (typeof jsonText !== 'string') {
    return emptySkin(screenKey, 'no-json');
  }
  if (utf8Bytes(jsonText) > LIMITS.jsonBytes) {
    return emptySkin(screenKey, 'json-too-large');
  }

  let doc;
  try {
    doc = JSON.parse(jsonText);
  } catch (err) {
    return emptySkin(screenKey, `invalid-json: ${err.message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return emptySkin(screenKey, 'json-not-an-object');
  }

  const warnings = [];
  const design = resolveDesign(doc.design);
  if (design.warning) warnings.push(design.warning);
  const scale = scaleFor(design.canvas, screen);

  const background = normalizeBackground(doc.background, warnings);

  // Defaults apply to size/align/color only. rect and lines there are ignored.
  const defaults = doc.defaults && typeof doc.defaults === 'object' ? doc.defaults : {};
  const defSize = normalizeSize(defaults.size, TEXT_DEFAULTS.size);
  const defAlign = normalizeAlign(defaults.align);
  const defColor = parseColor(defaults.color);

  const areas = [];
  const rawAreas = Array.isArray(doc.areas) ? doc.areas.slice(0, LIMITS.areas) : [];
  if (Array.isArray(doc.areas) && doc.areas.length > LIMITS.areas) {
    warnings.push(`more than ${LIMITS.areas} areas; the rest are ignored`);
  }

  for (const rawArea of rawAreas) {
    if (!rawArea || typeof rawArea !== 'object' || Array.isArray(rawArea)) {
      warnings.push('an area is not an object; skipped');
      continue;
    }
    const rect = rawArea.rect;
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(isFiniteNumber)) {
      warnings.push('an area has no valid rect; skipped');
      continue;
    }
    // Clamp wild design coordinates before any arithmetic.
    const designRect = rect.map((n) => clamp(n, -LIMITS.maxPixel, LIMITS.maxPixel));
    const screenRect = convertRect(designRect, scale, screen);
    if (screenRect.skipped) {
      // Zero width/height is skipped; so is one entirely off-screen.
      continue;
    }

    const size = convertPixels(normalizeSize(rawArea.size, defSize), scale.y, 1);
    // The doc's "each size + 2 pixels below the last" is a design-space
    // quantity, so the gap scales with the screen exactly as size does.
    const lineGap = convertPixels(TEXT_DEFAULTS.lineGap, scale.y, 1);
    const align = rawArea.align !== undefined ? normalizeAlign(rawArea.align) : defAlign;
    const color = parseColor(rawArea.color) || defColor;

    const lines = [];
    const rawLines = Array.isArray(rawArea.lines) ? rawArea.lines.slice(0, LIMITS.lines) : [];
    if (Array.isArray(rawArea.lines) && rawArea.lines.length > LIMITS.lines) {
      warnings.push(`more than ${LIMITS.lines} lines in an area; the rest are ignored`);
    }
    for (const rawLine of rawLines) {
      const line = normalizeLine(rawLine);
      if (line) lines.push(line);
    }

    areas.push({
      rect: {
        x: screenRect.x,
        y: screenRect.y,
        width: screenRect.width,
        height: screenRect.height,
      },
      clipped: screenRect.clipped,
      designRect,
      // Unclipped screen-space geometry, kept so lines that begin off-screen
      // are laid out at their real position and then clipped, not relocated.
      designOriginX: Math.round(designRect[0] * scale.x),
      designOriginY: Math.round(designRect[1] * scale.y),
      designWidth: Math.round(designRect[2] * scale.x),
      designHeight: Math.round(designRect[3] * scale.y),
      size,
      lineGap,
      designSize: normalizeSize(rawArea.size, defSize),
      align,
      color: color ? toHex(color) : null,
      lines,
    });
  }

  return {
    screen,
    design: design.canvas,
    designDeclared: design.declared,
    scale,
    name: typeof doc.name === 'string' ? doc.name : '',
    background,
    backgroundColor: background ? background.colors[0] : FALLBACK_COLOR,
    areas,
    degraded: false,
    degradationReason: null,
    warnings,
    limits: LIMITS,
  };
}

module.exports = {
  loadSkin,
  emptySkin,
  normalizeLine,
  normalizeBackground,
  convertPixels,
};
