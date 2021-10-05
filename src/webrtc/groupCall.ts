import EventEmitter from "events";
import { CallFeed, CallFeedEvent } from "./callFeed";
import { MatrixClient } from "../client";
import { CallErrorCode, CallEvent, CallState, genCallID, MatrixCall, setTracksEnabled } from "./call";
import { RoomMember } from "../models/room-member";
import { Room } from "../models/room";
import { logger } from "../logger";
import { ReEmitter } from "../ReEmitter";
import { SDPStreamMetadataPurpose } from "./callEventTypes";
import { createNewMatrixCall } from "./call";
import { ISendEventResponse } from "../@types/requests";
import { MatrixEvent } from "../models/event";

export const GROUP_CALL_ROOM_EVENT = "org.matrix.msc3401.call";
export const GROUP_CALL_MEMBER_EVENT = "org.matrix.msc3401.call.member";

export enum GroupCallIntent {
    Ring = "m.ring",
    Prompt = "m.prompt",
    Room = "m.room",
}

export enum GroupCallType {
    Video = "m.video",
    Voice = "m.voice",
}

export enum GroupCallTerminationReason {
    CallEnded = "call_ended",
}

export enum GroupCallEvent {
    GroupCallStateChanged = "group_call_state_changed",
    ActiveSpeakerChanged = "active_speaker_changed",
    CallsChanged = "calls_changed",
    UserMediaFeedsChanged = "user_media_feeds_changed",
    ScreenshareFeedsChanged = "screenshare_feeds_changed",
    LocalScreenshareStateChanged = "local_screenshare_state_changed",
    LocalMuteStateChanged = "local_mute_state_changed",
    ParticipantsChanged = "participants_changed",
    Error = "error"
}

export enum GroupCallErrorCode {
    NoUserMedia = "no_user_media"
}

export class GroupCallError extends Error {
    code: string;

    constructor(code: GroupCallErrorCode, msg: string, err: Error) {
        // Still don't think there's any way to have proper nested errors
        super(msg + ": " + err);

        this.code = code;
    }
}

export interface IGroupCallDataChannelOptions {
    ordered: boolean;
    maxPacketLifeTime: number;
    maxRetransmits: number;
    protocol: string;
}

export interface IGroupCallRoomMemberCallState {
    "m.call_id": string;
    "m.foci"?: string[];
    "m.sources"?: any[];
}

export interface IGroupCallRoomMemberState {
    "m.calls": IGroupCallRoomMemberCallState[];
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
    public activeSpeaker?: string; // userId
    public localCallFeed?: CallFeed;
    public localScreenshareFeed?: CallFeed;
    public localDesktopCapturerSourceId?: string;
    public calls: MatrixCall[] = [];
    public participants: RoomMember[] = [];
    public userMediaFeeds: CallFeed[] = [];
    public screenshareFeeds: CallFeed[] = [];
    public groupCallId: string;

    private userMediaFeedHandlers: Map<string, IUserMediaFeedHandlers> = new Map();
    private callHandlers: Map<string, ICallHandlers> = new Map();
    private activeSpeakerSamples: Map<string, number[]> = new Map();
    private activeSpeakerLoopTimeout?: number;
    private reEmitter: ReEmitter;

    constructor(
        private client: MatrixClient,
        public room: Room,
        public type: GroupCallType,
        public intent: GroupCallIntent,
        private dataChannelsEnabled?: boolean,
        private dataChannelOptions?: IGroupCallDataChannelOptions,
    ) {
        super();
        this.reEmitter = new ReEmitter(this);
        this.groupCallId = genCallID();

        const roomState = this.room.currentState;
        const memberStateEvents = roomState.getStateEvents(GROUP_CALL_MEMBER_EVENT);

        logger.log("Processing initial members", memberStateEvents);

        for (const stateEvent of memberStateEvents) {
            this.onMemberStateChanged(stateEvent);
        }
    }

    public async create() {
        this.client.groupCallEventHandler.groupCalls.set(this.room.roomId, this);

        await this.client.sendStateEvent(
            this.room.roomId,
            GROUP_CALL_ROOM_EVENT,
            {
                "m.intent": this.intent,
                "m.type": this.type,
                // TODO: Specify datachannels
                "dataChannelsEnabled": this.dataChannelsEnabled,
                "dataChannelOptions": this.dataChannelOptions,
            },
            this.groupCallId,
        );

        return this;
    }

