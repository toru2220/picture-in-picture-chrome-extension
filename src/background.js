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
let pipHost = null;
let pipWindowId = null;
let nativeTakeoverUntil = 0;
const pipGuests = new Map();

function sendTo(target, message) {
  if (!target) return;
  chrome.tabs.sendMessage(target.tabId, message, { frameId: target.frameId }).catch(() => {});
}

function clearHost(skipTabId) {
  const host = pipHost;
  const guests = Array.from(pipGuests.values());
  pipHost = null;
  pipWindowId = null;
  pipGuests.clear();
  guests.forEach((guest) => sendTo(guest, { type: "pip-host-gone" }));
  if (!host || host.tabId === skipTabId) return;
  sendTo(host, { type: "pip-host-released" });
}

function dropGuest(tabId, silentGuest) {
  const guest = pipGuests.get(tabId);
  pipGuests.delete(tabId);
  if (guest && !silentGuest) sendTo(guest, { type: "pip-guest-stop" });
  if (pipHost) sendTo(pipHost, { type: "pip-guest-remove", tabId });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !sender.tab) return;
  const tabId = sender.tab.id;
  const frameId = sender.frameId;
  if (message.type === "pip-status") {
    sendResponse({
      hostTabId: pipHost ? pipHost.tabId : null,
      isHost: !!(pipHost && pipHost.tabId === tabId),
      isGuest: pipGuests.has(tabId),
    });
    return;
  }
  if (message.type === "pip-exit-all") {
    nativeTakeoverUntil = Date.now() + 2000;
    clearHost(tabId);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "pip-claim-host") {
    if (Date.now() < nativeTakeoverUntil) {
      sendResponse({ ok: false, hostTabId: pipHost ? pipHost.tabId : null, sameTab: false });
      return;
    }
    if (pipHost && (pipHost.tabId !== tabId || pipHost.frameId !== frameId)) {
      sendResponse({
        ok: false,
        hostTabId: pipHost.tabId,
        sameTab: pipHost.tabId === tabId,
      });
      return;
    }
    pipHost = { tabId, frameId };
    sendResponse({ ok: true, hostTabId: tabId });
    return;
  }
  if (message.type === "pip-release-host") {
    if (pipHost && pipHost.tabId === tabId) clearHost();
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "pip-join") {
    if (!pipHost || pipHost.tabId === tabId) {
      sendResponse({ ok: false });
      return;
    }
    pipGuests.set(tabId, { tabId, frameId });
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "pip-add") {
    if (!pipHost || pipHost.tabId === tabId) {
      sendResponse({ ok: false });
      return;
    }
    pipGuests.set(tabId, { tabId, frameId });
    sendTo(pipHost, { type: "pip-add", fromTabId: tabId, sdp: message.sdp });
    sendResponse({ ok: true });
    return;
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
      sendTo(pipHost, {
        type: "pip-signal",
        fromTabId: tabId,
        sdp: message.sdp,
        candidate: message.candidate,
      });
    }
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "pip-drop-guest") {
    dropGuest(message.tabId != null ? message.tabId : tabId);
    return;
  }
  if (message.type === "pip-remember-window") {
    rememberPipWindow().then(sendResponse);
    return true;
  }
  if (message.type === "pip-move") {
    movePipBy(message.dx, message.dy).then(sendResponse);
    return true;
  }
});

function rememberPipWindow() {
  return chrome.windows.getAll().then((wins) => {
    const pip = wins.find((win) => win.alwaysOnTop);
    pipWindowId = pip ? pip.id : null;
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
    if (pipHost && pipHost.tabId === tabId && pipHost.frameId === frameId) clearHost();
    else if (pipGuests.has(tabId)) dropGuest(tabId, true);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (pipHost && pipHost.tabId === tabId) clearHost();
  else if (pipGuests.has(tabId)) dropGuest(tabId, true);
});

function updateContentScripts(autoPip) {
  chrome.action.setTitle({title: `Automatic picture-in-picture (${autoPip ? "on" : "off"})`});
  chrome.action.setBadgeText({ text: autoPip ? "★" : "" });
  // Replace any previously registered script so a file-list change takes effect.
  const removed = chrome.scripting.unregisterContentScripts({ ids: ["autoPip"] }).catch(() => {});
  if (!autoPip) return;
  removed.then(() => {
    chrome.scripting.registerContentScripts([{
      id: "autoPip",
      js: ["pip.js", "autoPip.js"],
      matches: ["<all_urls>"],
      runAt: "document_start"
    }]);
  });
}
