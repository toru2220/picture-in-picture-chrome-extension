// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Picture-in-Picture follows one HTMLVideoElement. Players such as YouTube
// swap that element, or pause it and start another, without changing its box
// size — so a ResizeObserver on the original video never runs and the PiP
// window stays on the last painted frame. While a session is open, retarget
// it when a comparable video is the one actually playing.

var PIP_STUCK_MS = 2000;
var PIP_MIN_REPLACEMENT_RATIO = 0.5;
var PIP_LARGER_RATIO = 1.2;
var PIP_HEARTBEAT_MS = 500;
// A few percent of slack so near-identical ratios (1920x1080 vs 1280x720)
// do not take the letterbox path.
var PIP_ASPECT_SLACK = 0.03;
var PIP_CANVAS_LONG_SIDE = 1280;
var PIP_MAX_TILES = 4;
// Same limits and default steps as Video Speed Controller. Relative changes
// snap to 1x when they cross it, so 1.1x slower lands on 1x rather than 0.9x.
var PIP_SPEED_MIN = 0.07;
var PIP_SPEED_MAX = 16;
var PIP_SPEED_STEP = 0.1;
var PIP_SPEED_RESET = 1;
var PIP_SPEED_FAST = 1.8;
// Same yellow as the solid badge, at half opacity so the picture shows through.
var PIP_SPEED_BADGE_BG = 'rgba(255,225,74,.5)';
var PIP_SEEK_STEP = 10;
// One mouse-wheel notch is about 100 pixels. That jumps five seconds.
var PIP_WHEEL_SEEK_STEP = 5;
var PIP_SPEED_KEYS = {
  KeyS: 'slower',
  KeyD: 'faster',
  KeyR: 'reset',
  KeyZ: 'rewind',
  KeyX: 'advance',
  KeyG: 'fast',
  KeyV: 'display',
  KeyM: 'mark',
  KeyJ: 'jump'
};
var PIP_ICON_ON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4zm11.5 3a3.5 3.5 0 0 0-2-3.16v6.32A3.5 3.5 0 0 0 15.5 12z"/></svg>';
var PIP_ICON_OFF = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4zm12.2.8 4 4-1.4 1.4-4-4 1.4-1.4zm-2.8 2.8 1.4 1.4-4 4-1.4-1.4 4-4z"/></svg>';
var PIP_ICON_PLAY = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
var PIP_ICON_PAUSE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';

function pipState() {
  if (globalThis.__pipSession) return globalThis.__pipSession;
  globalThis.__pipSession = {
    installed: false,
    requesting: null,
    scheduled: false,
    heartbeat: 0,
    observingDom: false,
    observed: new Set(),
    lastArea: 0,
    progressVideo: null,
    progressTime: 0,
    progressAt: 0,
    failedVideo: null,
    failedUntil: 0,
    suppressUntil: 0,
    lockedAspect: 0,
    letterboxBlocked: false,
    pipHandoff: false,
    letterboxSource: null,
    letterboxTimer: 0,
    proxyVideo: null,
    proxyCanvas: null,
    proxyCtx: null,
    proxyStream: null,
    proxyTrack: null,
    sourceCapture: null,
    captureSource: null,
    documentPipSource: null,
    pipStage: null,
    parkedVideo: null,
    volume: null,
    muted: false,
    volumePinned: false,
    volumeDefendTimers: null,
    volumeDefendFor: null,
    speed: null,
    speedBeforeReset: null,
    applyingSpeed: false,
    speedDefendTimers: null,
    speedDefendFor: null,
    speedSource: null,
    onRateChange: null,
    speedLabel: null,
    pageSpeedBadge: null,
    pageSpeedHidden: false,
    pageSpeedTimer: 0,
    controlsForce: null,
    pointerInside: false,
    controlsFlash: 0,
    lastAudible: 1,
    applyingVolume: false,
    volumeSource: null,
    onVolumeChange: null,
    volumeSlider: null,
    volumeMute: null,
    playButton: null,
    playbackSource: null,
    onPlay: null,
    onPause: null,
    seekSlider: null,
    seekTime: null,
    seekBar: null,
    seeking: false,
    seekApplyTimer: 0,
    seekVideo: null,
    seekTarget: null,
    seekSource: null,
    onTimeUpdate: null,
    closingDocumentPip: false,
    resizeObserver: null,
    mutationObserver: null,
    guestActive: false,
    guestVideo: null,
    guestPc: null,
    guestStream: null,
    guestHidden: null,
    guestPeers: null,
    pendingGuestAdds: null,
    pipGrid: null,
    pipHostTile: null,
    hostClaimed: false,
    documentPipOwned: false,
    pipPort: null,
    messenger: false,
    hostEvicted: false,
    tileOrder: null,
    nativeOnly: false,
  };
  return globalThis.__pipSession;
}

function videoArea(video) {
  var rect = video.getClientRects()[0];
  if (!rect) return 0;
  return rect.width * rect.height;
}

function isPlaying(video) {
  return !!video &&
    video.isConnected &&
    !video.paused &&
    !video.ended &&
    video.readyState >= 2 &&
    video.disablePictureInPicture == false &&
    videoArea(video) > 0;
}

// True when playback is reported as active but the playhead has not moved.
// YouTube sometimes leaves the previous element unpaused after detaching its
// media, so `paused` alone does not reveal a frozen PiP source.
function isStuck(video) {
  var state = pipState();
  var now = performance.now();
  if (state.progressVideo !== video) {
    state.progressVideo = video;
    state.progressTime = video.currentTime;
    state.progressAt = now;
    return false;
  }
  if (Math.abs(video.currentTime - state.progressTime) > 0.05) {
    state.progressTime = video.currentTime;
    state.progressAt = now;
    return false;
  }
  return now - state.progressAt > PIP_STUCK_MS;
}

function isCurrentLive(video) {
  if (!isPlaying(video)) {
    // A pause must not count toward the stalled-playback timer, or resuming
    // would look like a freeze and could steal PiP.
    var state = pipState();
    if (state.progressVideo === video) state.progressVideo = null;
    return false;
  }
  if (video.seeking) {
    var seekingState = pipState();
    seekingState.progressVideo = video;
    seekingState.progressTime = video.currentTime;
    seekingState.progressAt = performance.now();
    return true;
  }
  return !isStuck(video);
}

function isProxy(video) {
  return !!(video && video.hasAttribute && video.hasAttribute('__pip_proxy__'));
}

function pageVideos() {
  return Array.from(document.querySelectorAll('video')).filter(function (video) {
    return !isProxy(video);
  });
}

function findLargestPlayingVideo() {
  var videos = pageVideos()
    .filter(function (video) { return video.readyState != 0; })
    .sort(function (a, b) { return videoArea(b) - videoArea(a); });
  return videos[0];
}

// Document PiP moves the element into another document. Encrypted playback and
// a page that opts out of PiP cannot follow that path.
function needsNativePip(video) {
  if (!video) return false;
  if (video.disablePictureInPicture) return true;
  if (video.mediaKeys || video.webkitKeys) return true;
  return false;
}

function findReplacementVideo(current, currentLive) {
  var videos = pageVideos().filter(function (video) {
    if (!isPlaying(video)) return false;
    if (!currentLive && video === current) return false;
    return true;
  }).sort(function (a, b) { return videoArea(b) - videoArea(a); });
  return videos[0];
}

function videoAspect(video) {
  if (!video || !video.videoWidth || !video.videoHeight) return 0;
  return video.videoWidth / video.videoHeight;
}

function aspectsDiffer(locked, aspect) {
  if (!locked || !aspect) return false;
  return Math.abs(locked - aspect) / locked > PIP_ASPECT_SLACK;
}

function evenSize(n) {
  n = Math.round(n);
  if (n < 2) return 2;
  return n % 2 === 0 ? n : n - 1;
}

function canvasSizeForAspect(aspect) {
  var width;
  var height;
  if (aspect >= 1) {
    width = PIP_CANVAS_LONG_SIDE;
    height = evenSize(PIP_CANVAS_LONG_SIDE / aspect);
  } else {
    height = PIP_CANVAS_LONG_SIDE;
    width = evenSize(PIP_CANVAS_LONG_SIDE * aspect);
  }
  return { width: width, height: height };
}

function shouldSwitchPipVideo(current, candidate, currentLive) {
  if (!candidate || candidate === current) return false;
  var candidateArea = videoArea(candidate);
  var currentArea = videoArea(current);
  var reference = currentArea > 0 ? currentArea : pipState().lastArea;

  if (!currentLive) {
    // Ignore hover-preview videos while the main player is paused or stalled.
    if (reference > 0) return candidateArea >= reference * PIP_MIN_REPLACEMENT_RATIO;
    return candidateArea >= window.innerWidth * window.innerHeight * 0.15;
  }
  return candidateArea > currentArea * PIP_LARGER_RATIO;
}

function notePipSize(video) {
  if (!video || video.ownerDocument !== document) return;
  var area = videoArea(video);
  if (area > 0) pipState().lastArea = area;
}

function markPipVideo(video) {
  var marked = document.querySelectorAll('[__pip__]');
  for (var i = 0; i < marked.length; i++) {
    if (marked[i] !== video) marked[i].removeAttribute('__pip__');
  }
  video.setAttribute('__pip__', 'true');
  notePipSize(video);
}

function documentPipWindow() {
  var api = globalThis.documentPictureInPicture;
  if (!api || !api.window) return null;
  return api.window;
}

function extensionPipOpen() {
  return !!(document.pictureInPictureElement || documentPipWindow());
}

function isTopFrame() {
  try {
    return window.top === window;
  } catch (e) {
    return false;
  }
}

function pipWindowSize(aspect) {
  var longSide = 480;
  if (!aspect || aspect <= 0) aspect = 16 / 9;
  if (aspect >= 1) {
    return { width: longSide, height: Math.max(1, Math.round(longSide / aspect)) };
  }
  return { width: Math.max(1, Math.round(longSide * aspect)), height: longSide };
}

function paintVolumeControls() {
  var state = pipState();
  if (state.volumeSlider) {
    var shown = state.muted ? 0 : state.volume;
    state.volumeSlider.value = String(shown == null ? 1 : shown);
  }
  if (!state.volumeMute) return;
  var silent = !!state.muted || !(state.volume > 0);
  state.volumeMute.innerHTML = silent ? PIP_ICON_OFF : PIP_ICON_ON;
  state.volumeMute.setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
}

function readVolume(source) {
  var state = pipState();
  state.volume = source.muted ? 0 : source.volume;
  state.muted = !!(source.muted || source.volume === 0);
  if (source.volume > 0) state.lastAudible = source.volume;
  paintVolumeControls();
}

// True when the media element already has the level chosen in the PiP controls.
// A muted session keeps the previous audible level so unmute can restore it,
// unless the slider itself was dragged to zero.
function volumeMatches(source, state) {
  if (!source || state.volume == null) return false;
  if (state.muted) {
    if (!source.muted) return false;
    if (!(state.volume > 0) && source.volume > 0.001) return false;
    return true;
  }
  var want = state.volume > 0 ? state.volume : (state.lastAudible || 1);
  return !source.muted && Math.abs(source.volume - want) < 0.02;
}

function assignVolume(source) {
  var state = pipState();
  if (!source || state.volume == null) return;
  state.applyingVolume = true;
  try {
    source.muted = !!state.muted;
    if (state.muted) {
      if (!(state.volume > 0)) source.volume = 0;
    } else {
      source.volume = state.volume > 0 ? state.volume : (state.lastAudible || 1);
    }
    applyPlayerVolume(source, state);
  } catch (e) {}
  state.applyingVolume = false;
}

