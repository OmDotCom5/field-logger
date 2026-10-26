# Field Logger

The on-site half of the Acoustic Monitoring Software, for Android tablets (and iPads or phones) that can't run the Windows app. It runs in the tablet's browser, works **with no internet connection**, and keeps everything on the device.

On site it does what Tablet Mode does on the laptop: a timer started with the sound level meter, category buttons, notes, ranges, pauses, the exclude flag, and an audio recording as a timing reference. Afterwards it exports one `.zip` file. The Windows app imports that file as a live session, with its audio, ready to bind to the meter's file in the usual way. Everything from there on (alignment, statistics, field sheet, report) happens in the Windows app, unchanged.

## One-time setup

A browser only allows the microphone and offline use on a page from an `https://` address. So the folder has to be put online once, then installed on each tablet. After that the tablet never needs a connection to use it.

**1. Host the folder (once).** Any static HTTPS host works. With a free GitHub account:

1. Create a repository, e.g. `field-logger`, and upload every file in this folder (keep the `icons` folder).
2. In the repository: *Settings, Pages*, set *Source* to the `main` branch, root folder, and save.
3. After a minute the app is at `https://<your-username>.github.io/field-logger/`.

A company intranet server with HTTPS would work the same way and keep it in-house.

**2. Install on each tablet (once).** With a connection, open that address in Chrome, then *menu (⋮), Add to Home screen* (or *Install app*). Allow the microphone when first asked. From then on, open it from the home screen icon. It works in flight mode.

**Updates:** change the files on the host. Tablets pick up the new version the next time the app is opened with a connection.

## On site

1. Open Field Logger, type a name for the position if you like, and press **START LOGGING** at the same moment you start the meter.
2. Tap categories, type a note if you have time, and press **LOG MOMENT** (the time is taken the instant you tap). Use **START RANGE / END RANGE** for something that lasts, **Exclude** for anything that shouldn't count, and **Pause** to mark a break.
3. Tap an entry in the list to fix its note, categories or exclusion.
4. Press **Stop session** when the meter stops.

Keep the app on screen while logging. The screen stays awake, but switching to another app can stop the audio on some tablets. If the app is closed by accident, reopening it carries on the same session with every observation kept; tap **Resume audio** and the gap is filled with silence so the timing stays right.

## Back at the laptop

1. In Field Logger, press **Export** on the session. Share it (email, Drive, Nearby Share) or save it to Downloads, and get it onto the laptop.
2. In the Acoustic Monitoring Software, **Import** and choose the `.zip`. It appears as a live session with its observations and audio.
3. Import the meter's file and bind it to that session, as for a session logged on the laptop.

## The export file

| File | Contents |
|---|---|
| `session.amb` | The session in the Windows app's own backup format (gzip JSON) as a live session. Observation times are seconds from Start plus the matching wall-clock times. |
| `audio.wav` | 16-bit mono, 16 kHz. Its start time is `session.audio_start` in `session.amb`. About 2 MB per minute. |

## Files

| File | Purpose |
|---|---|
| `index.html` | The page and its layout |
| `app.js` | Logging, storage on the device, audio, export |
| `recorder-worklet.js` | Hands microphone samples to `app.js` |
| `sw.js` | Keeps a copy on the device so it opens offline |
| `manifest.webmanifest`, `icons/` | Lets it be installed to the home screen |

To try it on the laptop, run `.venv\Scripts\python.exe -m http.server 8765 --directory field_logger` from the `Code` folder and open `http://localhost:8765` (`localhost` counts as secure, so the microphone works). The desktop import is tested in `tests\test_field_logger.py` against an export made by this page.
