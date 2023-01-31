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

import { M_POLL_END, M_POLL_RESPONSE, PollStartEvent } from "../@types/polls";
import { MatrixClient } from "../client";
import { MatrixEvent } from "./event";
import { Relations } from "./relations";
import { Room } from "./room";
import { TypedEventEmitter } from "./typed-event-emitter";

export enum PollEvent {
    New = "Poll.new",
    End = "Poll.end",
    Update = "Poll.update",
    Responses = "Poll.Responses",
    Destroy = "Poll.Destroy",
}

export type PollEventHandlerMap = {
    [PollEvent.Update]: (event: MatrixEvent, poll: Poll) => void;
    [PollEvent.Destroy]: (pollIdentifier: string) => void;
    [PollEvent.End]: () => void;
    [PollEvent.Responses]: (responses: Relations) => void;
};

const filterResponseRelations = (
    relationEvents: MatrixEvent[],
    pollEndTimestamp: number,
): {
    responseEvents: MatrixEvent[];
} => {
    const responseEvents = relationEvents.filter((event) => {
        if (event.isDecryptionFailure()) {
            // @TODO(kerrya) PSG-1023 track and return these
            return;
        }
        return (
            M_POLL_RESPONSE.matches(event.getType()) &&
            // From MSC3381:
            // "Votes sent on or before the end event's timestamp are valid votes"
            event.getTs() <= pollEndTimestamp
        );
    });

    return { responseEvents };
};

export class Poll extends TypedEventEmitter<Exclude<PollEvent, PollEvent.New>, PollEventHandlerMap> {
    public readonly roomId: string;
    public readonly pollEvent: PollStartEvent;
    private fetchingResponsesPromise: null | Promise<void> = null;
    private responses: null | Relations = null;
    private endEvent: MatrixEvent | undefined;

    public constructor(private rootEvent: MatrixEvent, private matrixClient: MatrixClient, private room: Room) {
        super();
        if (!this.rootEvent.getRoomId() || !this.rootEvent.getId()) {
            throw new Error("Invalid poll start event.");
        }
        this.roomId = this.rootEvent.getRoomId()!;
        this.pollEvent = this.rootEvent.unstableExtensibleEvent as unknown as PollStartEvent;
    }

    public get pollId(): string {
        return this.rootEvent.getId()!;
    }

    public get isEnded(): boolean {
        return !!this.endEvent;
    }

    public async getResponses(): Promise<Relations> {
        // if we have already fetched the responses
        // just return them
        if (this.responses) {
            return this.responses;
        }
        if (!this.fetchingResponsesPromise) {
            this.fetchingResponsesPromise = this.fetchResponses();
        }
        await this.fetchingResponsesPromise;
        return this.responses!;
    }

    /**
     *
     * @param event - event with a relation to the rootEvent
     * @returns void
     */
    public onNewRelation(event: MatrixEvent): void {
        if (M_POLL_END.matches(event.getType()) && this.validateEndEvent(event)) {
            this.endEvent = event;
            this.refilterResponsesOnEnd();
            this.emit(PollEvent.End);
        }

        // wait for poll responses to be initialised
        if (!this.responses) {
            return;
        }

        const pollEndTimestamp = this.endEvent?.getTs() || Number.MAX_SAFE_INTEGER;
        const { responseEvents } = filterResponseRelations([event], pollEndTimestamp);

        if (responseEvents.length) {
            responseEvents.forEach((event) => {
                this.responses!.addEvent(event);
            });
            this.emit(PollEvent.Responses, this.responses);
        }
    }

    private async fetchResponses(): Promise<void> {
        // we want:
        // - stable and unstable M_POLL_RESPONSE
        // - stable and unstable M_POLL_END
        // so make one api call and filter by event type client side
        const allRelations = await this.matrixClient.relations(this.roomId, this.rootEvent.getId()!, "m.reference");

        // @TODO(kerrya) paging results

        const responses = new Relations("m.reference", M_POLL_RESPONSE.name, this.matrixClient, [
            M_POLL_RESPONSE.altName!,
        ]);

        const potentialEndEvent = allRelations.events.find((event) => M_POLL_END.matches(event.getType()));
        const pollEndEvent = this.validateEndEvent(potentialEndEvent) ? potentialEndEvent : undefined;
        const pollCloseTimestamp = pollEndEvent?.getTs() || Number.MAX_SAFE_INTEGER;

        const { responseEvents } = filterResponseRelations(allRelations.events, pollCloseTimestamp);

        responseEvents.forEach((event) => {
            responses.addEvent(event);
        });

        this.responses = responses;
        this.endEvent = pollEndEvent;
        if (this.endEvent) {
            this.emit(PollEvent.End);
        }
        this.emit(PollEvent.Responses, this.responses);
    }

    /**
     * Only responses made before the poll ended are valid
     * Refilter after an end event is recieved
     * To ensure responses are valid
     */
    private refilterResponsesOnEnd(): void {
        if (!this.responses) {
            return;
        }

        const pollEndTimestamp = this.endEvent?.getTs() || Number.MAX_SAFE_INTEGER;
        this.responses.getRelations().forEach((event) => {
            if (event.getTs() > pollEndTimestamp) {
                this.responses?.removeEvent(event);
            }
        });

        this.emit(PollEvent.Responses, this.responses);
    }

    private validateEndEvent(endEvent?: MatrixEvent): boolean {
        if (!endEvent) {
            return false;
        }
        /**
         * Repeated end events are ignored -
         * only the first (valid) closure event by origin_server_ts is counted.
         */
        if (this.endEvent && this.endEvent.getTs() < endEvent.getTs()) {
            return false;
        }

        /**
         * MSC3381
         * If a m.poll.end event is received from someone other than the poll creator or user with permission to redact
         * other's messages in the room, the event must be ignored by clients due to being invalid.
         */
        const roomCurrentState = this.room.currentState;
        const endEventSender = endEvent.getSender();
        return (
            !!endEventSender &&
            (endEventSender === this.matrixClient.getSafeUserId() ||
                roomCurrentState.maySendRedactionForEvent(this.rootEvent, endEventSender))
        );
    }
}
