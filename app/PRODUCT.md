# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- Primary: a person with ALS or Parkinson's-type motor loss who can still move their eyes and eyelids (sometimes winks), and nothing else reliably. They use it to move a small robot (Butter, standing in for a wheelchair) and to talk with the people around them.
- Secondary: the people they talk to (family, caregivers, nurses), who speak normally and can type a line on the keyboard when needed.
- Near term: hackathon judges watching a live demo by Anh's team (Anh, Carter, Mason).

## Product Purpose
Prove that a plain laptop webcam can replace thousands of dollars of eye-tracking hardware: calibrate in about 20 seconds, then drive a motorized vehicle and hold a spoken conversation using only eye gestures. Success: the person goes where they want and says what they mean, with no false moves.

## Positioning
Discrete eye gestures (look, blink, wink, hold) instead of a shaky gaze cursor, so a $0 webcam is reliable enough to steer a vehicle. Conversation replies are predicted from what the other person just said, most likely reply first, and spoken in the user's own (banked) ElevenLabs voice.

## Operating Context
- Electron desktop app on a MacBook; the user faces the built-in webcam.
- Butter: Jetson Orin Nano robot on the same network or Tailscale, motor server on port 8770, camera MJPEG on 5600.
- Stage first: projector or laptop in a bright venue, viewed by judges from several meters. Later: bedside or wheelchair, daily, often dim rooms.
- Every input is an eye gesture; the keyboard mirrors them as a caregiver/demo backup.

## Capabilities and Constraints
- Modes: Home (four directions), Drive, Talk (5 replies + quick phrases), Play (Snake), Settings, Calibration.
- Inputs are eyelid gestures only: double blink, wink left/right, hold left/right, both eyes closed 2 s (always stop). Normal blinks and gaze are never inputs. Gesture-to-action mapping is provisional (app/src/mapping.js).
- Safety: motors stop on face loss, 2 s eye close, disconnect, or 450 ms without a heartbeat.
- Per-person calibration (relaxed baseline + 5 reps per gesture) turns off gestures a person cannot do reliably. One user only (face lock).
- Final product name is undecided (team will pick an acronym). Use "Butter" as the placeholder.

## Evidence on Hand
- Automated test results (gesture engine jitter tests, live DeepSeek eval 5.0/5, ElevenLabs round trip, full Electron e2e).
- No user testimonials or clinical claims exist; do not invent any. The "12 million people" figure is from the team's pitch and is unverified.

## Product Principles
1. A false command is worse than a slow one.
2. The most likely choice is always where the eyes already are.
3. Readable from across a room: the person and the audience must see state at a glance.
4. The robot's state is never ambiguous: parked, ready, or moving.

## Accessibility & Inclusion
Targets large enough to read at 1-3 m; WCAG AA contrast minimum; state never conveyed by color alone; no time pressure on choices; motion kept calm (users may have fatigue or vision changes).