// YouTube keeps its own level and will undo a change made only on the media
// element. The player that still contains the video accepts the same level.
function applyPlayerVolume(source, state) {
  var node = source && source.parentElement;
  var level = state.muted ? 0 : source.volume;
  for (var i = 0; node && i < 8; i++) {
    if (typeof node.setVolume === 'function') {
      if (state.muted && typeof node.mute === 'function') node.mute();
      else if (!state.muted && typeof node.unMute === 'function') node.unMute();
      node.setVolume(Math.round((level || 0) * 100));
      return;
    }
    node = node.parentElement;
  }
}

function clearVolumeDefend() {
  var state = pipState();
  var timers = state.volumeDefendTimers;
  if (timers) {
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
  }
  state.volumeDefendTimers = null;
}

// Players often apply their own volume when the next video starts, after PiP
// has already muted the element. Re-apply the pinned level for a short window
// so that reset does not stick. A burst already in flight for this element is
// left alone; volumechange still corrects the element immediately.
function defendPinnedVolume(source) {
  var state = pipState();
  if (!state.volumePinned || !source) return;
  if (state.volumeDefendFor === source && state.volumeDefendTimers) return;
  clearVolumeDefend();
  state.volumeDefendFor = source;
  var delays = [0, 120, 360, 900, 1800];
  var timers = [];
  state.volumeDefendTimers = timers;
  delays.forEach(function (delay, index) {
    timers.push(setTimeout(function () {
      var session = pipState();
      if (session.volumeDefendTimers !== timers) return;
      if (session.volumePinned && session.volumeSource === source && !volumeMatches(source, session)) {
        assignVolume(source);
        paintVolumeControls();
      }
      if (index === delays.length - 1 && session.volumeDefendTimers === timers) {
        session.volumeDefendTimers = null;
      }
    }, delay));
  });
}

function writeVolume(source) {
  var state = pipState();
  if (!source) return;
  if (state.volume == null) {
    if (!state.volumePinned) {
      readVolume(source);
      return;
    }
    state.volume = state.muted ? 0 : (state.lastAudible || 1);
  }
  assignVolume(source);
  paintVolumeControls();
  if (state.volumePinned) defendPinnedVolume(source);
}

function clampSpeed(speed) {
  var next = Math.min(PIP_SPEED_MAX, Math.max(PIP_SPEED_MIN, speed));
  return Number(next.toFixed(2));
}

function shownRate(video) {
  var state = pipState();
  var rate = state.speed != null ? state.speed : (video && video.playbackRate) || 1;
  if (!isFinite(rate) || rate < 0) rate = 1;
  return Number(rate.toFixed(2));
}

function speedText(video) {
  return shownRate(video).toFixed(2) + '\u00d7';
}

function paintSpeed() {
  var state = pipState();
  if (state.speedLabel) {
    state.speedLabel.textContent = speedText(state.documentPipSource || state.speedSource);
  }
  placePageSpeedBadge();
}

// The page video keeps its own badge. Document PiP moves that element into
// another window, which already has the same badge, so the page one hides.
function pageSpeedVideo() {
  var state = pipState();
  if (state.pageSpeedHidden || state.guestActive || documentPipWindow()) return null;
  var video = speedTarget();
  if (!video || isProxy(video) || !video.isConnected || video.ownerDocument !== document) return null;
  return video;
}

function ensurePageSpeedBadge() {
  var state = pipState();
  if (state.pageSpeedBadge) return state.pageSpeedBadge;
  var parent = document.documentElement || document.body;
  if (!parent) return null;
  var badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'pip-page-speed';
  badge.setAttribute('aria-label', 'Reset speed');
  badge.title = 'Reset speed (R)';
  badge.style.cssText = [
    'position:fixed',
    'z-index:2147483646',
    'margin:0',
    'min-width:3.2em',
    'border:0',
    'border-radius:8px',
    'padding:6px 10px',
    'background:' + PIP_SPEED_BADGE_BG,
    'color:#1a1a1a',
    '-webkit-appearance:none',
    'appearance:none',
    'font:700 22px/1 system-ui,sans-serif',
    'cursor:pointer',
    'box-shadow:0 1px 4px rgba(0,0,0,.35)',
    'display:none'
  ].join(';');
  badge.addEventListener('pointerdown', function (event) { event.stopPropagation(); });
  badge.addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    toggleSpeed(speedTarget(), PIP_SPEED_RESET, PIP_SPEED_FAST);
  });
  parent.appendChild(badge);
  state.pageSpeedBadge = badge;
  return badge;
}

function placePageSpeedBadge() {
  var badge = ensurePageSpeedBadge();
  if (!badge) return;
  var video = pageSpeedVideo();
  if (!video) {
    badge.style.display = 'none';
    return;
  }
  var rect = video.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 68) {
    badge.style.display = 'none';
    return;
  }
  badge.style.display = 'inline-block';
  badge.style.top = Math.round(rect.top + 10) + 'px';
  badge.style.left = Math.round(rect.left + 10) + 'px';
  badge.textContent = speedText(video);
}

function assignSpeed(source) {
  var state = pipState();
  if (!source || state.speed == null) return;
  state.applyingSpeed = true;
  try { source.playbackRate = state.speed; } catch (e) {}
  state.applyingSpeed = false;
}

function clearSpeedDefend() {
  var state = pipState();
  var timers = state.speedDefendTimers;
  if (timers) {
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
  }
  state.speedDefendTimers = null;
}

// Players write 1x again when the next video starts. Re-apply the chosen
// rate for a short window, and keep correcting later ratechange events.
function defendPinnedSpeed(source) {
  var state = pipState();
  if (state.speed == null || !source) return;
  if (state.speedDefendFor === source && state.speedDefendTimers) return;
  clearSpeedDefend();
  state.speedDefendFor = source;
  var delays = [0, 120, 360, 900, 1800];
  var timers = [];
  state.speedDefendTimers = timers;
  delays.forEach(function (delay, index) {
    timers.push(setTimeout(function () {
      var session = pipState();
      if (session.speedDefendTimers !== timers) return;
      if (session.speed != null && session.speedSource === source &&
          Math.abs(source.playbackRate - session.speed) >= 0.001) {
        assignSpeed(source);
        paintSpeed();
      }
      if (index === delays.length - 1 && session.speedDefendTimers === timers) {
        session.speedDefendTimers = null;
      }
    }, delay));
  });
}

function unbindSpeed(state) {
  if (!state.speedSource || !state.onRateChange) {
    state.speedSource = null;
    state.onRateChange = null;
    return;
  }
  state.speedSource.removeEventListener('ratechange', state.onRateChange);
  state.speedSource.removeEventListener('play', state.onRateChange);
  state.speedSource.removeEventListener('playing', state.onRateChange);
  state.speedSource.removeEventListener('loadeddata', state.onRateChange);
  state.speedSource.removeEventListener('emptied', state.onRateChange);
  state.speedSource = null;
  state.onRateChange = null;
}

function bindSpeed(source) {
  var state = pipState();
  if (!source || state.speedSource === source) return;
  unbindSpeed(state);
  state.speedSource = source;
  state.onRateChange = function () {
    var session = pipState();
    if (session.applyingSpeed) return;
    if (session.speed == null || session.speedSource !== source) {
      paintSpeed();
      return;
    }
    if (Math.abs(source.playbackRate - session.speed) < 0.001) return;
    assignSpeed(source);
    paintSpeed();
    defendPinnedSpeed(source);
  };
  source.addEventListener('ratechange', state.onRateChange);
  source.addEventListener('play', state.onRateChange);
  source.addEventListener('playing', state.onRateChange);
  source.addEventListener('loadeddata', state.onRateChange);
  source.addEventListener('emptied', state.onRateChange);
}

function holdSpeed(video) {
  if (!video || isProxy(video)) return;
  bindSpeed(video);
  if (pipState().speed != null) assignSpeed(video);
  paintSpeed();
}

function speedTarget() {
  var state = pipState();
  if (state.documentPipSource) return state.documentPipSource;
  if (state.guestVideo) return state.guestVideo;
  var displayed = document.pictureInPictureElement;
  if (displayed && displayed !== state.proxyVideo) return displayed;
  if (displayed === state.proxyVideo && state.letterboxSource) return state.letterboxSource;
  return findLargestPlayingVideo();
}

function maintainSpeed() {
  var state = pipState();
  if (state.speed == null || state.applyingSpeed) return;
  var video = speedTarget();
  if (!video) return;
  if (video === state.speedSource && Math.abs(video.playbackRate - state.speed) < 0.001) return;
  holdSpeed(video);
}

function applySpeed(video, speed) {
  if (!video) return;
  var state = pipState();
  state.speed = clampSpeed(speed);
  bindSpeed(video);
  assignSpeed(video);
  paintSpeed();
  defendPinnedSpeed(video);
  flashPipControls();
}

function changeSpeed(delta) {
  var video = speedTarget();
  if (!video) return;
  var current = shownRate(video);
  if (current < 0.1) current = 0;
  var target = current + delta;
  if ((current > 1 && target < 1) || (current < 1 && target > 1)) target = 1;
  applySpeed(video, target);
}

// R and G share one memory. Leaving the target remembers the old rate;
// pressing the same key again restores it. At the target with nothing
// remembered, the key jumps to the other target (1x <-> 1.8x).
function toggleSpeed(video, target, cross) {
  if (!video) return;
  var state = pipState();
  var current = shownRate(video);
  var goal = Number(target.toFixed(2));
  var other = cross == null ? null : Number(cross.toFixed(2));
  if (current === goal) {
    if (state.speedBeforeReset != null) {
      var remembered = state.speedBeforeReset;
      state.speedBeforeReset = null;
      applySpeed(video, remembered);
    } else if (other != null && other !== goal) {
      state.speedBeforeReset = current;
      applySpeed(video, other);
    } else {
      applySpeed(video, goal);
    }
    return;
  }
  state.speedBeforeReset = current;
  applySpeed(video, goal);
}

function intendedTime(video) {
  var state = pipState();
  if (state.seekApplyTimer && state.seekVideo === video && state.seekTarget != null) return state.seekTarget;
  return video.currentTime || 0;
}

function scheduleSeek(video, time) {
  if (!video) return;
  var state = pipState();
  var next = time;
  if (next < 0) next = 0;
  if (isFinite(video.duration) && next > video.duration) next = video.duration;
  state.seekVideo = video;
  state.seekTarget = next;
  // Each currentTime write flushes the decoder. A wheel notch or a drag
  // step would otherwise restart that work dozens of times and the picture
  // judders. Keep the latest target and write it once the gesture settles.
  clearTimeout(state.seekApplyTimer);
  state.seekApplyTimer = setTimeout(function () {
    var session = pipState();
    var target = session.seekVideo;
    var at = session.seekTarget;
    session.seekApplyTimer = 0;
    session.seekVideo = null;
    session.seekTarget = null;
    if (!target || at == null) return;
    try { target.currentTime = at; } catch (e) {}
    paintSeek();
  }, 120);
  paintSeek();
}

function seekBy(video, seconds) {
  if (!video) return;
  scheduleSeek(video, intendedTime(video) + seconds);
}

// Vertical wheel up, or a horizontal wheel to the right, moves later in the video.
function wheelSeekSeconds(event) {
  if (!event) return 0;
  var dx = event.deltaX || 0;
  var dy = event.deltaY || 0;
  var pixels = Math.abs(dx) > Math.abs(dy) ? dx : -dy;
  if (event.deltaMode === 1) pixels *= 16;
  else if (event.deltaMode === 2) pixels *= 800;
  if (!pixels) return 0;
  return pixels / 100 * PIP_WHEEL_SEEK_STEP;
}

