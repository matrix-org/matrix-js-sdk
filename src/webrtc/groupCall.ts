import EventEmitter from "events";
import { CallFeed, CallFeedEvent } from "./callFeed";
import { MatrixClient } from "../client";
import { randomString } from "../randomstring";
import { CallErrorCode, CallEvent, CallState, CallType, MatrixCall, setTracksEnabled } from "./call";
import { RoomMember } from "../models/room-member";
import { Room } from "../models/room";
import { logger } from "../logger";
import { ReEmitter } from "../ReEmitter";
import { SDPStreamMetadataPurpose } from "./callEventTypes";

export enum GroupCallEvent {
    GroupCallStateChanged = "group_call_state_changed",
    ActiveSpeakerChanged = "active_speaker_changed",
    CallsChanged = "calls_changed",
    UserMediaFeedsChanged = "user_media_feeds_changed",
    LocalMuteStateChanged = "local_mute_state_changed",
}

export const CONF_ROOM = "me.robertlong.conf";
const CONF_PARTICIPANT = "me.robertlong.conf.participant";

export interface IGroupCallDataChannelOptions {
    ordered: boolean;
    maxPacketLifeTime: number;
    maxRetransmits: number;
    protocol: string;
}

export enum GroupCallState {
    LocalCallFeedUninitialized = "local_call_feed_uninitialized",
    InitializingLocalCallFeed = "initializing_local_call_feed",
    LocalCallFeedInitialized = "local_call_feed_initialized",
    Entering = "entering",
    Entered = "entered",
    Ended = "ended",
}

interface IUserMediaFeedHandlers {
    onCallFeedVolumeChanged: (maxVolume: number) => void;
    onCallFeedMuteStateChanged: (audioMuted: boolean) => void;
}

interface ICallHandlers {
    onCallFeedsChanged: (feeds: CallFeed[]) => void;
    onCallStateChanged: (state: CallState, oldState: CallState) => void;
    onCallHangup: (call: MatrixCall) => void;
}

function getCallUserId(call: MatrixCall): string | null {
    return call.getOpponentMember()?.userId || call.invitee || null;
}

export class GroupCall extends EventEmitter {
    // Config
    public activeSpeakerSampleCount = 8;
    public activeSpeakerInterval = 1000;
    public speakingThreshold = -80;
    public participantTimeout = 1000 * 15;

    public state = GroupCallState.LocalCallFeedUninitialized;
    public activeSpeaker: string; // userId
    public localCallFeed: CallFeed;
    public calls: MatrixCall[] = [];
    public userMediaFeeds: CallFeed[] = [];

    private userMediaFeedHandlers: Map<string, IUserMediaFeedHandlers> = new Map();
    private callHandlers: Map<string, ICallHandlers> = new Map();
    private sessionIds: Map<string, string> = new Map(); // userId -> sessionId
    private activeSpeakerSamples: Map<string, number[]> = new Map();

    private presenceLoopTimeout?: number;
    private activeSpeakerLoopTimeout?: number;
    private reEmitter: ReEmitter;

    constructor(
        private client: MatrixClient,
        public room: Room,
        public type: CallType,
        private dataChannelsEnabled?: boolean,
        private dataChannelOptions?: IGroupCallDataChannelOptions,
    ) {
        super();
        this.reEmitter = new ReEmitter(this);
    }

    public async initLocalCallFeed(): Promise<CallFeed> {
        if (this.state !== GroupCallState.LocalCallFeedUninitialized) {
            throw new Error(`Cannot initialize local call feed in the "${this.state}" state.`);
        }

        this.state = GroupCallState.InitializingLocalCallFeed;

        const stream = await this.client.getMediaHandler().getUserMediaStream(true, this.type === CallType.Video);

        const userId = this.client.getUserId();

        const callFeed = new CallFeed(
            stream,
            userId,
            SDPStreamMetadataPurpose.Usermedia,
            this.client,
            this.room.roomId,
            false,
            false,
        );

        this.sessionIds.set(userId, randomString(16));
        this.activeSpeakerSamples.set(userId, Array(this.activeSpeakerSampleCount).fill(
            -Infinity,
        ));
        this.localCallFeed = callFeed;
        this.addUserMediaFeed(callFeed);

        return callFeed;
    }

