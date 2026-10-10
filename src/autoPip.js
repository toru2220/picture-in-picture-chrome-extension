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

// Request video to automatically enter picture-in-picture when eligible.
// Another tab's tiled window stays as it is. A video that cannot move into
// Document PiP closes every open PiP window and uses the browser's own PiP.
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
