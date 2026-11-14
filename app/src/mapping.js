// PROVISIONAL: which eye gesture does what, per screen. One table so the mapping discussion is an
// edit here, not a code change. BOTH_CLOSED (eyes shut 2 s) is always stop / back, on every screen.
//
// Gestures: DOUBLE_BLINK, WINK_LEFT, WINK_RIGHT, HOLD_LEFT, HOLD_RIGHT (+ HOLD_END), BOTH_CLOSED
export const MAP = {
  home: {
    WINK_LEFT: 'prev', WINK_RIGHT: 'next', DOUBLE_BLINK: 'open',
  },
  talk: {
    WINK_LEFT: 'prev', WINK_RIGHT: 'next', DOUBLE_BLINK: 'say',
    HOLD_LEFT: 'quickPhrases', HOLD_RIGHT: 'newReplies',
  },
  drive: {
    DOUBLE_BLINK: 'goStop',          // first double blink asks to confirm; second one starts. Again = stop.
    WINK_LEFT: 'nudgeLeft', WINK_RIGHT: 'nudgeRight',   // short turn
    HOLD_LEFT: 'spinLeft', HOLD_RIGHT: 'spinRight',     // turn for as long as the eye stays closed
  },
  snake: { WINK_LEFT: 'turnLeft', WINK_RIGHT: 'turnRight', DOUBLE_BLINK: 'pause' },
  settings: { WINK_LEFT: 'prev', WINK_RIGHT: 'next', DOUBLE_BLINK: 'activate' },
};

// What the on-screen hints call each gesture
export const NAMES = {
  DOUBLE_BLINK: 'double blink', WINK_LEFT: 'wink left', WINK_RIGHT: 'wink right',
  HOLD_LEFT: 'hold left eye', HOLD_RIGHT: 'hold right eye', BOTH_CLOSED: 'close both eyes 2 s',
};

export function actionFor(screen, type) { return MAP[screen]?.[type] ?? null; }

// hint row for a screen: [gesture name, action label]
export function hints(screen, labels, enabled = {}) {
  const rows = Object.entries(MAP[screen] || {})
    .filter(([g]) => enabled[g] !== false)
    .map(([g, a]) => [NAMES[g], labels[a] || a]);
  rows.push([NAMES.BOTH_CLOSED, labels.back || 'back']);
  return rows;
}