function onSeekBarWheel(event) {
  var source = pipState().documentPipSource;
  if (!canSeek(source)) return;
  var seconds = wheelSeekSeconds(event);
  if (!seconds) return;
  event.preventDefault();
  event.stopPropagation();
  seekBy(source, seconds);
}

function isHorizontalSeekBox(el) {
  if (!el || !el.getBoundingClientRect) return false;
  var rect = el.getBoundingClientRect();
  return rect.width >= 80 && rect.width > rect.height * 2;
}

// Site players name this control differently. A wide, short bar is a seek bar.
function isSeekBarElement(el) {
  if (!el || !el.tagName) return false;
  var cls = typeof el.className === 'string' ? el.className : '';
  if (cls.indexOf('pip-volume') !== -1 || cls.indexOf('pip-speed') !== -1 || cls.indexOf('pip-page-speed') !== -1) return false;
  if (cls.indexOf('pip-seekbar') !== -1) return true;
  if (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'range') return isHorizontalSeekBox(el);
  var label = '';
  if (el.getAttribute) {
    label = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('aria-valuetext') || '');
  }
  var hint = cls + ' ' + (el.id || '') + ' ' + label;
  if (/ytp-progress-bar|progress-bar|progressbar|seekbar|seek-bar|scrubber|timeline|シーク/i.test(hint)) {
    return isHorizontalSeekBox(el);
  }
  var role = el.getAttribute && el.getAttribute('role');
  if (role === 'slider' && /time|seek|progress|scrub|position|再生|シーク|経過/i.test(label)) {
    return isHorizontalSeekBox(el);
  }
  if (el.tagName === 'PROGRESS') return isHorizontalSeekBox(el);
  return false;
}

function seekBarFromEvent(event) {
  var node = event && event.target;
  if (node && node.nodeType && node.nodeType !== 1) node = node.parentElement;
  for (var depth = 0; node && depth < 8; depth++) {
    if (isSeekBarElement(node)) return node;
    node = node.parentElement;
  }
  return null;
}

function insideVideoPlayer(el) {
  var node = el;
  for (var depth = 0; node && depth < 12; depth++) {
    var cls = typeof node.className === 'string' ? node.className : '';
    if (/html5-video-player|video-player|ytd-player|player-container|jwplayer|vjs-|plyr|media-player/i.test(cls)) return true;
    if (node.querySelector && node.querySelector('video')) return true;
    node = node.parentElement;
  }
  return false;
}

function videoNearSeekBar(bar) {
  if (!bar || !bar.getBoundingClientRect) return null;
  var rect = bar.getBoundingClientRect();
  var videos = pageVideos().filter(function (video) {
    if (!video.isConnected || !video.getBoundingClientRect) return false;
    var box = video.getBoundingClientRect();
    if (box.width < 80 || box.height < 45) return false;
    var overlapsX = rect.right >= box.left - 8 && rect.left <= box.right + 8;
    var overlapsY = rect.bottom >= box.top - 8 && rect.top <= box.bottom + 64;
    return overlapsX && overlapsY;
  }).sort(function (a, b) { return videoArea(b) - videoArea(a); });
  return videos[0] || null;
}

function videoForSeekBar(bar) {
  var nearby = videoNearSeekBar(bar);
  if (nearby) return nearby;
  var source = pipState().documentPipSource;
  if (source && insideVideoPlayer(bar)) return source;
  return null;
}

function onPageSeekWheel(event) {
  if (!event || event.ctrlKey || event.metaKey) return;
  var bar = seekBarFromEvent(event);
  if (!bar || (typeof bar.className === 'string' && bar.className.indexOf('pip-seekbar') !== -1)) return;
  var seekVideo = videoForSeekBar(bar);
  if (!seekVideo || !canSeek(seekVideo)) return;
  var seconds = wheelSeekSeconds(event);
  if (!seconds) return;
  event.preventDefault();
  event.stopPropagation();
  seekBy(seekVideo, seconds);
}

function setPipMark(video) {
  if (!video) return;
  video.__pipMark = video.currentTime;
  video.__pipMarkReturn = null;
}

function jumpPipMark(video) {
  if (!video || typeof video.__pipMark !== 'number') return;
  if (video.__pipMarkReturn != null && Math.abs(video.currentTime - video.__pipMark) < 0.05) {
    video.currentTime = video.__pipMarkReturn;
    video.__pipMarkReturn = null;
    return;
  }
  video.__pipMarkReturn = video.currentTime;
  video.currentTime = video.__pipMark;
}

function isTypingContext(target) {
  if (!target || !target.nodeName) return false;
  if (target.nodeName === 'TEXTAREA' || target.isContentEditable) return true;
  if (target.nodeName !== 'INPUT') return false;
  var type = (target.type || '').toLowerCase();
  return type !== 'range' && type !== 'button' && type !== 'checkbox';
}

function onPipSpeedKey(event) {
  if (!event || event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.isComposing || event.key === 'Process' || event.key === 'Dead' || event.keyCode === 229) return;
  var action = PIP_SPEED_KEYS[event.code];
  if (!action) return;
  if (event.repeat && action !== 'slower' && action !== 'faster' && action !== 'rewind' && action !== 'advance') return;
  if (isTypingContext(event.target)) return;
  var video = speedTarget();
  if (!video && action !== 'display') return;
  if (action === 'slower') changeSpeed(-PIP_SPEED_STEP);
  else if (action === 'faster') changeSpeed(PIP_SPEED_STEP);
  else if (action === 'reset') toggleSpeed(video, PIP_SPEED_RESET, PIP_SPEED_FAST);
  else if (action === 'fast') toggleSpeed(video, PIP_SPEED_FAST, PIP_SPEED_RESET);
  else if (action === 'rewind') seekBy(video, -PIP_SEEK_STEP);
  else if (action === 'advance') seekBy(video, PIP_SEEK_STEP);
  else if (action === 'mark') setPipMark(video);
  else if (action === 'jump') jumpPipMark(video);
  else if (action === 'display') {
    if (pipState().pipStage) togglePipControls();
    else {
      pipState().pageSpeedHidden = !pipState().pageSpeedHidden;
      placePageSpeedBadge();
    }
  }
}

function formatPipTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  var whole = Math.floor(seconds);
  var secs = whole % 60;
  var mins = Math.floor(whole / 60) % 60;
  var hours = Math.floor(whole / 3600);
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  if (hours > 0) return hours + ':' + pad(mins) + ':' + pad(secs);
  return mins + ':' + pad(secs);
}

function canSeek(source) {
  return !!(source && isFinite(source.duration) && source.duration > 0);
}

function paintSeek() {
  var state = pipState();
  var source = state.documentPipSource;
  var bar = state.seekSlider;
  if (!bar) return;
  var seekable = canSeek(source);
  if (state.seekBar) state.seekBar.hidden = !seekable;
  if (!seekable) return;
  bar.max = String(source.duration);
  var pending = state.seekApplyTimer && state.seekVideo === source && state.seekTarget != null;
  var shown = state.seeking ? Number(bar.value) : (pending ? state.seekTarget : (source.currentTime || 0));
  if (!state.seeking) bar.value = String(shown);
  if (state.seekTime) {
    state.seekTime.textContent = formatPipTime(shown) + ' / ' + formatPipTime(source.duration);
  }
}

function unbindSeek(state) {
  if (state.seekSource && state.onTimeUpdate) {
    state.seekSource.removeEventListener('timeupdate', state.onTimeUpdate);
    state.seekSource.removeEventListener('durationchange', state.onTimeUpdate);
    state.seekSource.removeEventListener('seeked', state.onTimeUpdate);
    state.seekSource.removeEventListener('emptied', state.onTimeUpdate);
  }
  state.seekSource = null;
  state.onTimeUpdate = null;
}

function bindDocumentSeek(source) {
  var state = pipState();
  unbindSeek(state);
  state.seekSource = source;
  state.onTimeUpdate = function () { paintSeek(); };
  source.addEventListener('timeupdate', state.onTimeUpdate);
  source.addEventListener('durationchange', state.onTimeUpdate);
  source.addEventListener('seeked', state.onTimeUpdate);
  source.addEventListener('emptied', state.onTimeUpdate);
  paintSeek();
}

function paintPlayButton() {
  var state = pipState();
  if (!state.playButton) return;
  var source = state.documentPipSource;
  var paused = !source || source.paused || source.ended;
  state.playButton.innerHTML = paused ? PIP_ICON_PLAY : PIP_ICON_PAUSE;
  state.playButton.setAttribute('aria-label', paused ? 'Play' : 'Pause');
}

function bindDocumentPlayback(source) {
  var state = pipState();
  if (state.playbackSource && state.onPlay) {
    state.playbackSource.removeEventListener('play', state.onPlay);
    state.playbackSource.removeEventListener('pause', state.onPause);
  }
  state.playbackSource = source;
  state.onPlay = function () { paintPlayButton(); };
  state.onPause = function () { paintPlayButton(); };
  source.addEventListener('play', state.onPlay);
  source.addEventListener('pause', state.onPause);
  paintPlayButton();
}

function unbindVolume(state) {
  if (!state.volumeSource) return;
  if (state.onVolumeChange) {
    state.volumeSource.removeEventListener('volumechange', state.onVolumeChange);
  }
  if (state.onPinnedVolume) {
    state.volumeSource.removeEventListener('play', state.onPinnedVolume);
    state.volumeSource.removeEventListener('playing', state.onPinnedVolume);
    state.volumeSource.removeEventListener('loadeddata', state.onPinnedVolume);
    state.volumeSource.removeEventListener('emptied', state.onPinnedVolume);
  }
  state.volumeSource = null;
  state.onVolumeChange = null;
  state.onPinnedVolume = null;
}

function bindDocumentVolume(source) {
  var state = pipState();
  unbindVolume(state);
  state.volumeSource = source;
  // Once the PiP controls have set a level, keep it. The next video's player
  // would otherwise write its own volume back and the listener would adopt it.
  function reapplyPinned() {
    var session = pipState();
    if (session.applyingVolume || !session.volumePinned) return;
    if (session.volumeSource !== source) return;
    if (volumeMatches(source, session)) return;
    assignVolume(source);
    paintVolumeControls();
    defendPinnedVolume(source);
  }
  state.onPinnedVolume = reapplyPinned;
  state.onVolumeChange = function () {
    var session = pipState();
    if (session.applyingVolume) return;
    if (session.volumePinned) {
      reapplyPinned();
      return;
    }
    readVolume(source);
  };
  source.addEventListener('volumechange', state.onVolumeChange);
  source.addEventListener('play', state.onPinnedVolume);
  source.addEventListener('playing', state.onPinnedVolume);
  source.addEventListener('loadeddata', state.onPinnedVolume);
  source.addEventListener('emptied', state.onPinnedVolume);
}

function stopDocumentPipFit() {
  var state = pipState();
  if (!state.fitObserver) return;
  state.fitObserver.disconnect();
  state.fitObserver = null;
}

