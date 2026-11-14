# Butter: drive and talk with your eyes

Webcam-only eye control for people with ALS / Parkinson's. A 2-minute calibration learns your eyes; then you drive a robot (stand-in for a wheelchair) and hold a spoken conversation using deliberate eyelid gestures (double blink, winks, holds, eyes closed). No eye-tracking hardware.

```
butter-eyes/
  start.sh            one command to run everything on the Mac
  app/                Electron app (eye tracking, Drive, Talk, Play, Settings)
  butter-drive/       goes on the Jetson: motor server, bring-up check, camera stream
```

## Run it (Mac)

```bash
cd ~/Projects/butter-eyes && ./start.sh
```

* Uses the Jetson at `100.127.78.50:8770` if its drive server is up, otherwise starts a **mock robot** on the Mac so everything else still works (motor log: `tail -f /tmp/butter-mock.log`).
* `./start.sh --mock` forces the mock. `./start.sh --jetson 192.168.86.33` uses a specific IP.
* `./start.sh --test` runs the whole automated test suite.
* First launch: allow Camera and Microphone (System Settings, Privacy & Security, if it doesn't ask), then do the calibration.
* Keys live in `app/.env` (DeepSeek + ElevenLabs). Never commit it.

## Jetson (Butter)

Connect the Mac to the Jetson's USB-C port with a data cable: the Jetson is then always `192.168.55.1`, no Wi-Fi needed. (Tailscale `100.127.78.50` works too when both are online.)

```bash
# from the Mac: copy the robot code over and check it (nothing moves)
scp -r ~/Projects/butter-eyes/butter-drive anhdo001@192.168.55.1:~/Projects/
ssh anhdo001@192.168.55.1 '~/Projects/butter-drive/setup_jetson.sh'

# motor check, Butter ON BLOCKS: one wheel at a time, then whole-robot moves
ssh anhdo001@192.168.55.1 'cd ~/Projects/butter-drive && ~/Projects/butter/butter_env/bin/python3 jetson_check.py --wheel LF'
ssh anhdo001@192.168.55.1 'cd ~/Projects/butter-drive && ~/Projects/butter/butter_env/bin/python3 jetson_check.py --move forward'

# start the drive server + camera stream (SPEED=0.1-1.0, default 0.35)
ssh anhdo001@192.168.55.1 '~/Projects/butter-drive/run.sh'
```

Then `./start.sh` on the Mac finds Butter over the cable automatically.

Wiring (from `~/Projects/butter/config/motor.md` on the Jetson): wheels LF 11/13, LR 16/15 (reversed), RF 33/31, RR 29/18; L298N enable pins 12, 35, 7, 32 carry software PWM for speed and are LOW whenever stopped. Everything runs with `~/Projects/butter/butter_env/bin/python3` (that's where Jetson.GPIO works), no sudo needed.

## Inputs (eyelid gestures only)

Normal blinking and where you look are never inputs. Only these are:

| Gesture | What counts |
|---|---|
| Double blink | two slow, deliberate blinks, each longer than your natural blinks (natural blink pairs are ignored) |
| Wink left / right | one eye closed briefly while the other stays open |
| Hold left / right | one eye kept closed past your hold time (a ring fills on the eye display); fires while held |
| Raise eyebrows 4 s | turns eye control off / on, so you can blink freely when you're not giving commands |
| Close both eyes 3 s | always stop / back, on every screen |

What each gesture does per screen is provisional and lives in one table: `app/src/mapping.js`.
Right now: Home: wink to move, double blink to open. Talk: wink to pick between 3 replies (most likely in the middle), double blink to say it, hold left for quick phrases, hold right for new replies. Drive: double blink twice to go (confirm step); double blink or a long blink (0.5 s) to stop; you turn toward your open eye (close the left eye to turn right), wink for a short turn, hold to keep turning. The Drive screen has a sidebar (eye control on/off, mode) and Butter's camera on the right. Drive speed is in Settings.

Keyboard backup (caregiver / demo): Q / E or arrow keys = wink left/right, Space = double blink, hold A / D = hold left/right, S = long blink, B = eye control on/off, Esc = close both eyes, C = recalibrate.

## Calibration (about 1 minute, per person)

1. **Setup:** waits until there's one face, close enough, and no glare on glasses.
2. **Follow the circle (12 s):** blink normally. This learns what "no command" looks like for you: resting eyelids, natural blink length, glasses.
3. **Close both eyes** until the chime: your fully-closed reference.
4. **Each gesture twice,** while the ring around the circle fills: slow double blink, wink left, wink right, hold left, hold right, raise eyebrows.
5. **Report card:** the calibration recording is replayed through the fitted settings. Gestures that weren't reliable, or that fired while you were relaxed, are turned off.

How it handles different eyes:
- Each eye is measured two ways: MediaPipe's blink score, and lid gap divided by eye width (independent of eye size and distance).
- Both are scaled to your own open-to-closed range, per eye, and combined. Whichever reading was steadier at calibration counts more, so glasses glare on one reading is down-weighted automatically.
- It says "move closer" if your eyes are too few pixels, and warns about glare.
- If your eyes later look different from calibration (glasses on/off), it suggests recalibrating. It never quietly re-learns.

One user only: it locks onto the calibrated face, shows a small "Multiple faces detected" badge if someone else is in view, and pauses (Butter stops) only if it can't tell who is who.

## Safety (robot)

Motors stop when: the face is lost, eyes close 3 s (quick stop at 0.5 s while driving), the app or Wi-Fi drops (450 ms heartbeat watchdog on the Jetson, capped at 1 s), the controlling app disconnects, or the server exits. Reconnecting never resumes motion. Wink turns are timed in the main process so a busy UI can't stretch them.

## Test results (Nov 14)

* **Gesture engine + calibration (38 tests):** simulated people with glasses, small eyes, weak closure, droopy lids, partial winks and no winks, with realistic natural blinking (incl. quick natural pairs), noise, glare and dropped frames.
  * 2 x 10 minutes relaxed per person: **zero** commands.
  * 10,600 gestures: double blink 97%, winks 98-99%, holds and close-both 100% caught, **zero** confused for another gesture.
  * The report card turns on exactly what each person can do (e.g. "can't wink" gets double blink + close-both only).
  * Mirrored cameras, glasses taken off (recalibrate prompt), face loss mid-hold, one-frame dropouts.
* **Face lock:** caregiver leaning in, overlapping faces, user leaving and a different face staying, user returning.
* **Robot server (7 tests):** H-bridge never gets IN1+IN2 high; watchdog stops within 250-500 ms; disconnect stops instantly.
* **Live DeepSeek eval:** 12 scenarios with 3 replies each, graded 4.9-5.0 / 5, about 1 s each.
* **ElevenLabs:** voice to WAV to speech detection to Scribe round trip is word-exact.
* **Full app (Electron, headless), 20/20:** real MediaPipe on Anh's webcam frame (glasses), a real two-face image (locks the closer face, shows the badge), real voice into the mic transcribed exactly, every drive gesture checked against the robot's motor log, confirm step and its 3 s expiry, robot crash and reconnect, calibration refusing a still photo.

## Open items to confirm

1. **Jetson:** run the motor check on blocks (left-rear wheel had a hardware fault in July), plug in the USB speaker, join Wi-Fi.
2. **Real eyes:** gestures were tested on simulated people and a still photo, not live eyes yet. Calibrate each team member on the demo laptop under venue-like light and check the report cards.
3. **Mic at the venue:** noisy rooms can trigger speech detection; the caregiver text box is the fallback.
4. **Name / acronym:** placeholder "Butter".
5. **Pitch facts:** "12 million with Parkinson's or ALS" and "eyes are the last muscles to go" are unverified; check them before saying them on stage.

## Demo script (2 min)

1. Calibrate live (show the relax step and the report card: "these are the gestures this person can use").
2. Home: double blink Drive. Double blink twice: Butter rolls toward the judges. Wink to steer. Close eyes: it stops.
3. Close eyes again: Home. Wink to Talk, double blink. A teammate says "Do you want to watch a movie tonight?"; 3 replies appear about a second later; double blink, and it's spoken.
4. Point out: normal blinking and reading never trigger anything, and a second person walking into frame doesn't take over.
