# Design: Sunlit room

Chosen through Impeccable (Operate mode), Nov 14 2026.

**World:** a clean, sunlit room. White walls, pale oak, white linen. One butter-yellow lamp lights whatever the eyes have chosen; nothing else gets full colour.

**Signature move:** the lamp. The focused choice turns butter yellow and lifts, with a warm shadow pooling below it. Only one thing on a screen is ever lit.

**Rules carried from the directions it beat:**
- Only the selected thing burns brightest (from the transit-map direction).
- Every choice target is the same shape and height on every screen (`--target-h`), so the eyes learn one distance (from the botanical-folio direction).

**Tokens** (OKLCH, `src/styles.css`): wall 98.6% / oak 88% / linen white; ink 25%, ink-2 43%, ink-3 52% (5.3:1 minimum on wall); lamp 87% 0.16 92 with lamp-ink 11:1; go 51% (white text 5.1:1); stop 55%.

**Type:** Atkinson Hyperlegible Next (Braille Institute, designed for low vision), self-hosted 400/500/700/800. Headings 40px/800, choices 22–32px.

**Icons:** Lucide, inlined (`src/icons.js`). No emoji.

**State is never colour alone:** the robot badge always has words (Parked, Ready: look to move, Moving forward, Butter offline).

**Not yet designed:** a dim-room (bedside night) theme.