// The page keeps writing the player's pixel size onto the video. That box is
// larger than the PiP window, so the picture is clipped. Force the element
// into the window and scale the frame inside it.
function fitDocumentPipVideo(source) {
  if (!source || !source.style) return;
  // These overrides are for the PiP document only. Applying them after the
  // element has moved back shrinks it inside the page.
  var pipWindow = documentPipWindow();
  if (!pipWindow || source.ownerDocument !== pipWindow.document) return;
  var state = pipState();
  if (state.fitObserver) state.fitObserver.disconnect();
  if (source.removeAttribute) {
    source.removeAttribute('width');
    source.removeAttribute('height');
  }
  var style = source.style;
  if (style.setProperty) {
    style.setProperty('position', 'absolute', 'important');
    style.setProperty('inset', '0', 'important');
    style.setProperty('left', '0', 'important');
    style.setProperty('top', '0', 'important');
    style.setProperty('right', '0', 'important');
    style.setProperty('bottom', '0', 'important');
    style.setProperty('width', '100%', 'important');
    style.setProperty('height', '100%', 'important');
    style.setProperty('max-width', '100%', 'important');
    style.setProperty('max-height', '100%', 'important');
    style.setProperty('margin', '0', 'important');
    style.setProperty('object-fit', 'contain', 'important');
    style.setProperty('object-position', 'center', 'important');
    style.setProperty('aspect-ratio', 'auto', 'important');
    style.setProperty('transform', 'none', 'important');
  } else {
    style.cssText = 'position:absolute;inset:0;width:100%;height:100%;max-width:100%;max-height:100%;margin:0;object-fit:contain;object-position:center;aspect-ratio:auto;transform:none;background:#000;display:block';
  }
  if (state.fitObserver && source) {
    state.fitObserver.observe(source, { attributes: true, attributeFilter: ['style', 'width', 'height'] });
  }
}

function watchDocumentPipFit(source) {
  stopDocumentPipFit();
  if (!source || typeof MutationObserver !== 'function') {
    fitDocumentPipVideo(source);
    return;
  }
  var state = pipState();
  state.fitObserver = new MutationObserver(function () {
    fitDocumentPipVideo(source);
  });
  fitDocumentPipVideo(source);
}

var PIP_FIT_PROPS = [
  'position', 'inset', 'left', 'top', 'right', 'bottom',
  'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height',
  'margin', 'object-fit', 'object-position', 'aspect-ratio', 'transform'
];

function clearFitStyles(video) {
  if (!video || !video.style || !video.style.removeProperty) return;
  for (var i = 0; i < PIP_FIT_PROPS.length; i++) {
    video.style.removeProperty(PIP_FIT_PROPS[i]);
  }
}

function applyParkedPresentation(video, parked) {
  if (!video) return;
  clearFitStyles(video);
  if (video.style) video.style.cssText = parked.cssText || '';
  if (!video.setAttribute) return;
  if (parked.widthAttr == null) video.removeAttribute('width');
  else video.setAttribute('width', parked.widthAttr);
  if (parked.heightAttr == null) video.removeAttribute('height');
  else video.setAttribute('height', parked.heightAttr);
}

// Keep the player from adopting the PiP window's box. Players measure the
// video after it leaves and write that smaller size onto the surrounding nodes.
function holdAncestorBoxes(video) {
  var holds = [];
  var box = video.getBoundingClientRect();
  if (box.width < 160 || box.height < 90) return holds;
  var node = video.parentElement;
  var depth = 0;
  while (node && depth < 3 && node !== document.body && node !== document.documentElement) {
    var width = node.clientWidth;
    var height = node.clientHeight;
    // Skip ancestors much larger than the player, such as the page column.
    if (node.style &&
        width >= box.width * 0.8 && width <= box.width * 1.5 &&
        height >= box.height * 0.8 && height <= box.height * 1.5) {
      holds.push({
        node: node,
        width: width,
        height: height,
        cssText: node.style.cssText
      });
      node.style.setProperty('min-width', Math.round(width) + 'px', 'important');
      node.style.setProperty('min-height', Math.round(height) + 'px', 'important');
    }
    node = node.parentElement;
    depth++;
  }
  return holds;
}

function releaseLayoutHolds(parked) {
  var holds = parked.holds || [];
  for (var i = 0; i < holds.length; i++) {
    var hold = holds[i];
    if (!hold.node || !hold.node.style) continue;
    hold.node.style.cssText = hold.cssText || '';
  }
}

function layoutShrunk(video, parked) {
  if (!video || !video.isConnected || video.ownerDocument !== document) return false;
  if (!(parked.boxWidth >= 160) || !(parked.boxHeight >= 90)) return false;
  var rect = video.getBoundingClientRect();
  var parent = video.parentElement;
  var parentW = parent ? parent.clientWidth : 0;
  var parentH = parent ? parent.clientHeight : 0;
  var widthShort = rect.width < parked.boxWidth * 0.85 &&
    !(parentW >= 160 && rect.width >= parentW * 0.85);
  var heightShort = rect.height < parked.boxHeight * 0.85 &&
    !(parentH >= 90 && rect.height >= parentH * 0.85);
  if (widthShort || heightShort) return true;
  var holds = parked.holds || [];
  for (var i = 0; i < holds.length; i++) {
    var hold = holds[i];
    if (!hold.node || !hold.node.isConnected) continue;
    if (window.innerWidth < hold.width * 0.85) continue;
    if (hold.node.clientWidth < hold.width * 0.85) return true;
    if (hold.node.clientHeight < hold.height * 0.85) return true;
  }
  return false;
}

function fillVideoToParent(video) {
  var parent = video.parentElement;
  if (!parent || !video.style) return;
  var width = parent.clientWidth;
  var height = parent.clientHeight;
  if (width < 160 || height < 90) return;
  video.style.setProperty('width', Math.round(width) + 'px');
  video.style.setProperty('height', Math.round(height) + 'px');
  video.style.removeProperty('max-width');
  video.style.removeProperty('max-height');
}

function nudgePlayerLayout() {
  try { window.dispatchEvent(new Event('resize')); } catch (e) {}
}

function reapplyParkedLayout(parked) {
  var video = parked.video;
  if (!video || video.ownerDocument !== document) return;
  applyParkedPresentation(video, parked);
  var holds = parked.holds || [];
  for (var i = 0; i < holds.length; i++) {
    var hold = holds[i];
    if (!hold.node || !hold.node.style || !hold.node.isConnected) continue;
    if (window.innerWidth < hold.width * 0.85) continue;
    if (hold.node.clientWidth < hold.width * 0.85 || hold.node.clientHeight < hold.height * 0.85) {
      hold.node.style.cssText = hold.cssText || '';
    }
  }
  nudgePlayerLayout();
  if (layoutShrunk(video, parked)) fillVideoToParent(video);
}

function scheduleLayoutRestore(parked) {
  if (parked.timers) {
    for (var i = 0; i < parked.timers.length; i++) clearTimeout(parked.timers[i]);
  }
  var delays = [0, 50, 150, 400, 900, 1600];
  parked.timers = [];
  delays.forEach(function (delay) {
    parked.timers.push(setTimeout(function () {
      if (!layoutShrunk(parked.video, parked)) return;
      reapplyParkedLayout(parked);
    }, delay));
  });
}

function restoreParkedVideo(pause) {
  var state = pipState();
  var parked = state.parkedVideo;
  if (!parked || !parked.video) return;
  stopDocumentPipFit();
  var video = parked.video;
  applyParkedPresentation(video, parked);
  var parent = parked.parent;
  if (parent && parent.isConnected) {
    if (parked.next && parked.next.parentNode === parent) parent.insertBefore(video, parked.next);
    else parent.appendChild(video);
  } else if (document.body) {
    document.body.appendChild(video);
  }
  // Drop the size lock only after the video is back, so the player cannot
  // collapse around the empty slot and keep that smaller box.
  releaseLayoutHolds(parked);
  state.parkedVideo = null;
  reapplyParkedLayout(parked);
  scheduleLayoutRestore(parked);
  if (pause) video.pause();
}

function cleanupDocumentPip() {
  var state = pipState();
  unbindVolume(state);
  if (state.playbackSource && state.onPlay) {
    state.playbackSource.removeEventListener('play', state.onPlay);
    state.playbackSource.removeEventListener('pause', state.onPause);
  }
  state.playbackSource = null;
  state.onPlay = null;
  state.onPause = null;
  unbindSeek(state);
  state.seeking = false;
  // Put the element back before the PiP document is discarded. Closing PiP
  // resumes it on the page; switching to another video pauses the old one.
  restoreParkedVideo(false);
  state.documentPipSource = null;
}

function closeDocumentPip() {
  var win = documentPipWindow();
  var state = pipState();
  state.closingDocumentPip = true;
  cleanupDocumentPip();
  if (win) {
    try { win.close(); } catch (e) {}
  }
  state.closingDocumentPip = false;
}

function exitExtensionPip() {
  var state = pipState();
  state.suppressUntil = performance.now() + 1000;
  if (document.pictureInPictureElement && document.exitPictureInPicture) {
    document.exitPictureInPicture().catch(function () {});
  }
  closeDocumentPip();
  endPipSession();
}

function onDocumentPipHide() {
  var state = pipState();
  if (state.closingDocumentPip) return;
  // Ignore the watcher while the element moves back, or it fits the page video
  // to the PiP box and then closes before that style can be restored.
  state.suppressUntil = performance.now() + 1000;
  cleanupDocumentPip();
  endPipSession();
}

function attachSourceToDocumentPip(source) {
  var state = pipState();
  var stage = state.pipStage;
  var tile = state.pipHostTile || stage;
  if (!source || !stage) return false;
  if (state.documentPipSource === source && source.parentNode === tile) return true;
  var wasPlaying = !source.paused && !source.ended;
  if (source.ownerDocument === document) notePipSize(source);
  restoreParkedVideo(true);
  var box = source.getBoundingClientRect();
  state.parkedVideo = {
    video: source,
    parent: source.parentNode,
    next: source.nextSibling,
    cssText: source.style ? source.style.cssText : '',
    widthAttr: source.getAttribute ? source.getAttribute('width') : null,
    heightAttr: source.getAttribute ? source.getAttribute('height') : null,
    boxWidth: box.width,
    boxHeight: box.height,
    holds: holdAncestorBoxes(source)
  };
  tile.appendChild(source);
  watchDocumentPipFit(source);
  if (wasPlaying) {
    var result = source.play();
    if (result && result.catch) result.catch(function () {});
  }
  state.documentPipSource = source;
  bindDocumentVolume(source);
  bindDocumentPlayback(source);
  bindDocumentSeek(source);
  writeVolume(source);
  holdSpeed(source);
  markPipVideo(source);
  rememberHostTile();
  return true;
}

