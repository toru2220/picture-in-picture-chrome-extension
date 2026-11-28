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

(async () => {
  installPipWatcher();
  const video = findLargestPlayingVideo();
  if (video && needsNativePip(video)) {
    if (extensionPipOpen() && !documentPipWindow()) {
      exitExtensionPip();
      return;
    }
    await presentNativePip(video);
    return;
  }
  const status = await pipSend({ type: 'pip-status' });
  if (status && status.isGuest) {
    if (pipState().guestActive) stopGuestTile(false);
    return;
  }
  // Exit whenever this document is already in PiP. The session may have moved
  // to a different element than the largest one on the page.
  if (extensionPipOpen()) {
    exitExtensionPip();
    return;
  }
  if (!video) return;
  if (!isTopFrame()) {
    if (status && status.hostTabId != null && !status.isHost) {
      await startGuestTile(video);
      return;
    }
    if (status && status.hostTabId != null) return;
    // This click also runs in the top frame, which opens Document PiP. A
    // native PiP from here would close that window as soon as it appears.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const again = await pipSend({ type: 'pip-status' });
    if (again && again.hostTabId != null) {
      if (!again.isHost) await startGuestTile(video);
      return;
    }
    await requestPictureInPicture(video);
    return;
  }
  if (status && status.hostTabId != null && !status.isHost) {
    await startGuestTile(video);
    return;
  }
  const claim = await claimPipHost();
  if (claim && !claim.ok) {
    if (!claim.sameTab) await startGuestTile(video);
    return;
  }
  try {
    await requestPictureInPicture(video);
  } finally {
    if (pipState().hostClaimed && documentPipWindow()) {
      connectPipPort();
      flushPendingGuests();
    } else if (pipState().hostClaimed) {
      releasePipHost();
    }
  }
})();
