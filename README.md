# Butter: drive and talk with your eyes

Webcam-only eye control for people with ALS / Parkinson's. Calibrate in 20 seconds, then drive a robot (stand-in for a wheelchair) and hold a spoken conversation using look, blink, wink and "close eyes" gestures. No eye-tracking hardware.

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

## Bring up the Jetson (not done yet: confirm motors + camera)

```bash
# from the Mac
scp -r ~/Projects/butter-eyes/butter-drive butter:~/Projects/
ssh butter
cd ~/Projects/butter-drive && ./setup_jetson.sh
python3 jetson_check.py           # PUT BUTTER ON BLOCKS FIRST
```

`jetson_check.py` walks through: Python packages, other services holding the GPIO (stop the follow-me loop first), each wheel forward/back one at a time (asks you to confirm, tells you which pins to swap if one runs backwards), whole-robot moves, camera devices + MJPEG stream on :5600, and the speaker. It ends with a PASS/FAIL summary.

When it passes:
```bash
python3 server.py                  # motor server on :8770
python3 camera_server.py           # only if your existing camera stream isn't running
```
Then on the Mac `./start.sh` picks the Jetson up automatically. To start at boot later, see `butter-drive/butter-drive.service`.

## Using it

| Gesture | Home | Drive (Eyes only) | Talk |
|---|---|---|---|
| Look up/down/left/right (hold ~0.3 s) | pick a tile | move while held (up = forward, down = back, left/right = turn) | left/right: choose reply · up: new replies · down: quick phrases |
| Blink (0.35–1.2 s, deliberate) | open | start / park | say it |
| Double blink | | | repeat last thing said |
| Close eyes 2 s | | stop, then exit | home |

Other control styles (Settings): **Winks + blinks** (wink = turn, double blink = go/stop, matches the team's original idea) and **Clutch** (Carter's idea: hold one eye shut to drive, steer with the other, open both = instant stop). Keyboard mirrors every gesture for caregivers and as a demo backup: arrows, space, D, Esc, Q/E, Shift (clutch), C (recalibrate).

Talk: the mic listens; when someone speaks, ElevenLabs Scribe transcribes it, DeepSeek writes 5 replies in about 1.2 s, the most likely in the middle (where the eyes already rest). The chosen reply is spoken with ElevenLabs (or through Butter's speaker: Settings, Voice). A caregiver can also type what was said. "About me" in Settings and every reply the user picks teach the AI how they talk. A cloned voice ID makes it speak in the user's own voice.

## Why the jitter is gone

The old `eye_mouse.py` mapped gaze to a screen pixel. A webcam can't do better than about 125 px (its own calibration said so), so the cursor always shook. This app never places a cursor. It classifies a few deliberate gestures:

* MediaPipe blendshapes + iris position, One Euro filtered, whitened by your own calibration.
* Each direction must pass an enter threshold, beat the runner-up direction, and be held 280 ms; it releases only below a lower exit threshold (hysteresis). Noise inside that band can't fire anything.
* Gaze is ignored while the eyelids move (blinks drag the gaze estimate down), and the neutral point slowly re-centres to follow posture and lighting drift.
* Directions your camera can't tell apart get disabled at calibration instead of misfiring.

## Safety (robot)

Motors stop when: the face is lost, eyes close 2 s, the app or Wi-Fi drops (450 ms heartbeat watchdog on the Jetson, capped at 1 s), the controlling app disconnects, or the server exits. Reconnecting never resumes motion. Wink turns are timed in the main process so a busy UI can't stretch them.

## Test results (Nov 14)

* Gesture engine, 14 tests: 10 simulated minutes of relaxed staring with natural blinks, drift, spikes and dropped frames gives **zero** false commands (also at 1.5x noise); every gesture fires once, within 600 ms.
* Robot server, 7 tests: H-bridge never gets IN1+IN2 high; watchdog stops within 250–500 ms; disconnect stops instantly.
* Live DeepSeek eval: 12 real scenarios graded by a second model, **5.0 / 5**, about 1.2 s each; rule checks (yes and no offered, pain-scale spread, never answers its own question, no invented times) all pass.
* ElevenLabs: voice to WAV to VAD to Scribe round trip is word-exact; TTS about 0.2 s.
* Full app (Electron, headless): 18/18, run twice. Real MediaPipe on Anh's webcam frame (glasses on, 100% face detection), a real voice into the fake mic transcribed exactly, every drive profile checked against the robot's motor log, robot crash and reconnect, settings persistence, calibration refusing a face that never moves.

## Open items to confirm

1. **Jetson:** run `jetson_check.py`: wheel directions, the camera stream path on :5600, speaker card still `hw:2,0`.
2. **Real eyes:** only a photo has been tracked so far. Do 3–4 calibrations on the demo laptop under venue-like light and note the direction scores (aim for at least 4). Vertical gaze is the weakest on webcams; if up/down score low, use the Winks profile for driving.
3. **Mic at the venue:** noisy rooms can trigger speech detection; the caregiver text box is the fallback.
4. **Name / acronym:** placeholder "Butter".
5. **Pitch facts:** "12 million with Parkinson's or ALS" and "eyes are the last muscles to go" are unverified; check them before saying them on stage.

## Demo script (2 min)

1. Calibrate live (20 s). The result card shows how well each direction separates.
2. Home: look up, blink: Drive. Blink to arm, look up: Butter rolls toward the judges. Close eyes 2 s: it stops.
3. Close eyes again: Home. Look left, blink: Talk. A teammate says "Do you want to watch a movie tonight?"; replies appear about 1.5 s later; blink, and the reply is spoken.
4. Settings: show Winks and Clutch for different stages of the disease.