function buildDocumentPip(pipWindow) {
  var doc = pipWindow.document;
  var style = doc.createElement('style');
  style.textContent = [
    'html,body{margin:0;height:100%;background:#000;overflow:hidden}',
    '.pip-stage{position:relative;width:100%;height:100%;background:#000;overflow:hidden;cursor:grab}',
    '.pip-stage.pip-dragging,.pip-stage.pip-dragging video{cursor:grabbing}',
    '.pip-grid{position:absolute;inset:0;display:grid;gap:2px;background:#000;z-index:1}',
    '.pip-tile{position:relative;min-width:0;min-height:0;overflow:hidden;background:#000}',
    '.pip-tile-close{position:absolute;top:4px;left:4px;z-index:2;width:22px;height:22px;border:0;',
    'border-radius:4px;padding:0;background:rgba(0,0,0,.55);color:#fff;cursor:pointer}',
    '.pip-tile video{position:absolute !important;inset:0 !important;width:100% !important;cursor:grab;',
    'height:100% !important;max-width:100% !important;max-height:100% !important;',
    'margin:0 !important;object-fit:contain !important;object-position:center !important;',
    'aspect-ratio:auto !important;transform:none !important;background:#000;display:block}',
    '.pip-volume{position:absolute;z-index:3;top:8px;right:8px;bottom:46px;display:flex;flex-direction:column;',
    'align-items:center;justify-content:flex-end;gap:6px;padding:8px 4px;border-radius:8px;background:rgba(0,0,0,.45)}',
    '.pip-volume-slider{-webkit-appearance:slider-vertical;appearance:slider-vertical;',
    'width:22px;height:100%;min-height:80px;margin:0;accent-color:#fff}',
    '.pip-seekbar{position:absolute;z-index:3;left:0;right:0;bottom:0;display:flex;align-items:center;gap:8px;',
    'padding:8px 10px 10px;background:linear-gradient(transparent,rgba(0,0,0,.75))}',
    '.pip-seekbar[hidden]{display:none}',
    '.pip-seek{flex:1;min-width:0;accent-color:#fff}',
    '.pip-time{color:#fff;font:11px/1 system-ui,sans-serif;white-space:nowrap}',
    '.pip-speed-label{position:absolute;z-index:4;top:10px;left:10px;min-width:3.2em;border:0;',
    'border-radius:8px;padding:6px 10px;background:' + PIP_SPEED_BADGE_BG + ';color:#1a1a1a;',
    '-webkit-appearance:none;appearance:none;',
    'font:700 22px/1 system-ui,sans-serif;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.45)}',
    '.pip-volume,.pip-seekbar,.pip-tile-close{opacity:1;transition:opacity .15s ease}',
    '.pip-stage.pip-controls-hidden .pip-volume,.pip-stage.pip-controls-hidden .pip-volume *,',
    '.pip-stage.pip-controls-hidden .pip-seekbar,.pip-stage.pip-controls-hidden .pip-seekbar *,',
    '.pip-stage.pip-controls-hidden .pip-tile-close{opacity:0;pointer-events:none}',
    '.pip-stage.pip-controls-flash .pip-volume,.pip-stage.pip-controls-flash .pip-seekbar,',
    '.pip-stage.pip-controls-flash .pip-tile-close{opacity:1;pointer-events:auto}',
    '.pip-volume,.pip-volume *,.pip-seekbar,.pip-seekbar *,.pip-tile-close{cursor:pointer}',
    '.pip-mute{width:28px;height:28px;flex:none;border:0;padding:0;background:transparent;color:#fff;cursor:pointer}'
  ].join('');
  (doc.head || doc.documentElement).appendChild(style);
  doc.documentElement.style.height = '100%';
  doc.body.style.margin = '0';
  doc.body.style.height = '100%';
  doc.body.style.background = '#000';

  var stage = doc.createElement('div');
  stage.className = 'pip-stage pip-controls-hidden';
  var grid = doc.createElement('div');
  grid.className = 'pip-grid';
  var hostTile = doc.createElement('div');
  hostTile.className = 'pip-tile';
  grid.appendChild(hostTile);
  stage.appendChild(grid);
  var bar = doc.createElement('div');
  bar.className = 'pip-volume';
  var mute = doc.createElement('button');
  mute.type = 'button';
  mute.className = 'pip-mute';
  var slider = doc.createElement('input');
  slider.type = 'range';
  slider.className = 'pip-volume-slider';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.01';
  slider.value = '1';
  slider.setAttribute('aria-label', 'Volume');
  slider.setAttribute('orient', 'vertical');
  bar.appendChild(slider);
  bar.appendChild(mute);
  var seekBar = doc.createElement('div');
  seekBar.className = 'pip-seekbar';
  var play = doc.createElement('button');
  play.type = 'button';
  play.className = 'pip-mute';
  var seek = doc.createElement('input');
  seek.type = 'range';
  seek.className = 'pip-seek';
  seek.min = '0';
  seek.max = '0';
  seek.step = '0.1';
  seek.value = '0';
  seek.setAttribute('aria-label', 'Seek');
  var seekTime = doc.createElement('span');
  seekTime.className = 'pip-time';
  var slower = doc.createElement('button');
  slower.type = 'button';
  slower.className = 'pip-mute';
  slower.textContent = '\u2212';
  slower.setAttribute('aria-label', 'Slower');
  slower.title = 'Slower (S)';
  var speedLabel = doc.createElement('button');
  speedLabel.type = 'button';
  speedLabel.className = 'pip-speed-label';
  speedLabel.setAttribute('aria-label', 'Reset speed');
  speedLabel.title = 'Reset speed (R)';
  var faster = doc.createElement('button');
  faster.type = 'button';
  faster.className = 'pip-mute';
  faster.textContent = '+';
  faster.setAttribute('aria-label', 'Faster');
  faster.title = 'Faster (D)';
  seekBar.appendChild(play);
  seekBar.appendChild(slower);
  seekBar.appendChild(faster);
  seekBar.appendChild(seek);
  seekBar.appendChild(seekTime);
  seekBar.addEventListener('wheel', onSeekBarWheel, { capture: true, passive: false });
  stage.appendChild(bar);
  stage.appendChild(seekBar);
  stage.appendChild(speedLabel);
  doc.body.appendChild(stage);

  var state = pipState();
  state.pipStage = stage;
  state.pipGrid = grid;
  state.pipHostTile = hostTile;
  layoutPipGrid();
  state.volumeSlider = slider;
  state.volumeMute = mute;
  state.playButton = play;
  state.seekSlider = seek;
  state.seekTime = seekTime;
  state.seekBar = seekBar;
  state.speedLabel = speedLabel;
  paintVolumeControls();
  paintPlayButton();
  paintSeek();
  paintSpeed();
  slower.addEventListener('click', function () { changeSpeed(-PIP_SPEED_STEP); });
  faster.addEventListener('click', function () { changeSpeed(PIP_SPEED_STEP); });
  speedLabel.addEventListener('click', function () {
    toggleSpeed(pipState().documentPipSource, PIP_SPEED_RESET, PIP_SPEED_FAST);
  });
  pipWindow.document.addEventListener('keydown', onPipSpeedKey, true);
  seek.addEventListener('input', function () {
    pipState().seeking = true;
    paintSeek();
  });
  seek.addEventListener('change', function () {
    var session = pipState();
    var current = session.documentPipSource;
    session.seeking = false;
    if (canSeek(current)) scheduleSeek(current, Number(seek.value));
    else paintSeek();
  });
  play.addEventListener('click', function () {
    var current = pipState().documentPipSource;
    if (!current) return;
    if (current.paused || current.ended) {
      var result = current.play();
      if (result && result.catch) result.catch(function () {});
    } else {
      current.pause();
    }
    paintPlayButton();
  });

  slider.addEventListener('input', function () {
    var session = pipState();
    var value = Number(slider.value);
    session.volume = value;
    session.muted = value === 0;
    session.volumePinned = true;
    if (value > 0) session.lastAudible = value;
    var current = session.documentPipSource;
    if (!current) {
      paintVolumeControls();
      return;
    }
    writeVolume(current);
  });
  mute.addEventListener('click', function () {
    var session = pipState();
    session.muted = !session.muted;
    session.volumePinned = true;
    if (!session.muted && !(session.volume > 0)) session.volume = session.lastAudible || 1;
    writeVolume(session.documentPipSource);
  });
  bindPipControlsHover(pipWindow);
  installPipDrag(stage);
}

function togglePipControls() {
  var state = pipState();
  var stage = state.pipStage;
  if (!stage || !stage.classList) return;
  var hidden = stage.classList.contains('pip-controls-hidden');
  state.controlsForce = hidden ? 'show' : 'hide';
  if (hidden) stage.classList.remove('pip-controls-hidden');
  else stage.classList.add('pip-controls-hidden');
}

function flashPipControls() {
  var state = pipState();
  var stage = state.pipStage;
  if (!stage || !stage.classList || state.controlsForce === 'hide') return;
  stage.classList.add('pip-controls-flash');
  clearTimeout(state.controlsFlash);
  state.controlsFlash = setTimeout(function () {
    var current = pipState().pipStage;
    if (current && current.classList) current.classList.remove('pip-controls-flash');
  }, 1200);
}

// Controls stay hidden until the pointer is over the PiP window, then hide
// again as soon as it leaves. pointermove covers a window that opens under
// the cursor, which does not fire a fresh enter event.
function bindPipControlsHover(pipWindow) {
  var root = pipWindow.document.documentElement;
  function show() {
    var session = pipState();
    session.pointerInside = true;
    if (session.controlsForce === 'hide') return;
    var stage = session.pipStage;
    if (stage && stage.classList) stage.classList.remove('pip-controls-hidden');
  }
  function hide(event) {
    if (event && event.relatedTarget && root.contains(event.relatedTarget)) return;
    var session = pipState();
    session.pointerInside = false;
    if (session.controlsForce === 'show') return;
    var stage = session.pipStage;
    if (stage && stage.classList) stage.classList.add('pip-controls-hidden');
  }
  root.addEventListener('pointerenter', show);
  root.addEventListener('pointerleave', hide);
  root.addEventListener('mouseenter', show);
  root.addEventListener('mouseleave', hide);
  // Leaving the PiP window sets relatedTarget to null. Moving between controls
  // inside the window keeps a target that is still in this document.
  pipWindow.document.addEventListener('mouseout', function (event) {
    if (event.relatedTarget && root.contains(event.relatedTarget)) return;
    hide(event);
  });
  pipWindow.addEventListener('pointermove', show);
}

function openDocumentPip(video) {
  var api = globalThis.documentPictureInPicture;
  if (!api || typeof api.requestWindow !== 'function' || !isTopFrame()) {
    return Promise.reject(new Error('document pip unavailable'));
  }
  if (api.window) {
    if (!attachSourceToDocumentPip(video)) return Promise.reject(new Error('capture failed'));
    pipState().documentPipOwned = true;
    flushPendingGuests();
    pipSend({ type: 'pip-remember-window' });
    return Promise.resolve();
  }
  var aspect = videoAspect(video) || (16 / 9);
  var size = pipWindowSize(aspect);
  return api.requestWindow({ width: size.width, height: size.height }).then(function (pipWindow) {
    var state = pipState();
    if (!state.lockedAspect) state.lockedAspect = aspect;
    buildDocumentPip(pipWindow);
    pipWindow.addEventListener('pagehide', onDocumentPipHide);
    if (!attachSourceToDocumentPip(video)) {
      state.closingDocumentPip = true;
      try { pipWindow.close(); } catch (e) {}
      state.closingDocumentPip = false;
      cleanupDocumentPip();
      throw new Error('capture failed');
    }
    pipState().documentPipOwned = true;
    watchPipSession();
    flushPendingGuests();
    pipSend({ type: 'pip-remember-window' });
  });
}

function requestPictureInPicture(video) {
  installPipWatcher();
  return openDocumentPip(video).catch(function () {
    return video.requestPictureInPicture();
  });
}

