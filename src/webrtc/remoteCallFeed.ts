/*
Copyright 2023 The Matrix.org Foundation C.I.C.

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

import { logger } from "../logger";
import { CallEvent, CallState, MatrixCall } from "./call";
import { SDPStreamMetadataObject, SDPStreamMetadataPurpose } from "./callEventTypes";
import { CallFeed, CallFeedEvent, ICallFeedOpts } from "./callFeed";
import { RemoteCallTrack } from "./remoteCallTrack";

export interface RemoteCallFeedOpts extends ICallFeedOpts {
    streamId: string;
    metadata?: SDPStreamMetadataObject;
    call: MatrixCall;

    /**
     * @deprecated addTransceiver() should be used instead
     */
    stream?: MediaStream;
}

/**
 * RemoteCallFeed is a wrapper around MediaStream. It represents an incoming
 * stream.
 */
export class RemoteCallFeed extends CallFeed {
    private _connected = false;
    private _metadata?: SDPStreamMetadataObject;

    protected _tracks: RemoteCallTrack[] = [];
    protected call: MatrixCall;
    protected _stream: MediaStream;

    public readonly streamId: string;
    public readonly isLocal = false;
    public readonly isRemote = true;

    public constructor(opts: RemoteCallFeedOpts) {
        super(opts);

        if (!opts.metadata && opts.call.opponentSupportsSDPStreamMetadata()) {
            throw new Error(
                "Cannot create RemoteCallFeed without metadata if the opponents supports sending sdp_stream_metadata",
            );
        }

        this.streamId = opts.streamId;
        this.call = opts.call;
        this.metadata = opts.metadata;

        this._stream = opts.stream || new window.MediaStream();

        if (opts.call) {
            opts.call.addListener(CallEvent.State, this.onCallState);
        }
        this.updateConnected();
    }

    public get id(): string {
        return this.streamId;
    }

    public get metadata(): SDPStreamMetadataObject | undefined {
        return this._metadata;
    }

    public set metadata(metadata: SDPStreamMetadataObject | undefined) {
        if (!metadata) return;

        this._metadata = metadata;

        this.audioTracks.forEach((track) => (track.metadataMuted = metadata.audio_muted ?? false));
        this.videoTracks.forEach((track) => (track.metadataMuted = metadata.video_muted ?? false));

        if (!metadata.tracks) return;
        for (const [metadataTrackId, metadataTrack] of Object.entries(metadata.tracks)) {
            const track = this._tracks.find((track) => track.trackId === metadataTrackId);
            if (track) {
                track.metadata = metadataTrack;
                continue;
            }

            logger.info(
                `RemoteCallFeed ${this.id} set metadata() adding track (streamId=${this.streamId} trackId=${metadataTrackId}, kind=${metadataTrack.kind})`,
            );
            this._tracks.push(
                new RemoteCallTrack({
                    call: this.call,
                    trackId: metadataTrackId,
                    metadataMuted:
                        (metadataTrack.kind === "audio" ? metadata.audio_muted : metadata.video_muted) ?? false,
                    metadata: metadataTrack,
                }),
            );
        }

        for (const track of this._tracks) {
            if (!track.trackId) continue;
            if (!Object.keys(metadata.tracks).includes(track.trackId)) {
                logger.info(
                    `RemoteCallFeed ${this.id} set metadata() removing track (streamId=${this.streamId} trackId=${track.trackId}, kind=${track.kind})`,
                );
                this._tracks.splice(this._tracks.indexOf(track), 1);
                if (track.track) {
                    this.stream?.removeTrack(track.track);
                }
            }
        }

        this.emit(CallFeedEvent.MuteStateChanged, this.audioMuted, this.videoMuted);
    }

    public get purpose(): SDPStreamMetadataPurpose {
        // If the opponent did not send a purpose, they probably don't support
        // sdp_stream_metadata, so we can assume they're only sending usermedia
        return this._metadata?.purpose ?? SDPStreamMetadataPurpose.Usermedia;
    }

    public get userId(): string {
        const metadataUserId = this._metadata?.user_id;
        return this.call.isFocus && metadataUserId
            ? metadataUserId
            : (this.call.invitee ?? this.call.getOpponentMember()?.userId)!;
    }

