import EventEmitter from "events";
import { CallFeed, CallFeedEvent } from "./callFeed";
import { CallErrorCode, CallEvent, MatrixCall } from "./call";
import { RoomMember } from "../models/room-member";
import { SDPStreamMetadataPurpose } from "./callEventTypes";
import { GroupCall, GroupCallEvent } from "./groupCall";

export enum GroupCallParticipantEvent {
    Speaking = "speaking",
    VolumeChanged = "volume_changed",
    MuteStateChanged = "mute_state_changed",
    Datachannel = "datachannel",
    CallReplaced = "call_replaced"
}

export class GroupCallParticipant extends EventEmitter {
    public feeds: CallFeed[] = [];
    public activeSpeaker: boolean;
    public activeSpeakerSamples: number[];
    public dataChannel?: RTCDataChannel;

    constructor(
        private groupCall: GroupCall,
        public member: RoomMember,
        // The session id is used to re-initiate calls if the user's participant
        // session id has changed
        public sessionId: string,
        public call?: MatrixCall,
    ) {
        super();

        this.activeSpeakerSamples = Array(groupCall.activeSpeakerSampleCount).fill(
            -Infinity,
        );

        if (this.call) {
            this.call.on(CallEvent.State, this.onCallStateChanged);
            this.call.on(CallEvent.FeedsChanged, this.onCallFeedsChanged);
            this.call.on(CallEvent.Replaced, this.onCallReplaced);
            this.call.on(CallEvent.Hangup, this.onCallHangup);
        }
    }

    public replaceCall(call: MatrixCall, sessionId: string) {
        const oldCall = this.call;

        if (this.call) {
            this.call.hangup(CallErrorCode.Replaced, false);
            this.call.removeListener(CallEvent.State, this.onCallStateChanged);
            this.call.removeListener(
                CallEvent.FeedsChanged,
                this.onCallFeedsChanged,
            );
            this.call.removeListener(CallEvent.Replaced, this.onCallReplaced);
            this.call.removeListener(CallEvent.Hangup, this.onCallHangup);
            this.call.removeListener(CallEvent.DataChannel, this.onCallDataChannel);
        }

        this.call = call;
        this.member = call.getOpponentMember();
        this.activeSpeaker = false;
        this.sessionId = sessionId;

        this.call.on(CallEvent.State, this.onCallStateChanged);
        this.call.on(CallEvent.FeedsChanged, this.onCallFeedsChanged);
        this.call.on(CallEvent.Replaced, this.onCallReplaced);
        this.call.on(CallEvent.Hangup, this.onCallHangup);
        this.call.on(CallEvent.DataChannel, this.onCallDataChannel);

        this.groupCall.emit(GroupCallParticipantEvent.CallReplaced, this, oldCall, call);
    }

    public get usermediaFeed() {
        return this.feeds.find((feed) => feed.purpose === SDPStreamMetadataPurpose.Usermedia);
    }

    public get usermediaStream(): MediaStream {
        return this.usermediaFeed?.stream;
    }

    public isAudioMuted(): boolean {
        const feed = this.usermediaFeed;

        if (!feed) {
            return true;
        }

        return feed.isAudioMuted();
    }

    public isVideoMuted(): boolean {
        const feed = this.usermediaFeed;

        if (!feed) {
            return true;
        }

        return feed.isVideoMuted();
    }

    private onCallStateChanged = (state) => {
        const call = this.call;
        const audioMuted = this.groupCall.localParticipant.isAudioMuted();

        if (
            call.localUsermediaStream &&
            call.isMicrophoneMuted() !== audioMuted
        ) {
            call.setMicrophoneMuted(audioMuted);
        }

        const videoMuted = this.groupCall.localParticipant.isVideoMuted();

        if (
            call.localUsermediaStream &&
            call.isLocalVideoMuted() !== videoMuted
        ) {
            call.setLocalVideoMuted(videoMuted);
        }
    };

    onCallFeedsChanged = () => {
        const oldFeeds = this.feeds;
        const newFeeds = this.call.getRemoteFeeds();

        this.feeds = [];

        for (const feed of newFeeds) {
            if (oldFeeds.includes(feed)) {
                continue;
            }

            this.addCallFeed(feed);
        }
    };

    onCallReplaced = (newCall) => {
        // TODO: Should we always reuse the sessionId?
        this.replaceCall(newCall, this.sessionId);
    };

    onCallHangup = () => {
        if (this.call.hangupReason === CallErrorCode.Replaced) {
            return;
        }

        const participantIndex = this.groupCall.participants.indexOf(this);

        if (participantIndex === -1) {
            return;
        }

        this.groupCall.participants.splice(participantIndex, 1);

        if (
            this.groupCall.activeSpeaker === this &&
            this.groupCall.participants.length > 0
        ) {
            this.groupCall.activeSpeaker = this.groupCall.participants[0];
            this.groupCall.activeSpeaker.activeSpeaker = true;
            this.groupCall.emit(GroupCallEvent.ActiveSpeakerChanged, this.groupCall.activeSpeaker);
        }

        this.groupCall.emit(GroupCallEvent.ParticipantsChanged, this.groupCall.participants);
    };

    addCallFeed(callFeed: CallFeed) {
        if (callFeed.purpose === SDPStreamMetadataPurpose.Usermedia) {
            callFeed.setSpeakingThreshold(this.groupCall.speakingThreshold);
            callFeed.measureVolumeActivity(true);
            callFeed.on(CallFeedEvent.Speaking, this.onCallFeedSpeaking);
            callFeed.on(
                CallFeedEvent.VolumeChanged,
                this.onCallFeedVolumeChanged,
            );
            callFeed.on(
                CallFeedEvent.MuteStateChanged,
                this.onCallFeedMuteStateChanged,
            );
            this.onCallFeedMuteStateChanged(
                this.isAudioMuted(),
                this.isVideoMuted(),
            );
        }

        this.feeds.push(callFeed);
    }

    onCallFeedSpeaking = (speaking: boolean) => {
        this.emit(GroupCallParticipantEvent.Speaking, speaking);
    };

    onCallFeedVolumeChanged = (maxVolume: number) => {
        this.activeSpeakerSamples.shift();
        this.activeSpeakerSamples.push(maxVolume);
        this.emit(GroupCallParticipantEvent.VolumeChanged, maxVolume);
    };

    onCallFeedMuteStateChanged = (audioMuted: boolean, videoMuted: boolean) => {
        if (audioMuted) {
            this.activeSpeakerSamples = Array(this.groupCall.activeSpeakerSampleCount).fill(
                -Infinity,
            );
        }

        this.emit(GroupCallParticipantEvent.MuteStateChanged, audioMuted, videoMuted);
    };

    onCallDataChannel = (dataChannel: RTCDataChannel) => {
        this.dataChannel = dataChannel;
        this.emit(GroupCallParticipantEvent.Datachannel, dataChannel);
    };
}