// Chrome sizes the PiP window to the video's aspect ratio. A letterboxed
// canvas with the original ratio keeps that window size when the next video
// is a different shape.
function ensureProxy(aspect) {
  var state = pipState();
  if (!state.proxyVideo) {
    var canvas = document.createElement('canvas');
    var video = document.createElement('video');
    if (!canvas || !canvas.getContext || !video) return false;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('__pip_proxy__', 'true');
    video.setAttribute('playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    var hidden = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none';
    video.style.cssText = hidden;
    canvas.style.cssText = hidden;
    video.addEventListener('pause', function (event) {
      if (!event.isTrusted) return;
      var source = pipState().letterboxSource;
      if (source && !source.paused) source.pause();
    });
    video.addEventListener('play', function (event) {
      if (!event.isTrusted) return;
      var source = pipState().letterboxSource;
      if (source && source.paused) source.play();
    });
    var parent = document.documentElement || document.body;
    if (!parent) return false;
    parent.appendChild(canvas);
    parent.appendChild(video);
    state.proxyCanvas = canvas;
    state.proxyVideo = video;
    state.proxyCtx = canvas.getContext('2d', { alpha: false });
  }
  if (!state.proxyCtx) return false;
  var size = canvasSizeForAspect(aspect);
  if (state.proxyCanvas.width !== size.width || state.proxyCanvas.height !== size.height) {
    state.proxyCanvas.width = size.width;
    state.proxyCanvas.height = size.height;
    if (state.proxyStream) {
      state.proxyStream.getTracks().forEach(function (track) { track.stop(); });
      state.proxyStream = null;
      state.proxyTrack = null;
    }
  }
  if (!state.proxyStream) {
    if (!state.proxyCanvas.captureStream) return false;
    try {
      state.proxyStream = state.proxyCanvas.captureStream(0);
    } catch (e) {
      return false;
    }
    state.proxyTrack = state.proxyStream.getVideoTracks()[0];
    state.proxyVideo.srcObject = state.proxyStream;
  }
  return true;
}

function drawLetterbox(source) {
  var state = pipState();
  var canvas = state.proxyCanvas;
  var ctx = state.proxyCtx;
  if (!canvas || !ctx || !source) return;
  var sw = source.videoWidth;
  var sh = source.videoHeight;
  if (!sw || !sh) return;
  var cw = canvas.width;
  var ch = canvas.height;
  var scale = Math.min(cw / sw, ch / sh);
  var dw = sw * scale;
  var dh = sh * scale;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(source, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
}

function pushLetterboxFrame() {
  var track = pipState().proxyTrack;
  if (track && track.requestFrame) track.requestFrame();
}

function bindSourceCapture(source) {
  var state = pipState();
  if (state.captureSource === source && state.sourceCapture) return;
  if (state.sourceCapture) {
    state.sourceCapture.getTracks().forEach(function (track) { track.stop(); });
    state.sourceCapture = null;
  }
  state.captureSource = source;
  if (!source.captureStream) return;
  try {
    var stream = source.captureStream();
    stream.getAudioTracks().forEach(function (track) { track.stop(); });
    state.sourceCapture = stream;
  } catch (e) {
    state.sourceCapture = null;
  }
}

function startLetterboxLoop() {
  var state = pipState();
  if (state.letterboxTimer) return;
  function tick() {
    var current = pipState();
    if (!current.letterboxSource) {
      current.letterboxTimer = 0;
      return;
    }
    try {
      drawLetterbox(current.letterboxSource);
      pushLetterboxFrame();
    } catch (e) {
      blockLetterbox(current.letterboxSource);
      return;
    }
    current.letterboxTimer = setTimeout(tick, 33);
  }
  state.letterboxTimer = setTimeout(tick, 33);
}

function stopLetterbox() {
  var state = pipState();
  state.letterboxSource = null;
  if (state.letterboxTimer) {
    clearTimeout(state.letterboxTimer);
    state.letterboxTimer = 0;
  }
  if (state.sourceCapture) {
    state.sourceCapture.getTracks().forEach(function (track) { track.stop(); });
    state.sourceCapture = null;
    state.captureSource = null;
  }
}

function blockLetterbox(source) {
  var state = pipState();
  state.letterboxBlocked = true;
  state.letterboxSource = null;
  stopLetterbox();
  switchPipVideo(source);
}

function endPipSession() {
  // A watcher tick can run before requestWindow resolves. Releasing the host
  // then would give the slot to another tab while this window is still opening.
  var state = pipState();
  if (state.documentPipOwned) releasePipHost();
  state.documentPipOwned = false;
  state.pipStage = null;
  state.pipGrid = null;
  state.pipHostTile = null;
  state.hostEvicted = false;
  state.tileOrder = null;
  state.nativeOnly = false;
  state.lockedAspect = 0;
  state.letterboxBlocked = false;
  clearVolumeDefend();
  state.volumeDefendFor = null;
  state.volumePinned = false;
  state.volume = null;
  state.muted = false;
  cleanupDocumentPip();
  stopLetterbox();
  if (state.proxyStream) {
    state.proxyStream.getTracks().forEach(function (track) { track.stop(); });
    state.proxyStream = null;
    state.proxyTrack = null;
  }
  if (state.proxyVideo) {
    state.proxyVideo.pause();
    state.proxyVideo.srcObject = null;
  }
  releasePipSession();
}

function proxyReady() {
  var video = pipState().proxyVideo;
  if (video.readyState >= 2 && video.videoWidth) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(fail, 1500);
    function succeed() {
      if (video.readyState < 2 || !video.videoWidth) return;
      cleanup();
      resolve();
    }
    function fail() {
      cleanup();
      reject(new Error('pip proxy timeout'));
    }
    function cleanup() {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', succeed);
      video.removeEventListener('loadedmetadata', succeed);
      video.removeEventListener('resize', succeed);
    }
    video.addEventListener('loadeddata', succeed);
    video.addEventListener('loadedmetadata', succeed);
    video.addEventListener('resize', succeed);
  });
}

function showLetterboxed(source) {
  var state = pipState();
  if (state.letterboxSource === source && document.pictureInPictureElement === state.proxyVideo) return;
  if (!state.lockedAspect || !ensureProxy(state.lockedAspect)) {
    switchPipVideo(source);
    return;
  }
  state.letterboxSource = source;
  bindSourceCapture(source);
  try {
    drawLetterbox(source);
  } catch (e) {
    blockLetterbox(source);
    return;
  }
  pushLetterboxFrame();
  startLetterboxLoop();
  holdSpeed(source);
  if (document.pictureInPictureElement === state.proxyVideo) return;
  if (state.requesting) return;
  state.requesting = source;
  state.pipHandoff = true;
  var fellBack = false;
  var playResult;
  try {
    playResult = state.proxyVideo.play();
  } catch (e) {
    fellBack = true;
    state.requesting = null;
    state.pipHandoff = false;
    state.letterboxSource = null;
    stopLetterbox();
    switchPipVideo(source);
    return;
  }
  Promise.resolve(playResult).then(function () {
    return proxyReady();
  }).then(function () {
    return state.proxyVideo.requestPictureInPicture();
  }).then(function () {
    markPipVideo(source);
    holdSpeed(source);
  }).catch(function () {
    fellBack = true;
    state.requesting = null;
    state.pipHandoff = false;
    state.letterboxSource = null;
    stopLetterbox();
    switchPipVideo(source);
  }).finally(function () {
    if (fellBack) return;
    if (state.requesting === source) state.requesting = null;
    setTimeout(function () { pipState().pipHandoff = false; }, 200);
  });
}

function presentNativePip(video) {
  installPipWatcher();
  var state = pipState();
  state.openingNative = true;
  if (state.guestActive) stopGuestTile(true);
  exitExtensionPip();
  return pipSend({ type: 'pip-exit-all' }).then(function () {
    state.nativeOnly = true;
    try { video.disablePictureInPicture = false; } catch (e) {}
    return video.requestPictureInPicture();
  }).then(function () {
    state.openingNative = false;
    markPipVideo(video);
    holdSpeed(video);
    watchPipSession();
  }).catch(function () {
    state.openingNative = false;
    state.nativeOnly = false;
  });
}

function presentPip(video) {
  if (!video || isProxy(video)) return;
  if (pipState().nativeOnly) {
    switchPipVideo(video);
    return;
  }
  if (documentPipWindow()) {
    if (pipState().hostEvicted) return;
    if (pipState().documentPipSource !== video) attachSourceToDocumentPip(video);
    return;
  }
  var state = pipState();
  var aspect = videoAspect(video);
  // A source swap often reports 0x0 for a moment. Keep the current frame
  // instead of dropping back to a window resize.
  if (!aspect) {
    if (state.letterboxSource === video && document.pictureInPictureElement === state.proxyVideo) return;
    if (document.pictureInPictureElement === video) return;
    switchPipVideo(video);
    return;
  }
  if (!state.letterboxBlocked && aspectsDiffer(state.lockedAspect, aspect)) {
    showLetterboxed(video);
    return;
  }
  if (document.pictureInPictureElement === video) return;
  switchPipVideo(video);
}

function switchPipVideo(video) {
  var state = pipState();
  if (!video || state.requesting) return;
  if (performance.now() < state.suppressUntil) return;
  if (document.pictureInPictureElement === video) return;
  if (state.failedVideo === video && performance.now() < state.failedUntil) return;
  state.requesting = video;
  state.pipHandoff = true;
  if (state.nativeOnly) {
    try { video.disablePictureInPicture = false; } catch (e) {}
  }
  var pending;
  try {
    pending = video.requestPictureInPicture();
  } catch (e) {
    state.pipHandoff = false;
    state.requesting = null;
    state.failedVideo = video;
    state.failedUntil = performance.now() + PIP_STUCK_MS;
    return;
  }
  Promise.resolve(pending).then(function () {
    markPipVideo(video);
    holdSpeed(video);
  }).catch(function () {
    state.failedVideo = video;
    state.failedUntil = performance.now() + PIP_STUCK_MS;
  }).finally(function () {
    if (state.requesting === video) state.requesting = null;
    setTimeout(function () { pipState().pipHandoff = false; }, 200);
  });
}

function updatePipVideo() {
  maintainSpeed();
  placePageSpeedBadge();
  var state = pipState();
  if (state.guestActive) {
    updateGuestTile();
    return;
  }
  var displayed = document.pictureInPictureElement;
  var docPip = documentPipWindow();
  if (!displayed && !docPip) {
    if (state.pipHandoff) return;
    endPipSession();
    return;
  }
  if (performance.now() < state.suppressUntil) return;
  watchPipSession();
  var logical = docPip
    ? state.documentPipSource
    : (displayed === state.proxyVideo ? state.letterboxSource : displayed);
  if (!logical || isProxy(logical)) {
    var fallback = findReplacementVideo(null, false);
    if (fallback) presentPip(fallback);
    return;
  }
  // Seeking drops readyState and looks like a stall. Swapping or refitting
  // the picture then restarts the seek and the frame stutters.
  if (logical.seeking || (state.seekApplyTimer && state.seekVideo === logical)) return;
  if (docPip) fitDocumentPipVideo(logical);
  notePipSize(logical);
  if (!state.lockedAspect) {
    var shownAspect = videoAspect(logical);
    if (shownAspect) state.lockedAspect = shownAspect;
  }
  var live = isCurrentLive(logical);
  var candidate = findReplacementVideo(logical, live);
  var target = candidate && shouldSwitchPipVideo(logical, candidate, live) ? candidate : logical;
  presentPip(target);
}

function schedulePipUpdate() {
  var state = pipState();
  if (state.scheduled) return;
  // rAF does not run while the tab is in the background, which is when PiP
  // is actually being watched. A timer still fires there (clamped to 1s).
  state.scheduled = true;
  setTimeout(function () {
    state.scheduled = false;
    updatePipVideo();
  }, 50);
}

function watchPipSession() {
  ensureHeartbeat();
  ensureDomObserver();
  observeVideos();
}

function releasePipSession() {
  var state = pipState();
  if (state.heartbeat) {
    clearInterval(state.heartbeat);
    state.heartbeat = 0;
  }
  if (state.observingDom && state.mutationObserver) {
    state.mutationObserver.disconnect();
    state.observingDom = false;
  }
  if (state.resizeObserver) {
    state.observed.forEach(function (video) {
      state.resizeObserver.unobserve(video);
    });
    state.observed.clear();
  }
}

function ensureHeartbeat() {
  var state = pipState();
  if (state.heartbeat) return;
  state.heartbeat = setInterval(updatePipVideo, PIP_HEARTBEAT_MS);
}

function ensureDomObserver() {
  var state = pipState();
  if (state.observingDom || !state.mutationObserver) return;
  state.observingDom = true;
  state.mutationObserver.observe(document, { childList: true, subtree: true });
}

function observeVideos() {
  var state = pipState();
  if (!state.resizeObserver) return;
  state.observed.forEach(function (video) {
    if (video.isConnected) return;
    state.resizeObserver.unobserve(video);
    state.observed.delete(video);
  });
  document.querySelectorAll('video').forEach(function (video) {
    if (!video.isConnected || state.observed.has(video)) return;
    state.observed.add(video);
    state.resizeObserver.observe(video);
  });
}