    public async enter() {
        if (!(this.state === GroupCallState.LocalCallFeedUninitialized ||
            this.state === GroupCallState.LocalCallFeedInitialized)) {
            throw new Error(`Cannot enter call in the "${this.state}" state`);
        }

        if (this.state === GroupCallState.LocalCallFeedUninitialized) {
            await this.initLocalCallFeed();
        }

        this.activeSpeaker = this.client.getUserId();

        // Announce to the other room members that we have entered the room.
        // Continue doing so every PARTICIPANT_TIMEOUT ms
        this.onPresenceLoop();

        this.state = GroupCallState.Entered;

        this.processInitialCalls();

        // Set up participants for the members currently in the room.
        // Other members will be picked up by the RoomState.members event.
        const initialMembers = this.room.getMembers();

        for (const member of initialMembers) {
            this.onMemberChanged(member);
        }

        this.client.on("RoomState.members", this.onRoomStateMembers);
        this.client.on("Call.incoming", this.onIncomingCall);

        this.emit(GroupCallEvent.GroupCallStateChanged, this.state);
        this.onActiveSpeakerLoop();
    }

    private dispose() {
        if (this.localCallFeed) {
            this.removeUserMediaFeed(this.localCallFeed);
            this.localCallFeed = null;
        }

        this.client.getMediaHandler().stopAllStreams();

        if (this.state !== GroupCallState.Entered) {
            return;
        }

        const userId = this.client.getUserId();
        const currentMemberState = this.room.currentState.getStateEvents(
            "m.room.member",
            userId,
        );

        this.client.sendStateEvent(
            this.room.roomId,
            "m.room.member",
            {
                ...currentMemberState.getContent(),
                [CONF_PARTICIPANT]: null,
            },
            userId,
        );

        while (this.calls.length > 0) {
            this.removeCall(this.calls[this.calls.length - 1], CallErrorCode.UserHangup);
        }

        this.activeSpeaker = null;
        clearTimeout(this.presenceLoopTimeout);
        clearTimeout(this.activeSpeakerLoopTimeout);

        this.client.removeListener(
            "RoomState.members",
            this.onRoomStateMembers,
        );
        this.client.removeListener("Call.incoming", this.onIncomingCall);
    }

    public leave() {
        this.dispose();
        this.state = GroupCallState.LocalCallFeedUninitialized;
        this.emit(GroupCallEvent.GroupCallStateChanged, this.state);
    }

    public async endCall(emitStateEvent = true) {
        this.dispose();
        this.state = GroupCallState.Ended;

        this.client.groupCallEventHandler.groupCalls.delete(this.room.roomId);

        if (emitStateEvent) {
            await this.client.sendStateEvent(
                this.room.roomId,
                CONF_ROOM,
                { active: false },
                "",
            );
        }

        this.client.emit("GroupCall.ended", this);
        this.emit(GroupCallEvent.GroupCallStateChanged, this.state);
    }

    /**
     * Local Usermedia
     */

    public isLocalVideoMuted() {
        if (this.localCallFeed) {
            return this.localCallFeed.isVideoMuted();
        }

        return true;
    }

    public isMicrophoneMuted() {
        if (this.localCallFeed) {
            return this.localCallFeed.isAudioMuted();
        }

        return true;
    }

    public setMicrophoneMuted(muted) {
        if (this.localCallFeed) {
            this.localCallFeed.setAudioMuted(muted);
            setTracksEnabled(this.localCallFeed.stream.getAudioTracks(), !muted);
        }

        for (const call of this.calls) {
            call.setMicrophoneMuted(muted);
        }

        this.emit(GroupCallEvent.LocalMuteStateChanged, muted, this.isLocalVideoMuted());
    }

    public setLocalVideoMuted(muted) {
        if (this.localCallFeed) {
            this.localCallFeed.setVideoMuted(muted);
            setTracksEnabled(this.localCallFeed.stream.getVideoTracks(), !muted);
        }

        for (const call of this.calls) {
            call.setLocalVideoMuted(muted);
        }

        this.emit(GroupCallEvent.LocalMuteStateChanged, this.isMicrophoneMuted(), muted);
    }

    /**
     * Call presence
     */

