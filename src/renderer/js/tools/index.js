import { SELECT_TOOLS } from './select.js';
import { DRAW_TOOLS } from './draw.js';
import { SHAPE_TOOLS } from './shapes.js';
import { TEXT_TOOLS } from './text.js';
import { NAV_TOOLS } from './nav.js';

/** Ordered tool palette; `null` renders a separator in the tool strip. */
export const TOOL_GROUPS = [SELECT_TOOLS, DRAW_TOOLS, SHAPE_TOOLS, TEXT_TOOLS, NAV_TOOLS];
export const ALL_TOOLS = TOOL_GROUPS.flat();

export function toolById(id) { return ALL_TOOLS.find((T) => T.id === id) || null; }

export function toolByShortcut(key) {
  const k = key.toUpperCase();
  return ALL_TOOLS.find((T) => T.shortcut === k) || null;
}

export * from './select.js';
export * from './draw.js';
export * from './shapes.js';
export * from './text.js';
export * from './nav.js';
