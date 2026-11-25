// Copyright 2025 Google LLC
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

installPipWatcher();

// Automatic PiP stays on the top document. A frame only keeps the wheel and
// shortcut controls, so an embedded advert cannot take the PiP window.
if (isTopFrame()) {
navigator.mediaSession.setActionHandler("enterpictureinpicture", async () => {
  const video = findLargestPlayingVideo();
  if (video && needsNativePip(video)) {
    if (extensionPipOpen() && !documentPipWindow()) return;
    await presentNativePip(video);
    return;
  }
  if (pipState().guestActive) return;
  const status = await pipSend({ type: 'pip-status' });
  if (status && ((status.hostTabId != null && !status.isHost) || status.isGuest)) return;
  if (!video) return;
  if (!isTopFrame()) {
    if (status && status.hostTabId != null) return;
    return requestPictureInPicture(video);
  }
  if (status && status.isHost && documentPipWindow()) return;
  const claim = await claimPipHost();
  if (claim && !claim.ok) return;
  try {
    return await requestPictureInPicture(video);
  } finally {
    if (pipState().hostClaimed && documentPipWindow()) {
      connectPipPort();
      flushPendingGuests();
    } else if (pipState().hostClaimed) {
      releasePipHost();
    }
  }
});
}