function installPipWatcher() {
  installPipMessenger();
  var state = pipState();
  if (state.installed) return;
  state.installed = true;
  document.addEventListener('keydown', onPipSpeedKey, true);
  document.addEventListener('wheel', onPageSeekWheel, { capture: true, passive: false });
  window.addEventListener('scroll', placePageSpeedBadge, true);
  window.addEventListener('resize', placePageSpeedBadge);
  if (!state.pageSpeedTimer) state.pageSpeedTimer = setInterval(placePageSpeedBadge, 500);
  placePageSpeedBadge();

  state.resizeObserver = new ResizeObserver(function () {
    schedulePipUpdate();
  });
  state.mutationObserver = new MutationObserver(function () {
    if (!extensionPipOpen() && !pipState().guestActive) return;
    observeVideos();
    schedulePipUpdate();
  });

  var mediaEvents = ['play', 'playing', 'pause', 'ended', 'emptied', 'loadeddata', 'waiting', 'abort'];
  for (var i = 0; i < mediaEvents.length; i++) {
    document.addEventListener(mediaEvents[i], schedulePipUpdate, true);
  }
  // YouTube's SPA navigation does not resize the player.
  document.addEventListener('yt-navigate-finish', schedulePipUpdate, true);
  document.addEventListener('yt-page-data-updated', schedulePipUpdate, true);

  document.addEventListener('enterpictureinpicture', function (event) {
    var video = event.target;
    var session = pipState();
    if (!video || video.localName !== 'video') return;
    if (video === session.proxyVideo) {
      if (session.letterboxSource) markPipVideo(session.letterboxSource);
    } else {
      var aspect = videoAspect(video);
      if (!session.lockedAspect && aspect) session.lockedAspect = aspect;
      stopLetterbox();
      markPipVideo(video);
    }
    watchPipSession();
    schedulePipUpdate();
  }, true);

  document.addEventListener('leavepictureinpicture', function (event) {
    var session = pipState();
    if (event.target && event.target !== session.proxyVideo && event.target.removeAttribute) {
      event.target.removeAttribute('__pip__');
    }
    if (session.pipHandoff) return;
    if (!extensionPipOpen()) endPipSession();
  }, true);
}

function pipGridColumns(count) {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  return 3;
}

function pipTileCount(grid) {
  if (!grid) return 0;
  if (typeof grid.childElementCount === 'number') return grid.childElementCount;
  return grid.children ? grid.children.length : 0;
}

function layoutPipGrid() {
  var grid = pipState().pipGrid;
  if (!grid || !grid.style) return;
  var count = pipTileCount(grid);
  var columns = pipGridColumns(count);
  var rows = Math.max(1, Math.ceil(count / columns));
  grid.style.gridTemplateColumns = 'repeat(' + columns + ', minmax(0, 1fr))';
  grid.style.gridTemplateRows = 'repeat(' + rows + ', minmax(0, 1fr))';
}