    private onPresenceLoop = () => {
        const localUserId = this.client.getUserId();
        const currentMemberState = this.room.currentState.getStateEvents(
            "m.room.member",
            localUserId,
        );

        this.client.sendStateEvent(
            this.room.roomId,
            "m.room.member",
            {
                ...currentMemberState.getContent(),
                [CONF_PARTICIPANT]: {
                    sessionId: this.sessionIds.get(localUserId),
                    expiresAt: new Date().getTime() + this.participantTimeout * 2,
                },
            },
            localUserId,
        );

        const now = new Date().getTime();

        // Iterate backwards so that we can remove items
        for (let i = this.calls.length - 1; i >= 0; i--) {
            const call = this.calls[i];

            const opponentUserId = getCallUserId(call);

            if (!opponentUserId) {
                continue;
            }

            const memberStateEvent = this.room.currentState.getStateEvents(
                "m.room.member",
                opponentUserId,
            );

            const memberStateContent = memberStateEvent.getContent();

            if (
                !memberStateContent ||
                !memberStateContent[CONF_PARTICIPANT] ||
                typeof memberStateContent[CONF_PARTICIPANT] !== "object" ||
                (memberStateContent[CONF_PARTICIPANT].expiresAt &&
                    memberStateContent[CONF_PARTICIPANT].expiresAt < now)
            ) {
                this.removeCall(call, CallErrorCode.UserHangup);
            }
        }

        this.presenceLoopTimeout = setTimeout(
            this.onPresenceLoop,
            this.participantTimeout,
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

    private processInitialCalls() {
        const calls = this.client.callEventHandler.calls.values();

        for (const call of calls) {
            this.onIncomingCall(call);
        }
    }

    private onIncomingCall = (newCall: MatrixCall) => {
        // The incoming calls may be for another room, which we will ignore.
        if (newCall.roomId !== this.room.roomId) {
            return;
        }

        if (newCall.state !== CallState.Ringing) {
            logger.warn("Incoming call no longer in ringing state. Ignoring.");
            return;
        }

        const opponentMemberId = newCall.getOpponentMember().userId;

        logger.log(`GroupCall: incoming call from: ${opponentMemberId}`);

        const memberStateEvent = this.room.currentState.getStateEvents(
            "m.room.member",
            opponentMemberId,
        );

        const memberStateContent = memberStateEvent.getContent();

        if (!memberStateContent || !memberStateContent[CONF_PARTICIPANT]) {
            newCall.reject();
            return;
        }

        const { sessionId } = memberStateContent[CONF_PARTICIPANT];
        this.sessionIds.set(opponentMemberId, sessionId);

        const existingCall = this.getCallByUserId(opponentMemberId);

        // Check if the user calling has an existing call and use this call instead.
        if (existingCall) {
            this.replaceCall(existingCall, newCall, sessionId);
        } else {
            this.addCall(newCall, sessionId);
        }

        newCall.answer();
    };

    private onRoomStateMembers = (_event, _state, member: RoomMember) => {
        // The member events may be received for another room, which we will ignore.
        if (member.roomId !== this.room.roomId) {
            return;
        }

        logger.log(`GroupCall member state changed: ${member.userId}`);
        this.onMemberChanged(member);
    };

    private onMemberChanged = (member: RoomMember) => {
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

        // If there is an existing call for this member check the session id.
        // If the session id changed then we can hang up the old call and start a new one.
        // Otherwise, ignore the member change event because we already have an active participant.
        const existingCall = this.getCallByUserId(member.userId);

        if (existingCall && this.sessionIds.get(member.userId) === sessionId) {
            return;
        }

        // Only initiate a call with a user who has a userId that is lexicographically
        // less than your own. Otherwise, that user will call you.
        if (member.userId < localUserId) {
            return;
        }

        const newCall = this.client.createCall(this.room.roomId, member.userId);

        // TODO: Move to call.placeCall()
        const callPromise = this.type === CallType.Video ? newCall.placeVideoCall() : newCall.placeVoiceCall();

        callPromise.then(() => {
            if (this.dataChannelsEnabled) {
                newCall.createDataChannel("datachannel", this.dataChannelOptions);
            }
        });

        if (existingCall) {
            this.replaceCall(existingCall, newCall, sessionId);
        } else {
            this.addCall(newCall, sessionId);
        }
    };

    /**
     * Call Event Handlers
     */

    public getCallByUserId(userId: string): MatrixCall {
        return this.calls.find((call) => getCallUserId(call) === userId);
    }

    private addCall(call: MatrixCall, sessionId: string) {
        this.calls.push(call);
        this.initCall(call, sessionId);
        this.emit(GroupCallEvent.CallsChanged, this.calls);
    }

    private replaceCall(existingCall: MatrixCall, replacementCall: MatrixCall, sessionId: string) {
        const existingCallIndex = this.calls.indexOf(existingCall);

        if (existingCallIndex === -1) {
            throw new Error("Couldn't find call to replace");
        }

        this.calls.splice(existingCallIndex, 1, replacementCall);

        this.disposeCall(existingCall, CallErrorCode.Replaced);
        this.initCall(replacementCall, sessionId);

        this.emit(GroupCallEvent.CallsChanged, this.calls);
    }

    private removeCall(call: MatrixCall, hangupReason: CallErrorCode) {
        this.disposeCall(call, hangupReason);

        const callIndex = this.calls.indexOf(call);

        if (callIndex === -1) {
            throw new Error("Couldn't find call to remove");
        }

        this.calls.splice(callIndex, 1);

        this.emit(GroupCallEvent.CallsChanged, this.calls);
    }

    private initCall(call: MatrixCall, sessionId: string) {
        const opponentMemberId = getCallUserId(call);

        if (!opponentMemberId) {
            throw new Error("Cannot init call without user id");
        }

        const onCallFeedsChanged = () => this.onCallFeedsChanged(call);
        const onCallStateChanged =
            (state: CallState, oldState: CallState) => this.onCallStateChanged(call, state, oldState);
        const onCallHangup = this.onCallHangup;

        this.callHandlers.set(opponentMemberId, {
            onCallFeedsChanged,
            onCallStateChanged,
            onCallHangup,
        });

        call.on(CallEvent.FeedsChanged, onCallFeedsChanged);
        call.on(CallEvent.State, onCallStateChanged);
        call.on(CallEvent.Hangup, onCallHangup);

        this.activeSpeakerSamples.set(opponentMemberId, Array(this.activeSpeakerSampleCount).fill(
            -Infinity,
        ));
        this.sessionIds.set(opponentMemberId, sessionId);
        this.reEmitter.reEmit(call, Object.values(CallEvent));
    }

    private disposeCall(call: MatrixCall, hangupReason: CallErrorCode) {
        const opponentMemberId = getCallUserId(call);

        if (!opponentMemberId) {
            throw new Error("Cannot dispose call without user id");
        }

        const {
            onCallFeedsChanged,
            onCallStateChanged,
            onCallHangup,
        } = this.callHandlers.get(opponentMemberId);

        call.removeListener(CallEvent.FeedsChanged, onCallFeedsChanged);
        call.removeListener(CallEvent.State, onCallStateChanged);
        call.removeListener(CallEvent.Hangup, onCallHangup);

        this.callHandlers.delete(opponentMemberId);

        if (call.state !== CallState.Ended) {
            call.hangup(hangupReason, false);
        }

        const usermediaFeed = this.getUserMediaFeedByUserId(opponentMemberId);

        if (usermediaFeed) {
            this.removeUserMediaFeed(usermediaFeed);
        }

        this.activeSpeakerSamples.delete(opponentMemberId);
        this.sessionIds.delete(opponentMemberId);
    }

    private onCallFeedsChanged = (call: MatrixCall) => {
        const opponentMemberId = getCallUserId(call);

        if (!opponentMemberId) {
            throw new Error("Cannot change call feeds without user id");
        }

        const currentUserMediaFeed = this.getUserMediaFeedByUserId(opponentMemberId);
        const remoteUsermediaFeed = call.remoteUsermediaFeed;
        const remoteFeedChanged = remoteUsermediaFeed !== currentUserMediaFeed;

        if (!remoteFeedChanged) {
            return;
        }

        if (!currentUserMediaFeed && remoteUsermediaFeed) {
            this.addUserMediaFeed(remoteUsermediaFeed);
        } else if (currentUserMediaFeed && remoteUsermediaFeed) {
            this.replaceUserMediaFeed(currentUserMediaFeed, remoteUsermediaFeed);
        } else if (currentUserMediaFeed && !remoteUsermediaFeed) {
            this.removeUserMediaFeed(currentUserMediaFeed);
        }
    };

    private onCallStateChanged = (call: MatrixCall, _state: CallState, _oldState: CallState) => {
        const audioMuted = this.localCallFeed.isAudioMuted();

        if (
            call.localUsermediaStream &&
            call.isMicrophoneMuted() !== audioMuted
        ) {
            call.setMicrophoneMuted(audioMuted);
        }

        const videoMuted = this.localCallFeed.isVideoMuted();

        if (
            call.localUsermediaStream &&
            call.isLocalVideoMuted() !== videoMuted
        ) {
            call.setLocalVideoMuted(videoMuted);
        }
    };

    private onCallHangup = (call: MatrixCall) => {
        if (call.hangupReason === CallErrorCode.Replaced) {
            return;
        }

        this.removeCall(call, call.hangupReason as CallErrorCode);
    };

    /**
     * UserMedia CallFeed Event Handlers
     */

    public getUserMediaFeedByUserId(userId: string) {
        return this.userMediaFeeds.find((feed) => feed.userId === userId);
    }

    private addUserMediaFeed(callFeed: CallFeed) {
        this.userMediaFeeds.push(callFeed);
        this.initUserMediaFeed(callFeed);
        this.emit(GroupCallEvent.UserMediaFeedsChanged, this.userMediaFeeds);
    }

    private replaceUserMediaFeed(existingFeed: CallFeed, replacementFeed: CallFeed) {
        const feedIndex = this.userMediaFeeds.findIndex((feed) => feed.userId === existingFeed.userId);

        if (feedIndex === -1) {
            throw new Error("Couldn't find user media feed to replace");
        }

        this.userMediaFeeds.splice(feedIndex, 1, replacementFeed);

        this.disposeUserMediaFeed(existingFeed);
        this.initUserMediaFeed(replacementFeed);
        this.emit(GroupCallEvent.UserMediaFeedsChanged, this.userMediaFeeds);
    }

    private removeUserMediaFeed(callFeed: CallFeed) {
        const feedIndex = this.userMediaFeeds.findIndex((feed) => feed.userId === callFeed.userId);

        if (feedIndex === -1) {
            throw new Error("Couldn't find user media feed to remove");
        }

        this.userMediaFeeds.splice(feedIndex, 1);

        this.disposeUserMediaFeed(callFeed);
        this.emit(GroupCallEvent.UserMediaFeedsChanged, this.userMediaFeeds);

        if (
            this.activeSpeaker === callFeed.userId &&
            this.userMediaFeeds.length > 0
        ) {
            this.activeSpeaker = this.userMediaFeeds[0].userId;
            this.emit(GroupCallEvent.ActiveSpeakerChanged, this.activeSpeaker);
        }
    }

    private initUserMediaFeed(callFeed: CallFeed) {
        callFeed.setSpeakingThreshold(this.speakingThreshold);
        callFeed.measureVolumeActivity(true);

        const onCallFeedVolumeChanged = (maxVolume: number) => this.onCallFeedVolumeChanged(callFeed, maxVolume);
        const onCallFeedMuteStateChanged =
            (audioMuted: boolean) => this.onCallFeedMuteStateChanged(callFeed, audioMuted);

        this.userMediaFeedHandlers.set(callFeed.userId, {
            onCallFeedVolumeChanged,
            onCallFeedMuteStateChanged,
        });

        callFeed.on(CallFeedEvent.VolumeChanged, onCallFeedVolumeChanged);
        callFeed.on(CallFeedEvent.MuteStateChanged, onCallFeedMuteStateChanged);
    }

    private disposeUserMediaFeed(callFeed: CallFeed) {
        const { onCallFeedVolumeChanged, onCallFeedMuteStateChanged } = this.userMediaFeedHandlers.get(callFeed.userId);
        callFeed.removeListener(CallFeedEvent.VolumeChanged, onCallFeedVolumeChanged);
        callFeed.removeListener(CallFeedEvent.MuteStateChanged, onCallFeedMuteStateChanged);
        this.userMediaFeedHandlers.delete(callFeed.userId);
        callFeed.dispose();
    }

    private onCallFeedVolumeChanged = (callFeed: CallFeed, maxVolume: number) => {
        const activeSpeakerSamples = this.activeSpeakerSamples.get(callFeed.userId);
        activeSpeakerSamples.shift();
        activeSpeakerSamples.push(maxVolume);
    };

    private onCallFeedMuteStateChanged = (callFeed: CallFeed, audioMuted: boolean) => {
        if (audioMuted) {
            this.activeSpeakerSamples.get(callFeed.userId).fill(
                -Infinity,
            );
        }
    };

    private onActiveSpeakerLoop = () => {
        let topAvg: number;
        let nextActiveSpeaker: string;

        for (const [userId, samples] of this.activeSpeakerSamples) {
            let total = 0;

            for (let i = 0; i < samples.length; i++) {
                const volume = samples[i];
                total += Math.max(volume, this.speakingThreshold);
            }

            const avg = total / this.activeSpeakerSampleCount;

            if (!topAvg || avg > topAvg) {
                topAvg = avg;
                nextActiveSpeaker = userId;
            }
        }

        if (nextActiveSpeaker && this.activeSpeaker !== nextActiveSpeaker && topAvg > this.speakingThreshold) {
            this.activeSpeaker = nextActiveSpeaker;
            this.emit(GroupCallEvent.ActiveSpeakerChanged, this.activeSpeaker);
        }

        this.activeSpeakerLoopTimeout = setTimeout(
            this.onActiveSpeakerLoop,
            this.activeSpeakerInterval,
        );
    };
}
