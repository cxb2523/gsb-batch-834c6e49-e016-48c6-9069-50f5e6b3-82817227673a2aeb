'use strict';

const { assembleLine, truncateToBytes, utf8Bytes } = require('./text');
const { fitLine, measure } = require('./metrics');
const { LIMITS, LIGHT_TEXT, DARK_TEXT, TEXT_DEFAULTS } = require('./constants');
const { luminance } = require('./color');

/*
 * Turn a converted Skin plus a track into the draw list the renderer consumes.
 *
 * The layout rule from SKINS.html: the lines are stacked as a block in the
 * middle of the area, top to bottom, each `size` + 2 px below the last. The
 * 2 px gap scales with the screen exactly as `size` does, which is why it lives
 * on the converted area rather than being a constant here.
 *
 * `samplePixel(x, y)` returns {r,g,b,a} for the (already decoded) picture in
 * screen space; it may be omitted, in which case an area with no explicit
 * colour gets the light-on-dark default.
 */

function autoColor(area, samplePixel) {
  if (!samplePixel) return DARK_TEXT;
  let light = 0;
  let dark = 0;
  const stepX = Math.max(1, Math.floor(area.rect.width / 16));
  const stepY = Math.max(1, Math.floor(area.rect.height / 8));
  for (let y = area.rect.y; y < area.rect.y + area.rect.height; y += stepY) {
    for (let x = area.rect.x; x < area.rect.x + area.rect.width; x += stepX) {
      const px = samplePixel(x, y);
      if (!px || (px.a !== undefined && px.a < 128)) continue;
      const lum = luminance(px);
      if (lum >= 0.5) light += 1;
      else dark += 1;
    }
  }
  if (light === 0 && dark === 0) return DARK_TEXT;
  return light > dark ? LIGHT_TEXT : DARK_TEXT;
}

/**
 * Layout one area.
 * @returns {{rect, color, lines: Array<{text,size,x,y,steps,truncated}>}}
 */
function layoutArea(area, track, samplePixel) {
  const color = area.color || autoColor(area, samplePixel);
  const lineGap = Number.isFinite(area.lineGap)
    ? area.lineGap
    : Math.max(1, Math.round(TEXT_DEFAULTS.lineGap * (area.size / TEXT_DEFAULTS.size)));

  const printable = [];
  for (const def of area.lines) {
    const text = assembleLine(def, track);
    if (text.length > 0) printable.push(text);
  }

  const sizes = printable.map(() => area.size);
  const totalHeight = printable.length === 0
    ? 0
    : printable.length * area.size + (printable.length - 1) * lineGap;

  // The area is laid out at its design position and the picture is clipped to
  // the screen, so a rect that runs off an edge keeps its text where the
  // design put it rather than sliding it inward. `designOrigin*` is the
  // unclipped screen-space rect; `rect` is the clipped one the renderer uses.
  const originX = Number.isFinite(area.designOriginX) ? area.designOriginX : area.rect.x;
  const originY = Number.isFinite(area.designOriginY) ? area.designOriginY : area.rect.y;
  const originW = Number.isFinite(area.designWidth) ? area.designWidth : area.rect.width;
  const originH = Number.isFinite(area.designHeight) ? area.designHeight : area.rect.height;

  // Start of the block, centred in the area. If the block is taller than the
  // area it starts at the top and the overflow is clipped by the renderer.
  let y = originY + Math.round((originH - totalHeight) / 2);

  const out = [];
  for (const text of printable) {
    const fitted = fitLine(text, area.size, originW, measure);
    let x = originX;
    const w = measure(fitted.text, fitted.size);
    if (area.align === 'center') x = originX + Math.round((originW - w) / 2);
    else if (area.align === 'right') x = originX + Math.round(originW - w);
    // No clamp: a rect that runs off the screen is cropped at the edge, so the
    // text keeps the position the design gave it and the clip does the trim.

    const clip = area.rect;
    const lineTop = Math.max(clip.y, y);
    const lineBottom = Math.min(clip.y + clip.height, y + Math.round(fitted.size));
    const lineLeft = Math.max(clip.x, x);
    const lineRight = Math.min(clip.x + clip.width, x + Math.round(w));
    if (lineBottom <= lineTop || lineRight <= lineLeft) {
      // Nothing of this line lands inside the area; skip it rather than emit a
      // line that draws outside its own box.
      y += Math.round(fitted.size) + lineGap;
      continue;
    }

    out.push({
      text: fitted.text,
      size: fitted.size,
      x,
      y,
      width: Math.round(w),
      steps: fitted.steps,
      truncated: fitted.truncated,
      clip,
      clipRect: {
        x: lineLeft,
        y: lineTop,
        width: lineRight - lineLeft,
        height: lineBottom - lineTop,
      },
    });
    y += Math.round(fitted.size) + lineGap;
  }

  return { rect: area.rect, color, lines: out };
}

/**
 * The complete draw list for a skin and track.
 * `screen` is used only to clip lines to the screen, which the area rect has
 * already been clipped to.
 */
function layoutSkin(skin, track, options = {}) {
  const areas = [];
  for (const area of skin.areas) {
    const laid = layoutArea(area, track, options.samplePixel);
    if (laid.lines.length > 0) areas.push(laid);
  }
  return { screen: skin.screen, areas };
}

module.exports = { layoutSkin, layoutArea, autoColor, LIMITS };