function pipSend(message) {
  return new Promise(function (resolve) {
    if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      resolve(null);
      return;
    }
    try {
      chrome.runtime.sendMessage(message, function (response) {
        var err = chrome.runtime && chrome.runtime.lastError;
        resolve(err ? null : response);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function sessionDescription(desc) {
  if (!desc) return null;
  var copy = { type: desc.type, sdp: desc.sdp };
  if (typeof RTCSessionDescription === 'function') return new RTCSessionDescription(copy);
  return copy;
}

function pipPeerConnection() {
  try {
    return new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  } catch (e) {
    return new RTCPeerConnection();
  }
}

function packCandidate(candidate) {
  if (!candidate) return null;
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment
  };
}

function addIceCandidate(pc, bucket, candidate) {
  if (!pc || !candidate) return;
  if (!pc.remoteDescription) {
    bucket.push(candidate);
    return;
  }
  var ice = typeof RTCIceCandidate === 'function' ? new RTCIceCandidate(candidate) : candidate;
  var pending = pc.addIceCandidate(ice);
  if (pending && pending.catch) pending.catch(function () {});
}

function flushIce(pc, bucket) {
  if (!pc || !bucket || !bucket.length) return;
  var queued = bucket.splice(0, bucket.length);
  queued.forEach(function (candidate) {
    addIceCandidate(pc, bucket, candidate);
  });
}

function waitForIce(pc) {
  if (!pc || pc.iceGatheringState === 'complete' || !pc.addEventListener) return Promise.resolve();
  return new Promise(function (resolve) {
    var timer = setTimeout(finish, 1200);
    function finish() {
      clearTimeout(timer);
      if (pc.removeEventListener) pc.removeEventListener('icegatheringstatechange', onState);
      resolve();
    }
    function onState() {
      if (pc.iceGatheringState === 'complete') finish();
    }
    pc.addEventListener('icegatheringstatechange', onState);
  });
}

function connectPipPort() {
  var state = pipState();
  if (state.pipPort) return;
  if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.connect) return;
  try {
    state.pipPort = chrome.runtime.connect({ name: 'pip-participant' });
    state.pipPort.onDisconnect.addListener(function () {
      pipState().pipPort = null;
    });
  } catch (e) {}
}

function disconnectPipPort() {
  var state = pipState();
  if (!state.pipPort) return;
  try { state.pipPort.disconnect(); } catch (e) {}
  state.pipPort = null;
}

function claimPipHost() {
  return pipSend({ type: 'pip-claim-host' }).then(function (response) {
    if (response && response.ok) pipState().hostClaimed = true;
    return response;
  });
}

function releasePipHost() {
  var state = pipState();
  if (!state.hostClaimed) return;
  state.hostClaimed = false;
  closeGuestPeers();
  pipSend({ type: 'pip-release-host' });
  disconnectPipPort();
}

function installPipMessenger() {
  var state = pipState();
  if (state.messenger) return;
  state.messenger = true;
  if (!globalThis.chrome || !chrome.runtime || !chrome.runtime.onMessage) return;
  chrome.runtime.onMessage.addListener(onPipRuntimeMessage);
}

function onPipRuntimeMessage(message) {
  if (!message || !message.type) return;
  if (message.type === 'pip-add') acceptGuestOffer(message);
  else if (message.type === 'pip-signal') {
    if (message.fromTabId != null) acceptHostSignal(message);
    else acceptGuestSignal(message);
  }
  else if (message.type === 'pip-guest-remove') removeGuestTile(message.tabId);
  else if (message.type === 'pip-guest-stop' || message.type === 'pip-host-gone') stopGuestTile(true);
  else if (message.type === 'pip-host-released') {
    var session = pipState();
    if (session.openingNative || session.nativeOnly) return;
    exitExtensionPip();
  }
}

function flushPendingGuests() {
  var state = pipState();
  var queued = state.pendingGuestAdds || [];
  state.pendingGuestAdds = [];
  queued.forEach(acceptGuestOffer);
}

function closeGuestPeers() {
  var state = pipState();
  var peers = state.guestPeers || {};
  Object.keys(peers).forEach(function (id) { removeGuestTile(id); });
  state.pendingGuestAdds = [];
}

function forgetTile(id) {
  var state = pipState();
  if (!state.tileOrder) return;
  state.tileOrder = state.tileOrder.filter(function (item) { return item.id !== id; });
}

function rememberHostTile() {
  var state = pipState();
  state.tileOrder = state.tileOrder || [];
  var exists = state.tileOrder.some(function (item) { return item.id === 'host'; });
  if (!exists) state.tileOrder.push({ id: 'host', kind: 'host' });
}

function rememberGuestTile(tabId) {
  var state = pipState();
  state.tileOrder = state.tileOrder || [];
  var id = 'guest:' + tabId;
  state.tileOrder = state.tileOrder.filter(function (item) { return item.id !== id; });
  state.tileOrder.push({ id: id, kind: 'guest', tabId: tabId });
}

function evictHostTile() {
  var state = pipState();
  state.hostEvicted = true;
  cleanupDocumentPip();
  var tile = state.pipHostTile;
  if (tile && tile.parentNode && tile.parentNode.removeChild) tile.parentNode.removeChild(tile);
  state.pipHostTile = null;
  layoutPipGrid();
}

function evictGuestTile(tabId) {
  removeGuestTile(tabId);
  pipSend({ type: 'pip-drop-guest', tabId: tabId });
}

function evictOldestTile() {
  var state = pipState();
  var order = state.tileOrder || [];
  if (!order.length) return;
  var oldest = order.shift();
  state.tileOrder = order;
  if (oldest.kind === 'host') evictHostTile();
  else evictGuestTile(oldest.tabId);
}

function ensureTileRoom() {
  var state = pipState();
  var guard = 0;
  while ((state.tileOrder || []).length >= PIP_MAX_TILES && guard < PIP_MAX_TILES) {
    evictOldestTile();
    guard++;
  }
}

function removeGuestTile(tabId) {
  if (tabId == null) return;
  var state = pipState();
  forgetTile('guest:' + tabId);
  if (!state.guestPeers) {
    layoutPipGrid();
    return;
  }
  var peer = state.guestPeers[String(tabId)];
  if (!peer) return;
  delete state.guestPeers[String(tabId)];
  if (peer.pc) {
    try { peer.pc.close(); } catch (e) {}
  }
  if (peer.tile && peer.tile.parentNode && peer.tile.parentNode.removeChild) {
    peer.tile.parentNode.removeChild(peer.tile);
  }
  layoutPipGrid();
}

function remoteStreamFromTrack(event) {
  var track = event && event.track;
  var stream = event && event.streams && event.streams[0];
  if (!stream || !stream.getVideoTracks || !stream.getVideoTracks().length) {
    stream = new MediaStream();
    if (track && stream.addTrack) stream.addTrack(track);
    return stream;
  }
  if (track && stream.addTrack && stream.getTracks && stream.getTracks().indexOf(track) === -1) {
    try { stream.addTrack(track); } catch (e) {}
  }
  return stream;
}

function playMuted(video) {
  if (!video) return;
  video.muted = true;
  video.defaultMuted = true;
  if (video.setAttribute) {
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('autoplay', '');
  }
  video.autoplay = true;
  video.playsInline = true;
  var pending = video.play && video.play();
  if (pending && pending.catch) pending.catch(function () {});
}

function mountGuestTile(tabId, stream) {
  var state = pipState();
  var grid = state.pipGrid;
  var win = documentPipWindow();
  var doc = win && win.document;
  if (!grid || !doc) return;
  var peer = state.guestPeers && state.guestPeers[String(tabId)];
  if (peer && peer.videoEl) {
    peer.videoEl.srcObject = stream;
    playMuted(peer.videoEl);
    return;
  }
  var tile = doc.createElement('div');
  tile.className = 'pip-tile';
  // Play the stream in the opener document first. A MediaStream created in
  // this frame does not always paint if it is attached only inside the PiP document.
  var video = document.createElement('video');
  if (video.setAttribute) video.setAttribute('__pip_proxy__', 'true');
  if (video.style) video.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px;opacity:0;pointer-events:none';
  playMuted(video);
  video.srcObject = stream;
  if (document.documentElement) document.documentElement.appendChild(video);
  playMuted(video);
  var close = doc.createElement('button');
  close.type = 'button';
  close.className = 'pip-tile-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '\u00d7';
  close.addEventListener('click', function () {
    pipSend({ type: 'pip-drop-guest', tabId: tabId });
  });
  tile.appendChild(close);
  tile.appendChild(video);
  grid.appendChild(tile);
  if (video.style) video.style.cssText = '';
  video.srcObject = stream;
  playMuted(video);
  if (stream && stream.getVideoTracks) {
    stream.getVideoTracks().forEach(function (track) {
      track.addEventListener('unmute', function () { playMuted(video); });
    });
  }
  if (peer) {
    peer.tile = tile;
    peer.videoEl = video;
  }
  layoutPipGrid();
}

function acceptGuestOffer(message) {
  var state = pipState();
  if (!message || message.fromTabId == null || !message.sdp) return;
  if (!documentPipWindow()) {
    state.pendingGuestAdds = state.pendingGuestAdds || [];
    state.pendingGuestAdds.push(message);
    return;
  }
  if (typeof RTCPeerConnection !== 'function') return;
  var tabId = message.fromTabId;
  removeGuestTile(tabId);
  ensureTileRoom();
  rememberGuestTile(tabId);
  var pc = pipPeerConnection();
  state.guestPeers = state.guestPeers || {};
  var early = state.earlyIce && state.earlyIce[String(tabId)];
  if (state.earlyIce) delete state.earlyIce[String(tabId)];
  var peer = { pc: pc, tabId: tabId, tile: null, videoEl: null, ice: early || [] };
  state.guestPeers[String(tabId)] = peer;
  pc.onicecandidate = function (event) {
    if (!event.candidate) return;
    pipSend({ type: 'pip-signal', guestTabId: tabId, candidate: packCandidate(event.candidate) });
  };
  pc.ontrack = function (event) {
    mountGuestTile(tabId, remoteStreamFromTrack(event));
  };
  pc.setRemoteDescription(sessionDescription(message.sdp)).then(function () {
    flushIce(pc, peer.ice);
    return pc.createAnswer();
  }).then(function (answer) {
    return pc.setLocalDescription(answer);
  }).then(function () {
    return waitForIce(pc);
  }).then(function () {
    return pipSend({
      type: 'pip-signal',
      guestTabId: tabId,
      sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
    });
  }).catch(function () {
    removeGuestTile(tabId);
    pipSend({ type: 'pip-drop-guest', tabId: tabId });
  });
}

function acceptHostSignal(message) {
  if (!message || message.fromTabId == null || !message.candidate) return;
  var state = pipState();
  var key = String(message.fromTabId);
  var peer = state.guestPeers && state.guestPeers[key];
  if (!peer) {
    state.earlyIce = state.earlyIce || {};
    state.earlyIce[key] = state.earlyIce[key] || [];
    state.earlyIce[key].push(message.candidate);
    return;
  }
  peer.ice = peer.ice || [];
  addIceCandidate(peer.pc, peer.ice, message.candidate);
}

function acceptGuestSignal(message) {
  var state = pipState();
  var pc = state.guestPc;
  if (!pc || !message) return;
  if (message.candidate) {
    state.guestIce = state.guestIce || [];
    addIceCandidate(pc, state.guestIce, message.candidate);
    return;
  }
  if (!message.sdp) return;
  if (pc.signalingState !== 'have-local-offer') {
    state.pendingAnswer = message.sdp;
    return;
  }
  applyGuestAnswer(pc, message.sdp);
}

function applyGuestAnswer(pc, sdp) {
  var state = pipState();
  state.pendingAnswer = null;
  pc.setRemoteDescription(sessionDescription(sdp)).then(function () {
    flushIce(pc, state.guestIce || []);
  }).catch(function () {});
}

function bindGuestKeepAlive(video) {
  var state = pipState();
  unbindGuestKeepAlive();
  if (!video || !video.addEventListener) return;
  state.guestKeepAlive = function () {
    var session = pipState();
    if (!session.guestActive || session.guestVideo !== video) return;
    var pending = video.play && video.play();
    if (pending && pending.catch) pending.catch(function () {});
  };
  state.guestKeepAliveVideo = video;
  video.addEventListener('pause', state.guestKeepAlive, true);
}

function unbindGuestKeepAlive() {
  var state = pipState();
  if (state.guestKeepAliveVideo && state.guestKeepAlive && state.guestKeepAliveVideo.removeEventListener) {
    state.guestKeepAliveVideo.removeEventListener('pause', state.guestKeepAlive, true);
  }
  state.guestKeepAlive = null;
  state.guestKeepAliveVideo = null;
}

function applyGuestHide(video) {
  if (!video || !video.style || !video.style.setProperty) return;
  // Keep the element laid out and decoding. visibility:hidden makes some
  // players detach the media, so the captured tile stays black.
  video.style.setProperty('opacity', '0', 'important');
  var pending = video.play && video.play();
  if (pending && pending.catch) pending.catch(function () {});
}

function hideGuestVideo(video) {
  var state = pipState();
  if (video && video.ownerDocument === document) notePipSize(video);
  if (!state.guestHidden || state.guestHidden.video !== video) {
    if (state.guestHidden) restoreGuestVideo(true);
    state.guestHidden = {
      video: video,
      cssText: video && video.style ? video.style.cssText : ''
    };
  }
  applyGuestHide(video);
}

function restoreGuestVideo(pause) {
  var state = pipState();
  var hidden = state.guestHidden;
  if (!hidden || !hidden.video) {
    state.guestHidden = null;
    return;
  }
  var video = hidden.video;
  if (video.style) video.style.cssText = hidden.cssText || '';
  state.guestHidden = null;
  if (pause && video.pause) video.pause();
}

function guestCapture(video) {
  if (!video || typeof video.captureStream !== 'function') return null;
  try {
    var stream = video.captureStream();
    var tracks = stream.getVideoTracks();
    if (!tracks.length) return null;
    return stream;
  } catch (e) {
    return null;
  }
}

function startGuestTile(video) {
  var stream = guestCapture(video);
  if (!stream) return Promise.resolve(false);
  var state = pipState();
  return pipSend({ type: 'pip-join' }).then(function (joined) {
    if (!joined || !joined.ok || typeof RTCPeerConnection !== 'function') {
      stream.getVideoTracks().forEach(function (track) { track.stop(); });
      if (joined && joined.ok) pipSend({ type: 'pip-drop-guest' });
      return false;
    }
    stopGuestCapture(false);
    state.guestActive = true;
    state.guestVideo = video;
    state.guestStream = stream;
    hideGuestVideo(video);
    bindGuestKeepAlive(video);
    connectPipPort();
    watchPipSession();
    var pc = pipPeerConnection();
    state.guestPc = pc;
    state.guestIce = [];
    stream.getVideoTracks().forEach(function (track) { pc.addTrack(track, stream); });
    pc.onicecandidate = function (event) {
      if (!event.candidate) return;
      pipSend({ type: 'pip-signal', candidate: packCandidate(event.candidate) });
    };
    return pc.createOffer().then(function (offer) {
      return pc.setLocalDescription(offer);
    }).then(function () {
      if (state.pendingAnswer && pc.signalingState === 'have-local-offer') {
        applyGuestAnswer(pc, state.pendingAnswer);
      }
      return waitForIce(pc);
    }).then(function () {
      return pipSend({
        type: 'pip-add',
        sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }
      });
    }).then(function (response) {
      if (!response || !response.ok) {
        stopGuestTile(true);
        pipSend({ type: 'pip-drop-guest' });
        return false;
      }
      return true;
    });
  }).catch(function () {
    stopGuestTile(true);
    pipSend({ type: 'pip-drop-guest' });
    return false;
  });
}

function stopGuestCapture(pause) {
  var state = pipState();
  unbindGuestKeepAlive();
  if (state.guestPc) {
    try { state.guestPc.close(); } catch (e) {}
    state.guestPc = null;
  }
  if (state.guestStream) {
    state.guestStream.getVideoTracks().forEach(function (track) { track.stop(); });
    state.guestStream = null;
  }
  state.guestVideo = null;
  restoreGuestVideo(pause);
}

function stopGuestTile(silent) {
  var state = pipState();
  if (state.stoppingGuest) return;
  state.stoppingGuest = true;
  var was = state.guestActive;
  state.guestActive = false;
  stopGuestCapture(false);
  disconnectPipPort();
  if (!extensionPipOpen()) releasePipSession();
  state.stoppingGuest = false;
  if (was && !silent) pipSend({ type: 'pip-drop-guest' });
}

function retargetGuest(video) {
  var state = pipState();
  var stream = guestCapture(video);
  if (!stream) return;
  var track = stream.getVideoTracks()[0];
  var previous = state.guestStream;
  restoreGuestVideo(true);
  hideGuestVideo(video);
  state.guestStream = stream;
  state.guestVideo = video;
  holdSpeed(video);
  var pc = state.guestPc;
  var sender = pc && pc.getSenders && pc.getSenders().filter(function (item) {
    return item.track && item.track.kind === 'video';
  })[0];
  var replaced = sender && sender.replaceTrack ? sender.replaceTrack(track) : null;
  Promise.resolve(replaced).then(function () {
    if (!previous) return;
    previous.getVideoTracks().forEach(function (item) {
      if (item !== track) item.stop();
    });
  }).catch(function () {});
}

function updateGuestTile() {
  var state = pipState();
  var logical = state.guestVideo;
  if (!logical) return;
  applyGuestHide(logical);
  if (logical.paused && logical.play) {
    var pending = logical.play();
    if (pending && pending.catch) pending.catch(function () {});
  }
  watchPipSession();
  var live = isCurrentLive(logical);
  var candidate = findReplacementVideo(logical, live);
  var target = candidate && shouldSwitchPipVideo(logical, candidate, live) ? candidate : logical;
  if (target !== logical) retargetGuest(target);
}

function pipDragBlocked(target) {
  var node = target;
  while (node) {
    var tag = node.tagName;
    if (tag === 'INPUT' || tag === 'BUTTON') return true;
    var cls = node.className;
    if (typeof cls === 'string' && (
      cls.indexOf('pip-volume') !== -1 ||
      cls.indexOf('pip-seek') !== -1 ||
      cls.indexOf('pip-mute') !== -1 ||
      cls.indexOf('pip-tile-close') !== -1
    )) return true;
    node = node.parentNode;
  }
  return false;
}

var pipMoveQueue = null;
var pipMoveSending = false;

function queuePipMove(dx, dy) {
  if (!pipMoveQueue) pipMoveQueue = { dx: 0, dy: 0 };
  pipMoveQueue.dx += dx;
  pipMoveQueue.dy += dy;
  if (pipMoveSending) return;
  pipMoveSending = true;
  var batch = pipMoveQueue;
  pipMoveQueue = null;
  pipSend({ type: 'pip-move', dx: batch.dx, dy: batch.dy }).then(function () {
    pipMoveSending = false;
    if (pipMoveQueue) queuePipMove(0, 0);
  });
}

function installPipDrag(stage) {
  if (!stage || stage.__pipDrag) return;
  stage.__pipDrag = true;
  var drag = null;
  var suppressClick = false;
  stage.addEventListener('pointerdown', function (event) {
    if (event.button !== 0 || event.isPrimary === false) return;
    if (pipDragBlocked(event.target)) return;
    drag = {
      pointerId: event.pointerId,
      startX: event.screenX,
      startY: event.screenY,
      lastX: event.screenX,
      lastY: event.screenY,
      moved: false
    };
    try { stage.setPointerCapture(event.pointerId); } catch (e) {}
  }, true);
  stage.addEventListener('pointermove', function (event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    var dx;
    var dy;
    if (!drag.moved) {
      if (Math.abs(event.screenX - drag.startX) + Math.abs(event.screenY - drag.startY) < 4) return;
      drag.moved = true;
      if (stage.classList) stage.classList.add('pip-dragging');
      dx = event.screenX - drag.startX;
      dy = event.screenY - drag.startY;
    } else {
      dx = event.screenX - drag.lastX;
      dy = event.screenY - drag.lastY;
    }
    drag.lastX = event.screenX;
    drag.lastY = event.screenY;
    if (dx || dy) queuePipMove(dx, dy);
  });
  function endDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    suppressClick = drag.moved;
    drag = null;
    if (stage.classList) stage.classList.remove('pip-dragging');
  }
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('click', function (event) {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

installPipWatcher();
