import EventEmitter from "events";
import { CallFeed } from "./callFeed";
import { MatrixClient } from "../client";
import { randomString } from "../randomstring";
import { CallErrorCode, CallState, CallType, MatrixCall } from "./call";
import { RoomMember } from "../models/room-member";
import { Room } from "../models/room";
import { logger } from "../logger";
import { Callback } from "../client";
import { ReEmitter } from "../ReEmitter";
import { GroupCallParticipant, GroupCallParticipantEvent } from "./groupCallParticipant";
import { SDPStreamMetadataPurpose } from "./callEventTypes";

export enum GroupCallEvent {
    Entered = "entered",
    Left = "left",
    ActiveSpeakerChanged = "active_speaker_changed",
    ParticipantsChanged = "participants_changed",
    LocalMuteStateChanged = "local_mute_state_changed",
}

const CONF_ROOM = "me.robertlong.conf";
const CONF_PARTICIPANT = "me.robertlong.conf.participant";

export class GroupCall extends EventEmitter {
    public entered = false;
    public activeSpeaker: GroupCallParticipant;
    public localParticipant: GroupCallParticipant;
    public participants: GroupCallParticipant[] = [];
    public room: Room;
    public activeSpeakerSampleCount = 8;
    public activeSpeakerInterval = 1000;
    public speakingThreshold = -80;
    public participantTimeout = 1000 * 15;

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

    public async initLocalParticipant() {
        if (this.localParticipant) {
            return this.localParticipant;
        }

        const stream = await this.client.getMediaHandler().getUserMediaStream(true, this.type === CallType.Video);

        const userId = this.client.getUserId();

        const member = this.room.getMember(userId);

        const callFeed = new CallFeed(
            stream,
            member.userId,
            SDPStreamMetadataPurpose.Usermedia,
            this.client,
            this.room.roomId,
            false,
            false,
        );

        this.localParticipant = new GroupCallParticipant(
            this,
            member,
            randomString(16),
        );

        this.localParticipant.setLocalUsermediaFeed(callFeed);

        return this.localParticipant;
    }

    public async enter() {
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
                { active: true, callType: this.type },
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

    public leave() {
        this.localParticipant = null;
        this.client.getMediaHandler().stopAllStreams();

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

        // Clean up participant event listeners and hangup calls
        // Reverse iteration because participant.remove() removes the participant from the participants array.
        for (let i = this.participants.length - 1; i >= 0; i--) {
            const participant = this.participants[i];

            participant.remove();

            // Hangup is async, so we call remove which removes all the call event listeners
            // that reference this group call
            if (participant.call) {
                participant.call.hangup(CallErrorCode.UserHangup, false);
            }
        }

        this.entered = false;
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

    public async endCall() {
        await this.sendStateEventWithRetry(
            this.room.roomId,
            CONF_ROOM,
            { active: false },
            "",
        );
    }

    public isLocalVideoMuted() {
        if (this.localParticipant) {
            return this.localParticipant.isVideoMuted();
        }

        return true;
    }

    public isMicrophoneMuted() {
        if (this.localParticipant) {
            return this.localParticipant.isAudioMuted();
        }

        return true;
    }

    public setMicrophoneMuted(muted) {
        if (this.localParticipant) {
            const usermediaFeed = this.localParticipant.usermediaFeed;

            if (usermediaFeed) {
                usermediaFeed.setAudioMuted(muted);
            }

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

    public setLocalVideoMuted(muted) {
        if (this.localParticipant) {
            const usermediaFeed = this.localParticipant.usermediaFeed;

            if (usermediaFeed) {
                usermediaFeed.setVideoMuted(muted);
            }

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

    private onPresenceLoop = () => {
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
                    expiresAt: new Date().getTime() + this.participantTimeout * 2,
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
                participant.remove();

                if (participant.call) {
                    participant.call.hangup(CallErrorCode.UserHangup, false);
                }
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

    private onIncomingCall = (call: MatrixCall) => {
        // The incoming calls may be for another room, which we will ignore.
        if (call.roomId !== this.room.roomId) {
            return;
        }

        if (call.state !== CallState.Ringing) {
            logger.warn("Incoming call no longer in ringing state. Ignoring.");
            return;
        }

        const opponentMember = call.getOpponentMember();

        logger.log(`GroupCall: incoming call from: ${opponentMember.userId}`);

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
            this.emit(GroupCallEvent.ParticipantsChanged, this.participants);
        }
    };

    private onActiveSpeakerLoop = () => {
        let topAvg;
        let nextActiveSpeaker;

        for (const participant of this.participants) {
            let total = 0;

            for (let i = 0; i < participant.activeSpeakerSamples.length; i++) {
                const volume = participant.activeSpeakerSamples[i];
                total += Math.max(volume, this.speakingThreshold);
            }

            const avg = total / this.activeSpeakerSampleCount;

            if (!topAvg || avg > topAvg) {
                topAvg = avg;
                nextActiveSpeaker = participant;
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
     * Utils
     */

    // TODO: move this elsewhere or get rid of the retry logic. Do we need it?
    private sendStateEventWithRetry(
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