    private setState(newState: GroupCallState): void {
        const oldState = this.state;
        this.state = newState;
        this.emit(GroupCallEvent.GroupCallStateChanged, newState, oldState);
    }

    public getLocalFeeds(): CallFeed[] {
        const feeds = [];

        if (this.localCallFeed) feeds.push(this.localCallFeed);
        if (this.localScreenshareFeed) feeds.push(this.localScreenshareFeed);

        return feeds;
    }

    public async initLocalCallFeed(): Promise<CallFeed> {
        if (this.state !== GroupCallState.LocalCallFeedUninitialized) {
            throw new Error(`Cannot initialize local call feed in the "${this.state}" state.`);
        }

        this.setState(GroupCallState.InitializingLocalCallFeed);

        let stream: MediaStream;

        try {
            stream = await this.client.getMediaHandler().getUserMediaStream(true, this.type === GroupCallType.Video);
        } catch (error) {
            this.setState(GroupCallState.LocalCallFeedUninitialized);
            throw error;
        }

        const userId = this.client.getUserId();

        const callFeed = new CallFeed({
            client: this.client,
            roomId: this.room.roomId,
            userId,
            stream,
            purpose: SDPStreamMetadataPurpose.Usermedia,
            audioMuted: false,
            videoMuted: false,
        });

        this.activeSpeakerSamples.set(userId, Array(this.activeSpeakerSampleCount).fill(
            -Infinity,
        ));
        this.localCallFeed = callFeed;
        this.addUserMediaFeed(callFeed);

        this.setState(GroupCallState.LocalCallFeedInitialized);

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

        logger.log(`Sending member state event with current call.`);

        this.sendEnteredMemberStateEvent();

        this.activeSpeaker = this.client.getUserId();

        this.setState(GroupCallState.Entered);

        logger.log(`Entered group call ${this.groupCallId}`);

        logger.log("processing initial calls");

        const calls = this.client.callEventHandler.calls.values();

        for (const call of calls) {
            this.onIncomingCall(call);
        }

        // Set up participants for the members currently in the room.
        // Other members will be picked up by the RoomState.members event.
        const roomState = this.room.currentState;
        const memberStateEvents = roomState.getStateEvents(GROUP_CALL_MEMBER_EVENT);

        logger.log("Processing initial members");

        for (const stateEvent of memberStateEvents) {
            this.onMemberStateChanged(stateEvent);
        }

        this.client.on("Call.incoming", this.onIncomingCall);

        this.onActiveSpeakerLoop();
    }

    private dispose() {
        if (this.localCallFeed) {
            this.removeUserMediaFeed(this.localCallFeed);
            this.localCallFeed = null;
        }

        if (this.localScreenshareFeed) {
            this.client.getMediaHandler().stopScreensharingStream(this.localScreenshareFeed.stream);
            this.removeScreenshareFeed(this.localScreenshareFeed);
            this.localScreenshareFeed = undefined;
            this.localDesktopCapturerSourceId = undefined;
        }

        this.client.getMediaHandler().stopAllStreams();

        if (this.state !== GroupCallState.Entered) {
            return;
        }

        this.sendLeftMemberStateEvent();

        while (this.calls.length > 0) {
            this.removeCall(this.calls[this.calls.length - 1], CallErrorCode.UserHangup);
        }

        this.activeSpeaker = null;
        clearTimeout(this.activeSpeakerLoopTimeout);
        this.client.removeListener("Call.incoming", this.onIncomingCall);
    }

    public leave() {
        this.dispose();
        this.setState(GroupCallState.LocalCallFeedUninitialized);
    }

