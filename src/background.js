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

chrome.action.onClicked.addListener((tab) => {
  chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    files: ["pip.js", "script.js"],
  });
});

chrome.runtime.onInstalled.addListener(async () => {
  const { autoPip } = await chrome.storage.local.get({ autoPip: true });
  chrome.contextMenus.create({
    id: "autoPip",
    contexts: ["action"],
    title: "Automatic picture-in-picture (BETA)",
    type: "checkbox",
    checked: autoPip,
  });
  updateContentScripts(autoPip);
});

chrome.runtime.onStartup.addListener(async () => {
  const { autoPip } = await chrome.storage.local.get({ autoPip: true });
  chrome.action.setBadgeBackgroundColor({ color: "#4285F4" });
  chrome.action.setBadgeTextColor({ color: "#fff" });
  updateContentScripts(autoPip);
});

chrome.contextMenus.onClicked.addListener(({ checked: autoPip }) => {
  chrome.storage.local.set({ autoPip });
  updateContentScripts(autoPip);
});

// Chrome keeps a single Picture-in-Picture window. The first tab to open
// Document PiP is the host; other tabs add a tile instead of replacing it.
// The service worker is discarded after an idle stretch, and that used to
// forget the host. The next tab then called requestWindow, which replaces
// the window already on screen. Session storage keeps the host across that
// restart. A dropped port is not treated as "closed" until the opener says
// the window is gone, because stopping the worker disconnects the port too.
let pipHost = null;
let pipWindowId = null;
let nativeTakeoverUntil = 0;
const pipGuests = new Map();
const PARTICIPANTS_KEY = "pipParticipants";
let participantsEpoch = 0;
let participantsReady = null;
let participantWrite = Promise.resolve();

function sendTo(target, message) {
  if (!target) return;
  chrome.tabs.sendMessage(target.tabId, message, { frameId: target.frameId }).catch(() => {});
}

function rememberParticipantWrite(work) {
  participantsEpoch += 1;
  const seen = participantsEpoch;
  participantsReady = Promise.resolve();
  participantWrite = participantWrite.then(() => {
    if (seen !== participantsEpoch) return;
    return work();
  }).catch(() => {});
  return participantWrite;
}

function persistParticipants() {
  const payload = {
    host: pipHost,
    windowId: pipWindowId,
    guests: Array.from(pipGuests.values()),
  };
  return rememberParticipantWrite(() => chrome.storage.session.set({ [PARTICIPANTS_KEY]: payload }));
}

function clearStoredParticipants() {
  return rememberParticipantWrite(() => chrome.storage.session.remove(PARTICIPANTS_KEY));
}

function ensureParticipants() {
  if (participantsReady) return participantsReady;
  const seen = participantsEpoch;
  participantsReady = chrome.storage.session.get(PARTICIPANTS_KEY).then((data) => {
    if (seen !== participantsEpoch) return;
    const saved = data && data[PARTICIPANTS_KEY];
    if (!saved) return;
    if (!pipHost && saved.host && saved.host.tabId != null) pipHost = saved.host;
    if (pipWindowId == null && saved.windowId != null) pipWindowId = saved.windowId;
    if (pipGuests.size === 0 && Array.isArray(saved.guests)) {
      saved.guests.forEach((guest) => {
        if (guest && guest.tabId != null) pipGuests.set(guest.tabId, guest);
      });
    }
  }).catch(() => {});
  return participantsReady;
}

function clearHost(skipTabId) {
  const host = pipHost;
  const guests = Array.from(pipGuests.values());
  pipHost = null;
  pipWindowId = null;
  pipGuests.clear();
  clearStoredParticipants();
  guests.forEach((guest) => sendTo(guest, { type: "pip-host-gone" }));
  if (!host || host.tabId === skipTabId) return;
  sendTo(host, { type: "pip-host-released" });
}

function dropGuest(tabId, silentGuest) {
  const guest = pipGuests.get(tabId);
  pipGuests.delete(tabId);
  persistParticipants();
  if (guest && !silentGuest) sendTo(guest, { type: "pip-guest-stop" });
  if (pipHost) sendTo(pipHost, { type: "pip-guest-remove", tabId });
}

