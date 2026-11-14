// PROVISIONAL: which eye gesture does what, per screen. One table so the mapping discussion is an
// edit here, not a code change. BOTH_CLOSED (eyes shut 2 s) is always stop / back, on every screen.
//
// Gestures: DOUBLE_BLINK, WINK_LEFT, WINK_RIGHT, HOLD_LEFT, HOLD_RIGHT (+ HOLD_END), BOTH_CLOSED
// Everywhere: BROW_HOLD (eyebrows up ~1.5 s) turns eye control on / off. While driving, a long blink
// (0.5 s) is a quick stop.
export const MAP = {
  home: {
    BROW_TAP: 'next', WINK_LEFT: 'prev', WINK_RIGHT: 'next', DOUBLE_BLINK: 'open',
  },
  talk: {
    BROW_TAP: 'cycle', BROW_SELECT: 'say',   // the simple way: quick eyebrow raise = next option, hold 1 s = say it
    WINK_LEFT: 'prev', WINK_RIGHT: 'next', DOUBLE_BLINK: 'say',
    HOLD_LEFT: 'quickPhrases', // (hold right used to fetch new replies: removed, it fired by accident)
  },
  drive: {
    DOUBLE_BLINK: 'goStop',          // first double blink asks to confirm; second one starts. Again = stop.
    // You turn TOWARD YOUR OPEN EYE, so you can see where you're going (Mason's point):
    // closing the left eye turns right, closing the right eye turns left.
    WINK_LEFT: 'nudgeRight', WINK_RIGHT: 'nudgeLeft',   // short turn
    HOLD_LEFT: 'spinRight', HOLD_RIGHT: 'spinLeft',     // turn for as long as the eye stays closed
  },
  snake: { WINK_LEFT: 'turnLeft', WINK_RIGHT: 'turnRight', DOUBLE_BLINK: 'pause' },
  settings: { BROW_TAP: 'next', WINK_LEFT: 'prev', WINK_RIGHT: 'next', DOUBLE_BLINK: 'activate' },
};

// What the on-screen hints call each gesture
export const NAMES = {
  BROW_TAP: 'quick eyebrow raise', BROW_SELECT: 'hold eyebrows 1 s', DOUBLE_BLINK: 'double blink', WINK_LEFT: 'wink left', WINK_RIGHT: 'wink right',
  HOLD_LEFT: 'hold left eye', HOLD_RIGHT: 'hold right eye', BOTH_CLOSED: 'close both eyes 3 s', BROW_HOLD: 'raise eyebrows 4 s',
};

// How the menus (Home, Settings, Talk) are navigated: 'brow' = quick eyebrow raise moves on and
// winks do nothing; 'wink' = winks move and eyebrows do nothing (for people without eyebrow control).
// Double blink selects either way. Drive and Snake have their own controls and are not affected.
const MENUS = new Set(['home', 'settings', 'talk']);
const BROW_NAV = new Set(['BROW_TAP', 'BROW_SELECT']), WINK_NAV = new Set(['WINK_LEFT', 'WINK_RIGHT']);
let nav = 'brow';
export function setNav(style) { nav = style === 'wink' ? 'wink' : 'brow'; }
export const browMenus = (screen) => nav === 'brow' && MENUS.has(screen);
const off = (screen, g) => MENUS.has(screen) && (nav === 'brow' ? WINK_NAV.has(g) : BROW_NAV.has(g));

export function actionFor(screen, type) { return off(screen, type) ? null : MAP[screen]?.[type] ?? null; }

// hint row for a screen: [gesture name, action label]
export function hints(screen, labels, enabled = {}) {
  const rows = Object.entries(MAP[screen] || {})
    .filter(([g]) => enabled[g] !== false && !off(screen, g))
    .map(([g, a]) => [NAMES[g], labels[a] || a]);
  rows.push([NAMES.BOTH_CLOSED, labels.back || 'back']);
  return rows;
}
