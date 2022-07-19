/*
Copyright 2022 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { SDPStreamMetadataPurpose } from "../../../src/webrtc/callEventTypes";
import { CallFeed, CallFeedEvent } from "../../../src/webrtc/callFeed";
import { MockMediaStream, MockMediaStreamTrack } from "../../test-utils/webrtc";
import { TestClient } from "../../TestClient";

describe("CallFeed", () => {
    const roomId = "room_id";

    let client;

    beforeEach(() => {
        client = new TestClient("@alice:foo", "somedevice", "token", undefined, {});
    });

    afterEach(() => {
        client.stop();
    });

    it("should handle stream replacement", () => {
        const feedNewStreamCallback = jest.fn();
        const feed = new CallFeed({
            client,
            roomId,
            userId: "user1",
            // @ts-ignore Mock
            stream: new MockMediaStream("stream1"),
            id: "id",
            purpose: SDPStreamMetadataPurpose.Usermedia,
            audioMuted: false,
            videoMuted: false,
        });
        feed.on(CallFeedEvent.NewStream, feedNewStreamCallback);

        const replacementStream = new MockMediaStream("stream2");
        // @ts-ignore Mock
        feed.setNewStream(replacementStream);
        expect(feedNewStreamCallback).toHaveBeenCalledWith(replacementStream);
        expect(feed.stream).toBe(replacementStream);

        feedNewStreamCallback.mockReset();

        replacementStream.addTrack(new MockMediaStreamTrack("track_id", "audio"));
        expect(feedNewStreamCallback).toHaveBeenCalledWith(replacementStream);
    });
});
