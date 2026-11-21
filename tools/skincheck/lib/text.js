'use strict';

const { LIMITS, FIELDS, TEXT_DEFAULTS } = require('./constants');

/**
 * Text assembly, following SKINS.html "lines and fields".
 *
 * A piece is either a plain string (printed as written) or one of the five
 * field names (lower case, exact). A separator is kept only when it has a
 * field with content on both sides. Leading/trailing text is kept only when
 * the field beside it has content.
 */

const FIELD_NAMES = new Set(FIELDS);

function isFieldName(piece) {
  return typeof piece === 'string' && FIELD_NAMES.has(piece);
}

/** UTF-8 byte length, since the 47-byte limit is bytes, not characters. */
function utf8Bytes(s) {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Resolve one line definition to its printed string.
 *
 * track = { title, artist, album, track, playlist } where every value is a
 * string or null/undefined for "the track has nothing for this".
 */
function assembleLine(line, track) {
  const pieces = typeof line === 'string' ? [line] : line;
  if (!Array.isArray(pieces) || pieces.length === 0) return '';

  // Resolve every piece to { kind: 'field'|'text', value, has }.
  const slots = [];
  for (const raw of pieces.slice(0, LIMITS.pieces)) {
    if (isFieldName(raw)) {
      const value = track[raw];
      const text = value === undefined || value === null ? '' : String(value);
      slots.push({ kind: 'field', text, has: text.length > 0 });
    } else if (typeof raw === 'string' || typeof raw === 'number') {
      const text = String(raw);
      slots.push({ kind: 'text', text, has: text.length > 0 });
    } else {
      slots.push({ kind: 'text', text: '', has: false });
    }
  }

  // A line with no field at all is static text (a printed "SIDE A"); it is
  // printed as written, since there is no missing field to make it depend on.
  if (!slots.some((slot) => slot.kind === 'field')) {
    return slots.map((slot) => slot.text).join('');
  }

  const out = [];
  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    if (slot.kind === 'field') {
      if (slot.has) out.push(slot.text);
      continue;
    }
    // Text slot. It survives only under the rule in SKINS.html:
    //  - between two fields: both must have something;
    //  - before the first / after the last field: the field beside it must.
    // "Nearest field" rather than immediate neighbour, so runs of text and
    // empty fields in the middle behave the same way.
    const left = nearestField(slots, i, -1);
    const right = nearestField(slots, i, +1);
    const keep =
      left && right ? left.has && right.has
      : left ? left.has
      : right ? right.has
      : false;
    if (keep) out.push(slot.text);
  }

  return out.join('');
}

function nearestField(slots, from, dir) {
  for (let i = from + dir; i >= 0 && i < slots.length; i += dir) {
    if (slots[i].kind === 'field') return slots[i];
  }
  return null;
}

/**
 * Cut a string to fit inside maxBytes of UTF-8, appending "..." if needed.
 * The ellipsis is three ASCII dots, as SKINS.html describes.
 * It never splits a multi-byte character.
 */
function truncateToBytes(text, maxBytes) {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(text) <= maxBytes) return text;
  const dots = '...';
  let budget = maxBytes - utf8Bytes(dots);
  if (budget < 0) {
    // Not even room for the dots: cut the text itself, no ellipsis.
    return cutBytes(text, Math.max(0, maxBytes));
  }
  return cutBytes(text, budget) + dots;
}

function cutBytes(text, maxBytes) {
  let used = 0;
  let out = '';
  for (const ch of text) {
    const bytes = utf8Bytes(ch);
    if (used + bytes > maxBytes) break;
    out += ch;
    used += bytes;
  }
  return out;
}

module.exports = {
  assembleLine,
  truncateToBytes,
  cutBytes,
  utf8Bytes,
  isFieldName,
  TEXT_DEFAULTS,
};