// A missing answer means the opener is still the previously loaded script,
// or the worker died mid-question. Treating that as "closed" made the next
// tab open a replacement window. Only an explicit closed answer, or a tab
// that no longer exists, gives the slot away.
function hostStillOpen(host) {
  if (!host || host.tabId == null) return Promise.resolve(false);
  return chrome.tabs.get(host.tabId).then(() => {
    return chrome.tabs.sendMessage(host.tabId, { type: "pip-host-check" }, { frameId: host.frameId })
      .then((response) => !(response && response.open === false))
      .catch(() => true);
  }).catch(() => false);
}

function guestStillActive(guest) {
  if (!guest || guest.tabId == null) return Promise.resolve(false);
  return chrome.tabs.get(guest.tabId).then(() => {
    return chrome.tabs.sendMessage(guest.tabId, { type: "pip-guest-check" }, { frameId: guest.frameId })
      .then((response) => !(response && response.active === false))
      .catch(() => true);
  }).catch(() => false);
}

function confirmHostOrClear(tabId, frameId) {
  return ensureParticipants().then(() => {
    if (!pipHost || pipHost.tabId !== tabId || pipHost.frameId !== frameId) return;
    return hostStillOpen(pipHost).then((open) => {
      if (open) return;
      if (pipHost && pipHost.tabId === tabId && pipHost.frameId === frameId) clearHost();
    });
  });
}

function confirmGuestOrDrop(tabId, frameId) {
  return ensureParticipants().then(() => {
    const guest = pipGuests.get(tabId);
    if (!guest || guest.frameId !== frameId) return;
    return guestStillActive(guest).then((active) => {
      if (active) return;
      if (pipGuests.has(tabId)) dropGuest(tabId, true);
    });
  });
}

function statusPayload(tabId) {
  return {
    hostTabId: pipHost ? pipHost.tabId : null,
    isHost: !!(pipHost && pipHost.tabId === tabId),
    isGuest: pipGuests.has(tabId),
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !sender.tab) return;
  const tabId = sender.tab.id;
  const frameId = sender.frameId;
  handlePipMessage(message, tabId, frameId).then(sendResponse).catch(() => sendResponse({ ok: false }));
  return true;
});

async function handlePipMessage(message, tabId, frameId) {
  await ensureParticipants();
  if (message.type === "pip-status") {
    if (pipHost && !(await hostStillOpen(pipHost))) clearHost();
    return statusPayload(tabId);
  }
  if (message.type === "pip-exit-all") {
    nativeTakeoverUntil = Date.now() + 2000;
    clearHost(tabId);
    return { ok: true };
  }
  if (message.type === "pip-claim-host") {
    if (Date.now() < nativeTakeoverUntil) {
      return { ok: false, hostTabId: pipHost ? pipHost.tabId : null, sameTab: false };
    }
    if (pipHost && (pipHost.tabId !== tabId || pipHost.frameId !== frameId)) {
      if (await hostStillOpen(pipHost)) {
        return {
          ok: false,
          hostTabId: pipHost.tabId,
          sameTab: pipHost.tabId === tabId,
        };
      }
      clearHost();
    }
    pipHost = { tabId, frameId };
    await persistParticipants();
    return { ok: true, hostTabId: tabId };
  }
  // The opener repeats this while its window is up, so a restarted worker
  // learns the host again before another tab tries to open its own window.
  if (message.type === "pip-host-heartbeat") {
    if (pipHost && (pipHost.tabId !== tabId || pipHost.frameId !== frameId)) {
      if (await hostStillOpen(pipHost)) return { ok: false, hostTabId: pipHost.tabId };
      clearHost();
    }
    pipHost = { tabId, frameId };
    await persistParticipants();
    return { ok: true, hostTabId: tabId };
  }
  if (message.type === "pip-release-host") {
    if (pipHost && pipHost.tabId === tabId) clearHost();
    return { ok: true };
  }
  if (message.type === "pip-join") {
    if (!pipHost || pipHost.tabId === tabId) return { ok: false };
    if (!(await hostStillOpen(pipHost))) {
      clearHost();
      return { ok: false };
    }
    pipGuests.set(tabId, { tabId, frameId });
    await persistParticipants();
    return { ok: true };
  }
  if (message.type === "pip-add") {
    if (!pipHost || pipHost.tabId === tabId) return { ok: false };
    pipGuests.set(tabId, { tabId, frameId });
    await persistParticipants();
    sendTo(pipHost, { type: "pip-add", fromTabId: tabId, sdp: message.sdp });
    return { ok: true };
  }
  if (message.type === "pip-signal") {
    if (pipHost && tabId === pipHost.tabId) {
      sendTo(pipGuests.get(message.guestTabId), {
        type: "pip-signal",
        sdp: message.sdp,
        candidate: message.candidate,
      });
    } else if (pipHost) {
      pipGuests.set(tabId, { tabId, frameId });
      await persistParticipants();
      sendTo(pipHost, {
        type: "pip-signal",
        fromTabId: tabId,
        sdp: message.sdp,
        candidate: message.candidate,
      });
    }
    return { ok: true };
  }
  if (message.type === "pip-drop-guest") {
    dropGuest(message.tabId != null ? message.tabId : tabId);
    return { ok: true };
  }
  if (message.type === "pip-remember-window") return rememberPipWindow();
  if (message.type === "pip-move") return movePipBy(message.dx, message.dy);
}