    public get deviceId(): string | undefined {
        return this.call.isFocus ? this._metadata?.device_id : this.call.getOpponentDeviceId();
    }

    public get tracks(): RemoteCallTrack[] {
        return [...this._tracks];
    }

    public get audioTracks(): RemoteCallTrack[] {
        return super.audioTracks as RemoteCallTrack[];
    }

    public get videoTracks(): RemoteCallTrack[] {
        return super.videoTracks as RemoteCallTrack[];
    }

    public get connected(): boolean {
        return this._connected;
    }

    private set connected(connected: boolean) {
        if (this._connected === connected) return;
        this._connected = connected;
        this.emit(CallFeedEvent.ConnectedChanged, this.connected);
    }

    private onCallState = (): void => {
        this.updateConnected();
    };

    private updateConnected(): void {
        if (this.call?.state === CallState.Connecting) {
            this.connected = false;
        } else if (!this.stream) {
            this.connected = false;
        } else if (this.stream.getTracks().length === 0) {
            this.connected = false;
        } else if (this.call?.state === CallState.Connected) {
            this.connected = true;
        }
    }

    private streamIdMatches(transceiver: RTCRtpTransceiver): boolean {
        if (!transceiver.mid) return false;
        if (this.streamId !== this.call.getRemoteStreamIdByMid(transceiver.mid)) return false;

        return true;
    }

    public canAddTransceiver(transceiver: RTCRtpTransceiver): boolean {
        if (!transceiver.mid) return false;

        // If the opponent does not support sdp_stream_metadata at all, we
        // always allow adding transceivers
        if (!this._metadata) return true;
        // If the opponent does not support tracks on sdp_stream_metadata, we
        // just check the streamId
        if (!this._metadata.tracks && this.streamIdMatches(transceiver)) return true;

        if (!this._tracks.some((track) => track.canSetTransceiver(transceiver))) return false;
        if (!this.streamIdMatches(transceiver)) return false;

        return true;
    }

    public addTransceiver(transceiver: RTCRtpTransceiver): void {
        if (!transceiver.mid) {
            throw new Error("RemoteCallFeed addTransceiver() called with transceiver without an mid");
        }
        if (!transceiver.receiver?.track) {
            throw new Error("RemoteCallFeed addTransceiver() called with transceiver without a receiver or track");
        }
        if (!this.canAddTransceiver(transceiver)) {
            throw new Error("RemoteCallFeed addTransceiver() called with wrong trackId or streamId");
        }

        const track = this._tracks.find((t) => t.canSetTransceiver(transceiver));
        const trackId = this.call.getRemoteTrackIdByMid(transceiver.mid);

        const trackInfo = `streamId=${this.streamId}, trackId=${trackId}, kind=${transceiver.receiver.track.kind}`;
        logger.log(`RemoteCallFeed ${this.id} addTransceiver() running (${trackInfo})`);

        if (!track && !this._metadata?.tracks) {
            // If the opponent does not support tracks on sdp_stream_metadata or
            // it does not support sdp_stream_metadata at all, we simply create
            // new tracks
            logger.info(`RemoteCallFeed ${this.id} addTransceiver() adding track (${trackInfo})`);
            const track = new RemoteCallTrack({
                call: this.call,
                metadataMuted:
                    (transceiver.receiver.track.kind === "audio"
                        ? this._metadata?.audio_muted
                        : this._metadata?.video_muted) ?? false,
                trackId,
            });
            track.setTransceiver(transceiver);
            this._tracks.push(track);
        } else if (!track) {
            logger.warn(`RemoteCallFeed ${this.id} addTransceiver() did not find track for transceiver (${trackInfo})`);
            return;
        } else {
            track.setTransceiver(transceiver);
        }

        this.stream?.addTrack(transceiver.receiver.track);
        this.startMeasuringVolume();
        this.updateConnected();
        this.emit(CallFeedEvent.NewStream, this.stream);
    }

    public dispose(): void {
        super.dispose();
        this.call?.removeListener(CallEvent.State, this.onCallState);
    }
}
