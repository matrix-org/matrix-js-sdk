import EventEmitter from "events";
import { CallFeed, CallFeedEvent } from "./callFeed";
import { MatrixClient } from "../client";
import { randomString } from "../randomstring";
import { CallErrorCode, CallEvent, CallState, CallType, MatrixCall } from "./call";
import { RoomMember } from "../models/room-member";
import { SDPStreamMetadataPurpose } from "./callEventTypes";
import { Room } from "../models/room";
import { logger } from "../logger";
import { Callback } from "../client";
import { ReEmitter } from "../ReEmitter";

export enum GroupCallEvent {
    Entered = "entered",
    Left = "left",
    ActiveSpeakerChanged = "active_speaker_changed",
    ParticipantsChanged = "participants_changed",
    LocalMuteStateChanged = "local_mute_state_changed",
}

const CONF_ROOM = "me.robertlong.conf";
const CONF_PARTICIPANT = "me.robertlong.conf.participant";
const PARTICIPANT_TIMEOUT = 1000 * 15;
const SPEAKING_THRESHOLD = -80;
const ACTIVE_SPEAKER_INTERVAL = 1000;
const ACTIVE_SPEAKER_SAMPLES = 8;

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

        this.activeSpeakerSamples = Array(ACTIVE_SPEAKER_SAMPLES).fill(
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
            callFeed.setSpeakingThreshold(SPEAKING_THRESHOLD);
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
            this.activeSpeakerSamples = Array(ACTIVE_SPEAKER_SAMPLES).fill(
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

export class GroupCall extends EventEmitter {
    public entered = false;
    public activeSpeaker: GroupCallParticipant;
    public localParticipant: GroupCallParticipant;
    public participants: GroupCallParticipant[] = [];
    public room: Room;

    private speakerMap: Map<RoomMember, number[]> = new Map();
    private presenceLoopTimeout?: number;
    private activeSpeakerLoopTimeout: number;
    private reEmitter: ReEmitter;

    constructor(
        private client: MatrixClient,
        roomId: string,
        public type: CallType,
        private dataChannelsEnabled?: boolean,
        private dataChannelOptions?: RTCDataChannelInit,
    ) {
        super();

        this.room = this.client.getRoom(roomId);
        this.reEmitter = new ReEmitter(this);
    }

    async initLocalParticipant() {
        if (this.localParticipant) {
            return this.localParticipant;
        }

        let stream;

        if (this.type === CallType.Video) {
            stream = await this.client.getLocalVideoStream();
        } else {
            stream = await this.client.getLocalAudioStream();
        }

        const userId = this.client.getUserId();

        const localCallFeed = new CallFeed(
            stream,
            userId,
            SDPStreamMetadataPurpose.Usermedia,
            this.client,
            this.room.roomId,
            false,
            false,
        );

        const member = this.room.getMember(userId);

        this.localParticipant = new GroupCallParticipant(
            this,
            member,
            randomString(16),
        );
        this.localParticipant.addCallFeed(localCallFeed);

        return this.localParticipant;
    }

    async enter() {
        if (!this.localParticipant) {
            await this.initLocalParticipant();
        }

        // Ensure that this room is marked as a conference room so clients can react appropriately
        const activeConf = this.room.currentState
            .getStateEvents(CONF_ROOM, "")
            ?.getContent()?.active;

        if (!activeConf) {
            this.sendStateEventWithRetry(
                this.room.roomId,
                CONF_ROOM,
                { active: true },
                "",
            );
        }

        this.activeSpeaker = this.localParticipant;
        this.participants.push(this.localParticipant);
        this.reEmitter.reEmit(this.localParticipant, Object.values(GroupCallParticipantEvent));

        // Announce to the other room members that we have entered the room.
        // Continue doing so every PARTICIPANT_TIMEOUT ms
        this.onPresenceLoop();

        this.entered = true;

        this.processInitialCalls();

        // Set up participants for the members currently in the room.
        // Other members will be picked up by the RoomState.members event.
        const initialMembers = this.room.getMembers();

        for (const member of initialMembers) {
            this.onMemberChanged(member);
        }

        this.client.on("RoomState.members", this.onRoomStateMembers);
        this.client.on("Call.incoming", this.onIncomingCall);

        this.emit(GroupCallEvent.Entered);
        this.onActiveSpeakerLoop();
    }

    leave() {
        this.localParticipant = null;
        this.client.stopLocalMediaStream();

        if (!this.entered) {
            return;
        }

        const userId = this.client.getUserId();
        const currentMemberState = this.room.currentState.getStateEvents(
            "m.room.member",
            userId,
        );

        this.sendStateEventWithRetry(
            this.room.roomId,
            "m.room.member",
            {
                ...currentMemberState.getContent(),
                [CONF_PARTICIPANT]: null,
            },
            userId,
        );

        for (const participant of this.participants) {
            if (participant.call) {
                participant.call.hangup(CallErrorCode.UserHangup, false);
            }
        }

        this.entered = false;
        this.participants = [];
        this.activeSpeaker = null;
        this.speakerMap.clear();
        clearTimeout(this.presenceLoopTimeout);
        clearTimeout(this.activeSpeakerLoopTimeout);

        this.client.removeListener(
            "RoomState.members",
            this.onRoomStateMembers,
        );
        this.client.removeListener("Call.incoming", this.onIncomingCall);

        this.emit(GroupCallEvent.Left);
    }

    isLocalVideoMuted() {
        if (this.localParticipant) {
            return this.localParticipant.isVideoMuted();
        }

        return true;
    }

    isMicrophoneMuted() {
        if (this.localParticipant) {
            return this.localParticipant.isAudioMuted();
        }

        return true;
    }

    setMicrophoneMuted(muted) {
        if (this.localParticipant) {
            for (const { stream } of this.localParticipant.feeds) {
                for (const track of stream.getTracks()) {
                    if (track.kind === "audio") {
                        track.enabled = !muted;
                    }
                }
            }
        }

        for (const { call } of this.participants) {
            if (
                call &&
                call.localUsermediaStream &&
                call.isMicrophoneMuted() !== muted
            ) {
                call.setMicrophoneMuted(muted);
            }
        }

        this.emit(GroupCallEvent.LocalMuteStateChanged, muted, this.isLocalVideoMuted());
    }

    setLocalVideoMuted(muted) {
        if (this.localParticipant) {
            for (const { stream } of this.localParticipant.feeds) {
                for (const track of stream.getTracks()) {
                    if (track.kind === "video") {
                        track.enabled = !muted;
                    }
                }
            }
        }

        for (const { call } of this.participants) {
            if (
                call &&
                call.localUsermediaStream &&
                call.isLocalVideoMuted() !== muted
            ) {
                call.setLocalVideoMuted(muted);
            }
        }

        this.emit(GroupCallEvent.LocalMuteStateChanged, this.isMicrophoneMuted(), muted);
    }

    public get localUsermediaFeed(): CallFeed {
        return this.localParticipant?.usermediaFeed;
    }

    public get localUsermediaStream(): MediaStream {
        return this.localParticipant?.usermediaStream;
    }

    /**
     * Call presence
     */

    onPresenceLoop = () => {
        const userId = this.client.getUserId();
        const currentMemberState = this.room.currentState.getStateEvents(
            "m.room.member",
            userId,
        );

        this.sendStateEventWithRetry(
            this.room.roomId,
            "m.room.member",
            {
                ...currentMemberState.getContent(),
                [CONF_PARTICIPANT]: {
                    sessionId: this.localParticipant.sessionId,
                    expiresAt: new Date().getTime() + PARTICIPANT_TIMEOUT * 2,
                },
            },
            userId,
        );

        const now = new Date().getTime();

        for (const participant of this.participants) {
            if (participant === this.localParticipant) {
                continue;
            }

            const memberStateEvent = this.room.currentState.getStateEvents(
                "m.room.member",
                participant.member.userId,
            );

            const memberStateContent = memberStateEvent.getContent();

            if (
                !memberStateContent ||
                !memberStateContent[CONF_PARTICIPANT] ||
                typeof memberStateContent[CONF_PARTICIPANT] !== "object" ||
                (memberStateContent[CONF_PARTICIPANT].expiresAt &&
                    memberStateContent[CONF_PARTICIPANT].expiresAt < now)
            ) {
                if (participant.call) {
                    // NOTE: This should remove the participant on the next tick
                    // since matrix-js-sdk awaits a promise before firing user_hangup
                    participant.call.hangup(CallErrorCode.UserHangup, false);
                }
            }
        }

        this.presenceLoopTimeout = setTimeout(
            this.onPresenceLoop,
            PARTICIPANT_TIMEOUT,
        );
    };

    /**
     * Call Setup
     *
     * There are two different paths for calls to be created:
     * 1. Incoming calls triggered by the Call.incoming event.
     * 2. Outgoing calls to the initial members of a room or new members
     *    as they are observed by the RoomState.members event.
     */

    processInitialCalls() {
        const calls = this.client.callEventHandler.calls.values();

        for (const call of calls) {
            this.onIncomingCall(call);
        }
    }

    onIncomingCall = (call: MatrixCall) => {
        // The incoming calls may be for another room, which we will ignore.
        if (call.roomId !== this.room.roomId) {
            return;
        }

        if (call.state !== CallState.Ringing) {
            logger.warn("Incoming call no longer in ringing state. Ignoring.");
            return;
        }

        const opponentMember = call.getOpponentMember();

        logger.log(`GroupCall: incomming call from: ${opponentMember.userId}`);

        const memberStateEvent = this.room.currentState.getStateEvents(
            "m.room.member",
            opponentMember.userId,
        );

        const memberStateContent = memberStateEvent.getContent();

        if (!memberStateContent || !memberStateContent[CONF_PARTICIPANT]) {
            call.reject();
            return;
        }

        const { sessionId } = memberStateContent[CONF_PARTICIPANT];

        // Check if the user calling has an existing participant and use this call instead.
        const existingParticipant = this.participants.find(
            (participant) => participant.member.userId === opponentMember.userId,
        );

        let participant;

        if (existingParticipant) {
            participant = existingParticipant;
            // This also fires the hangup event and triggers those side-effects
            existingParticipant.replaceCall(call, sessionId);
            call.answer();
        } else {
            participant = new GroupCallParticipant(
                this,
                opponentMember,
                sessionId,
                call,
            );
            this.participants.push(participant);
            call.answer();
            this.reEmitter.reEmit(participant, Object.values(GroupCallParticipantEvent));
            this.emit(GroupCallEvent.ParticipantsChanged, this.participants);
        }
    };

    onRoomStateMembers = (_event, _state, member: RoomMember) => {
        // The member events may be received for another room, which we will ignore.
        if (member.roomId !== this.room.roomId) {
            return;
        }

        logger.log(`GroupCall member state changed: ${member.userId}`);
        this.onMemberChanged(member);
    };

    onMemberChanged = (member: RoomMember) => {
        // Don't process your own member.
        const localUserId = this.client.getUserId();

        if (member.userId === localUserId) {
            return;
        }

        // Get the latest member participant state event.
        const memberStateEvent = this.room.currentState.getStateEvents(
            "m.room.member",
            member.userId,
        );
        const memberStateContent = memberStateEvent.getContent();

        if (!memberStateContent) {
            return;
        }

        const participantInfo = memberStateContent[CONF_PARTICIPANT];

        if (!participantInfo || typeof participantInfo !== "object") {
            return;
        }

        const { expiresAt, sessionId } = participantInfo;

        // If the participant state has expired, ignore this user.
        const now = new Date().getTime();

        if (expiresAt < now) {
            return;
        }

        // If there is an existing participant for this member check the session id.
        // If the session id changed then we can hang up the old call and start a new one.
        // Otherwise, ignore the member change event because we already have an active participant.
        let participant = this.participants.find(
            (p) => p.member.userId === member.userId,
        );

        if (participant) {
            if (participant.sessionId !== sessionId) {
                participant.call.hangup(CallErrorCode.Replaced, false);
            } else {
                return;
            }
        }

        // Only initiate a call with a user who has a userId that is lexicographically
        // less than your own. Otherwise, that user will call you.
        if (member.userId < localUserId) {
            return;
        }

        const call = this.client.createCall(this.room.roomId, member.userId);

        let callPromise;

        if (this.type === CallType.Video) {
            callPromise = call.placeVideoCall();
        } else {
            callPromise = call.placeVoiceCall();
        }

        callPromise.then(() => {
            if (this.dataChannelsEnabled) {
                call.createDataChannel("datachannel", this.dataChannelOptions);
            }
        });

        if (participant) {
            participant.replaceCall(call, sessionId);
        } else {
            participant = new GroupCallParticipant(
                this,
                member,
                sessionId,
                call,
            );
            // TODO: Should we wait until the call has been answered to push the participant?
            // Or do we hide the participant until their stream is live?
            // Does hiding a participant without a stream present a privacy problem because
            // a participant without a stream can still listen in on other user's streams?
            this.participants.push(participant);
            this.reEmitter.reEmit(participant, Object.values(GroupCallParticipantEvent));
            this.emit(GroupCallEvent.ParticipantsChanged), this.participants;
        }
    };

    onActiveSpeakerLoop = () => {
        let topAvg;
        let nextActiveSpeaker;

        for (const participant of this.participants) {
            let total = 0;

            for (let i = 0; i < participant.activeSpeakerSamples.length; i++) {
                const volume = participant.activeSpeakerSamples[i];
                total += Math.max(volume, SPEAKING_THRESHOLD);
            }

            const avg = total / ACTIVE_SPEAKER_SAMPLES;

            if (!topAvg || avg > topAvg) {
                topAvg = avg;
                nextActiveSpeaker = participant.member;
            }
        }

        if (nextActiveSpeaker && topAvg > SPEAKING_THRESHOLD) {
            if (nextActiveSpeaker && this.activeSpeaker !== nextActiveSpeaker) {
                this.activeSpeaker.activeSpeaker = false;
                nextActiveSpeaker.activeSpeaker = true;
                this.activeSpeaker = nextActiveSpeaker;
                this.emit(GroupCallEvent.ActiveSpeakerChanged, this.activeSpeaker);
            }
        }

        this.activeSpeakerLoopTimeout = setTimeout(
            this.onActiveSpeakerLoop,
            ACTIVE_SPEAKER_INTERVAL,
        );
    };

    /**
     * Utils
     */

    // TODO: move this elsewhere or get rid of the retry logic. Do we need it?
    sendStateEventWithRetry(
        roomId: string,
        eventType: string,
        content: any,
        stateKey?: string,
        callback: Callback = undefined,
        maxAttempts = 5,
    ) {
        const sendStateEventWithRetry = async (attempt = 0) => {
            try {
                return await this.client.sendStateEvent(
                    roomId,
                    eventType,
                    content,
                    stateKey,
                    callback,
                );
            } catch (error) {
                if (attempt >= maxAttempts) {
                    throw error;
                }

                await new Promise<void>((resolve) => setTimeout(resolve, 5));

                return sendStateEventWithRetry(attempt + 1);
            }
        };

        return sendStateEventWithRetry();
    }
}