    public async terminate(emitStateEvent = true) {
        this.dispose();

        this.participants = [];
        this.client.removeListener(
            "RoomState.members",
            this.onMemberStateChanged,
        );

        this.client.groupCallEventHandler.groupCalls.delete(this.room.roomId);

        if (emitStateEvent) {
            const existingStateEvent = this.room.currentState.getStateEvents(GROUP_CALL_ROOM_EVENT, this.groupCallId);

            await this.client.sendStateEvent(
                this.room.roomId,
                GROUP_CALL_ROOM_EVENT,
                {
                    ...existingStateEvent.getContent(),
                    ["m.terminated"]: GroupCallTerminationReason.CallEnded,
                },
                this.groupCallId,
            );
        }

        this.client.emit("GroupCall.ended", this);
        this.setState(GroupCallState.Ended);
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

    public async setScreensharingEnabled(
        enabled: boolean, desktopCapturerSourceId?: string,
    ): Promise<boolean> {
        if (enabled === this.isScreensharing()) {
            return enabled;
        }

        if (enabled) {
            try {
                logger.log("Asking for screensharing permissions...");

                const stream = await this.client.getMediaHandler().getScreensharingStream(desktopCapturerSourceId);

                logger.log("Screensharing permissions granted. Setting screensharing enabled on all calls");

                this.localDesktopCapturerSourceId = desktopCapturerSourceId;
                this.localScreenshareFeed = new CallFeed({
                    client: this.client,
                    roomId: this.room.roomId,
                    userId: this.client.getUserId(),
                    stream,
                    purpose: SDPStreamMetadataPurpose.Screenshare,
                    audioMuted: false,
                    videoMuted: false,
                });
                this.addScreenshareFeed(this.localScreenshareFeed);

                this.emit(
                    GroupCallEvent.LocalScreenshareStateChanged,
                    true,
                    this.localScreenshareFeed,
                    this.localDesktopCapturerSourceId,
                );

                // TODO: handle errors
                await Promise.all(this.calls.map(call => call.pushLocalFeed(this.localScreenshareFeed)));

                logger.log("screensharing enabled on all calls");

                return true;
            } catch (error) {
                logger.error("enabling screensharing error", error);
                this.emit(GroupCallEvent.Error,
                    new GroupCallError(GroupCallErrorCode.NoUserMedia, "Failed to get screen-sharing stream: ", error),
                );
                return false;
            }
        } else {
            await Promise.all(this.calls.map(call => call.removeLocalFeed(this.localScreenshareFeed)));
            this.client.getMediaHandler().stopScreensharingStream(this.localScreenshareFeed.stream);
            this.removeScreenshareFeed(this.localScreenshareFeed);
            this.localScreenshareFeed = undefined;
            this.localDesktopCapturerSourceId = undefined;
            this.emit(GroupCallEvent.LocalScreenshareStateChanged, false, undefined, undefined);
            return false;
        }
    }

    public isScreensharing(): boolean {
        return !!this.localScreenshareFeed;
    }

    /**
     * Call Setup
     *
     * There are two different paths for calls to be created:
     * 1. Incoming calls triggered by the Call.incoming event.
     * 2. Outgoing calls to the initial members of a room or new members
     *    as they are observed by the RoomState.members event.
     */

    private onIncomingCall = (newCall: MatrixCall) => {
        // The incoming calls may be for another room, which we will ignore.
        if (newCall.roomId !== this.room.roomId) {
            return;
        }

        if (newCall.state !== CallState.Ringing) {
            logger.warn("Incoming call no longer in ringing state. Ignoring.");
            return;
        }

        if (!newCall.groupCallId || newCall.groupCallId !== this.groupCallId) {
            logger.log(`Incoming call with groupCallId ${
                newCall.groupCallId} ignored because it doesn't match the current group call`);
            newCall.reject();
            return;
        }

        const opponentMemberId = newCall.getOpponentMember().userId;
        const existingCall = this.getCallByUserId(opponentMemberId);

        logger.log(`GroupCall: incoming call from: ${opponentMemberId}`);

        // Check if the user calling has an existing call and use this call instead.
        if (existingCall) {
            this.replaceCall(existingCall, newCall);
        } else {
            this.addCall(newCall);
        }

        newCall.answerWithCallFeeds(this.getLocalFeeds());
    };

    /**
     * Room Member State
     */

    private sendEnteredMemberStateEvent(): Promise<ISendEventResponse> {
        return this.updateMemberCallState({
            "m.call_id": this.groupCallId,
            // TODO "m.foci"
            // TODO "m.sources"
        });
    }

    private sendLeftMemberStateEvent(): Promise<ISendEventResponse> {
        return this.updateMemberCallState(undefined);
    }

    private async updateMemberCallState(memberCallState?: IGroupCallRoomMemberCallState): Promise<ISendEventResponse> {
        const localUserId = this.client.getUserId();

        const currentStateEvent = this.room.currentState.getStateEvents(GROUP_CALL_MEMBER_EVENT, localUserId);

        const calls = currentStateEvent?.getContent<IGroupCallRoomMemberState>()["m.calls"] || [];

        const existingCallIndex = calls.findIndex((call) => call["m.call_id"] === this.groupCallId);

        if (existingCallIndex === -1) {
            calls.push(memberCallState);
        } else if (memberCallState) {
            calls.splice(existingCallIndex, 1, memberCallState);
        } else {
            calls.splice(existingCallIndex, 1);
        }

        return this.client.sendStateEvent(this.room.roomId, GROUP_CALL_MEMBER_EVENT, {
            "m.calls": calls,
        }, localUserId);
    }

    public onMemberStateChanged = (event: MatrixEvent) => {
        // The member events may be received for another room, which we will ignore.
        if (event.getRoomId() !== this.room.roomId) {
            return;
        }

        const member = this.room.getMember(event.getStateKey());

        if (!member) {
            return;
        }

        // Don't process your own member.
        const localUserId = this.client.getUserId();

        if (member.userId === localUserId) {
            return;
        }

        const callsState = event.getContent<IGroupCallRoomMemberState>()["m.calls"];

        if (!callsState || !Array.isArray(callsState) || callsState.length === 0) {
            logger.log(`Ignoring member state from ${member.userId} member not in any calls.`);
            this.removeParticipant(member);
            return;
        }

        // Currently we only support a single call per room. So grab the first call.
        const callState = callsState[0];

        const callId = callState["m.call_id"];

        if (!callId) {
            logger.warn(`Room member ${member.userId} does not have a valid m.call_id set. Ignoring.`);
            this.removeParticipant(member);
            return;
        }

        if (callId !== this.groupCallId) {
            logger.log(`Call id does not match group call id, ignoring.`);
            this.removeParticipant(member);
            return;
        }

        this.addParticipant(member);

        if (this.state !== GroupCallState.Entered) {
            return;
        }

        const existingCall = this.getCallByUserId(member.userId);

        if (existingCall) {
            return;
        }

        // Only initiate a call with a user who has a userId that is lexicographically
        // less than your own. Otherwise, that user will call you.
        if (member.userId < localUserId) {
            logger.log(`Waiting for ${member.userId} to send call invite.`);
            return;
        }

        const newCall = createNewMatrixCall(
            this.client,
            this.room.roomId,
            { invitee: member.userId, useToDevice: true, groupCallId: this.groupCallId },
        );

        newCall.placeCallWithCallFeeds(this.getLocalFeeds());

        if (this.dataChannelsEnabled) {
            newCall.createDataChannel("datachannel", this.dataChannelOptions);
        }

        // TODO: This existingCall code path is never reached, do we still need it?
        if (existingCall) {
            this.replaceCall(existingCall, newCall);
        } else {
            this.addCall(newCall);
        }
    };

    /**
     * Call Event Handlers
     */

    public getCallByUserId(userId: string): MatrixCall {
        return this.calls.find((call) => getCallUserId(call) === userId);
    }

    private addCall(call: MatrixCall) {
        this.calls.push(call);
        this.initCall(call);
        this.emit(GroupCallEvent.CallsChanged, this.calls);
    }

    private replaceCall(existingCall: MatrixCall, replacementCall: MatrixCall) {
        const existingCallIndex = this.calls.indexOf(existingCall);

        if (existingCallIndex === -1) {
            throw new Error("Couldn't find call to replace");
        }

        this.calls.splice(existingCallIndex, 1, replacementCall);

        this.disposeCall(existingCall, CallErrorCode.Replaced);
        this.initCall(replacementCall);

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

    private initCall(call: MatrixCall) {
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

        if (this.isScreensharing()) {
            call.setScreensharingEnabled(true, this.localDesktopCapturerSourceId);
        }

        this.activeSpeakerSamples.set(opponentMemberId, Array(this.activeSpeakerSampleCount).fill(
            -Infinity,
        ));
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

        const screenshareFeed = this.getScreenshareFeedByUserId(opponentMemberId);

        if (screenshareFeed) {
            this.removeScreenshareFeed(screenshareFeed);
        }

        this.activeSpeakerSamples.delete(opponentMemberId);
    }

    private onCallFeedsChanged = (call: MatrixCall) => {
        const opponentMemberId = getCallUserId(call);

        if (!opponentMemberId) {
            throw new Error("Cannot change call feeds without user id");
        }

        const currentUserMediaFeed = this.getUserMediaFeedByUserId(opponentMemberId);
        const remoteUsermediaFeed = call.remoteUsermediaFeed;
        const remoteFeedChanged = remoteUsermediaFeed !== currentUserMediaFeed;

        if (remoteFeedChanged) {
            if (!currentUserMediaFeed && remoteUsermediaFeed) {
                this.addUserMediaFeed(remoteUsermediaFeed);
            } else if (currentUserMediaFeed && remoteUsermediaFeed) {
                this.replaceUserMediaFeed(currentUserMediaFeed, remoteUsermediaFeed);
            } else if (currentUserMediaFeed && !remoteUsermediaFeed) {
                this.removeUserMediaFeed(currentUserMediaFeed);
            }
        }

        const currentScreenshareFeed = this.getScreenshareFeedByUserId(opponentMemberId);
        const remoteScreensharingFeed = call.remoteScreensharingFeed;
        const remoteScreenshareFeedChanged = remoteScreensharingFeed !== currentScreenshareFeed;

        if (remoteScreenshareFeedChanged) {
            if (!currentScreenshareFeed && remoteScreensharingFeed) {
                this.addScreenshareFeed(remoteScreensharingFeed);
            } else if (currentScreenshareFeed && remoteScreensharingFeed) {
                this.replaceScreenshareFeed(currentScreenshareFeed, remoteScreensharingFeed);
            } else if (currentScreenshareFeed && !remoteScreensharingFeed) {
                this.removeScreenshareFeed(currentScreenshareFeed);
            }
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

    /**
     * Screenshare Call Feed Event Handlers
     */

    public getScreenshareFeedByUserId(userId: string) {
        return this.screenshareFeeds.find((feed) => feed.userId === userId);
    }

    private addScreenshareFeed(callFeed: CallFeed) {
        logger.log("added screenshare feed");
        this.screenshareFeeds.push(callFeed);
        this.emit(GroupCallEvent.ScreenshareFeedsChanged, this.screenshareFeeds);
    }

    private replaceScreenshareFeed(existingFeed: CallFeed, replacementFeed: CallFeed) {
        logger.log("replaced screenshare feed");
        const feedIndex = this.screenshareFeeds.findIndex((feed) => feed.userId === existingFeed.userId);

        if (feedIndex === -1) {
            throw new Error("Couldn't find screenshare feed to replace");
        }

        this.screenshareFeeds.splice(feedIndex, 1, replacementFeed);

        existingFeed.dispose();
        this.emit(GroupCallEvent.ScreenshareFeedsChanged, this.screenshareFeeds);
    }

    private removeScreenshareFeed(callFeed: CallFeed) {
        logger.log("removed screenshare feed");
        const feedIndex = this.screenshareFeeds.findIndex((feed) => feed.userId === callFeed.userId);

        if (feedIndex === -1) {
            throw new Error("Couldn't find screenshare feed to remove");
        }

        this.screenshareFeeds.splice(feedIndex, 1);

        callFeed.dispose();
        this.emit(GroupCallEvent.ScreenshareFeedsChanged, this.screenshareFeeds);
    }

    /**
     * Participant Management
     */

    private addParticipant(member: RoomMember) {
        if (this.participants.find((m) => m.userId === member.userId)) {
            return;
        }

        this.participants.push(member);

        this.emit(GroupCallEvent.ParticipantsChanged, this.participants);
        this.client.emit("GroupCall.participants", this.participants, this);
    }

    private removeParticipant(member: RoomMember) {
        const index = this.participants.findIndex((m) => m.userId === member.userId);

        if (index === -1) {
            return;
        }

        this.participants.splice(index, 1);

        this.emit(GroupCallEvent.ParticipantsChanged, this.participants);
        this.client.emit("GroupCall.participants", this.participants, this);
    }
}