function rememberPipWindow() {
  return chrome.windows.getAll().then((wins) => {
    const pip = wins.find((win) => win.alwaysOnTop);
    pipWindowId = pip ? pip.id : null;
    persistParticipants();
    return { ok: pipWindowId != null };
  }).catch(() => ({ ok: false }));
}

function movePipBy(dx, dy) {
  const amountX = Number(dx) || 0;
  const amountY = Number(dy) || 0;
  const load = pipWindowId == null
    ? rememberPipWindow().then(() => (pipWindowId == null ? null : chrome.windows.get(pipWindowId)))
    : chrome.windows.get(pipWindowId).catch(() => {
      pipWindowId = null;
      return rememberPipWindow().then(() => (pipWindowId == null ? null : chrome.windows.get(pipWindowId)));
    });
  return Promise.resolve(load).then((win) => {
    if (!win || win.left == null || win.top == null) return { ok: false };
    pipWindowId = win.id;
    return chrome.windows.update(win.id, {
      left: Math.round(win.left + amountX),
      top: Math.round(win.top + amountY),
    }).then(() => ({ ok: true }));
  }).catch(() => ({ ok: false }));
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "pip-participant" || !port.sender || !port.sender.tab) return;
  const tabId = port.sender.tab.id;
  const frameId = port.sender.frameId;
  port.onDisconnect.addListener(() => {
    ensureParticipants().then(() => {
      if (pipHost && pipHost.tabId === tabId && pipHost.frameId === frameId) {
        return confirmHostOrClear(tabId, frameId);
      }
      if (pipGuests.has(tabId)) return confirmGuestOrDrop(tabId, frameId);
    }).catch(() => {});
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ensureParticipants().then(() => {
    if (pipHost && pipHost.tabId === tabId) clearHost();
    else if (pipGuests.has(tabId)) dropGuest(tabId, true);
  }).catch(() => {});
});

function updateContentScripts(autoPip) {
  chrome.action.setTitle({title: `Automatic picture-in-picture (${autoPip ? "on" : "off"})`});
  chrome.action.setBadgeText({ text: autoPip ? "★" : "" });
  // Replace any previously registered script so a file-list change takes effect.
  // Wheel and shortcut controls run in every frame. Automatic PiP stays tied to
  // the top document inside autoPip.js.
  const removed = chrome.scripting.unregisterContentScripts({ ids: ["autoPip", "pipPage"] }).catch(() => {});
  removed.then(() => {
    chrome.scripting.registerContentScripts([{
      id: autoPip ? "autoPip" : "pipPage",
      js: autoPip ? ["pip.js", "autoPip.js"] : ["pip.js"],
      matches: ["<all_urls>"],
      allFrames: true,
      runAt: "document_start"
    }]);
  });
}
