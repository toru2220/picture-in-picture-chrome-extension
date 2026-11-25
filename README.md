# Picture-in-Picture Chrome Extension

A simple Chrome Extension to demonstrate the [Picture-in-Picture Web API](https://wicg.github.io/picture-in-picture/) in Chrome.

Get it on the Chrome Web Store at https://chrome.google.com/webstore/detail/hkgfoiooedgoejojocmhlaklaeopbecg

<img src="https://raw.githubusercontent.com/beaufortfrancois/picture-in-picture-chrome-extension/master/screenshot.png">

## Configuration

The keyboard shortcut (defaults to `Alt-P`) can be changed on the
Chrome Extension Shortcuts settings page:
chrome://extensions/shortcuts

## Playback speed

The shortcuts below match Video Speed Controller. They adjust the video on
the page, and they keep working inside the Picture-in-Picture window. The
window also has − / + buttons. The current speed sits at the top-left of the video, on the page and inside Picture-in-Picture, in large dark type on a translucent yellow badge. Click it to reset. Press `V` on the page to hide that badge.
A speed you set is applied again when the player loads the next video.

- `S` / `D` — slower / faster by 0.1×. Crossing 1× snaps to 1×.
- `R` — reset to 1×. Press again to restore the previous speed.
- `G` — preferred speed, 1.8×. Press again to restore.
- `Z` / `X` — rewind / advance 10 seconds.
- `M` / `J` — set a marker / jump back to it.
- `V` — show or hide the Picture-in-Picture controls.
