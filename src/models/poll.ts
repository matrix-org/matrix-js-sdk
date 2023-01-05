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

import { M_POLL_END, M_POLL_RESPONSE, PollStartEvent } from "matrix-events-sdk";

import { MatrixClient } from "..";
import { MatrixEvent } from "./event";
import { Relations } from "./relations";
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
    hasUndecryptableRelations: boolean;
    responseEvents: MatrixEvent[];
} => {
    let hasUndecryptableRelations = false;
    const responseEvents = relationEvents.filter((event) => {
        if (event.isDecryptionFailure()) {
            hasUndecryptableRelations = true;
            return;
        }
        return (
            M_POLL_RESPONSE.matches(event.getType()) &&
            // From MSC3381:
            // "Votes sent on or before the end event's timestamp are valid votes"
            event.getTs() <= pollEndTimestamp
        );
    });

    return { hasUndecryptableRelations, responseEvents };
};

// https://github.com/matrix-org/matrix-spec-proposals/pull/3672
export class Poll extends TypedEventEmitter<Exclude<PollEvent, PollEvent.New>, PollEventHandlerMap> {
    public readonly roomId: string;
    private pollEvent: PollStartEvent | undefined;
    private fetchingResponsesPromise: null | Promise<void> = null;
    private responses: null | Relations = null;
    private endEvent: MatrixEvent | undefined;
    private hasUndecryptableRelations = false;

    public constructor(private rootEvent: MatrixEvent, private matrixClient: MatrixClient) {
        super();
        this.roomId = this.rootEvent.getRoomId()!;
        this.setPollStartEvent(this.rootEvent);
    }

    public get pollId(): string {
        return this.rootEvent.getId()!;
    }

    public get isEnded(): boolean {
        // @TODO(kerrya) should be false while responses are loading?
        return !!this.endEvent;
    }

    public setPollStartEvent(event: MatrixEvent): void {
        this.pollEvent = event.unstableExtensibleEvent as PollStartEvent;
    }

    public getPollStartEvent(): PollStartEvent {
        return this.pollEvent!;
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
     * @param event event with a relation to the rootEvent
     * @returns void
     */
    public onNewRelation(event: MatrixEvent): void {
        if (M_POLL_END.matches(event.getType())) {
            this.endEvent = event;
            this.emit(PollEvent.End);
        }

        // wait for poll to be initialised
        if (!this.responses) {
            return;
        }

        const pollCloseTimestamp = this.endEvent?.getTs() || Number.MAX_SAFE_INTEGER;
        const { hasUndecryptableRelations, responseEvents } = filterResponseRelations([event], pollCloseTimestamp);

        if (responseEvents.length) {
            responseEvents.forEach((event) => {
                this.responses!.addEvent(event);
            });
            this.emit(PollEvent.Responses, this.responses);
        }

        this.hasUndecryptableRelations = this.hasUndecryptableRelations || hasUndecryptableRelations;
    }

    private async fetchResponses(): Promise<void> {
        this.fetchingResponsesPromise = new Promise<void>(() => {});

        // we want:
        // - stable and unstable M_POLL_RESPONSE
        // - stable and unstable M_POLL_END
        // so make one api call and filter by event type client side
        const allRelations = await this.matrixClient.relations(this.roomId, this.rootEvent.getId()!, "m.reference");

        // @TODO(kerrya) paging results

        const responses = new Relations("m.reference", M_POLL_RESPONSE.name, this.matrixClient, [
            M_POLL_RESPONSE.altName!,
        ]);

        const pollEndEvent = allRelations.events.find((event) => M_POLL_END.matches(event.getType()));
        const pollCloseTimestamp = pollEndEvent?.getTs() || Number.MAX_SAFE_INTEGER;

        const { hasUndecryptableRelations, responseEvents } = filterResponseRelations(
            allRelations.events,
            pollCloseTimestamp,
        );

        responseEvents.forEach((event) => {
            responses.addEvent(event);
        });

        this.responses = responses;
        this.endEvent = pollEndEvent;
        this.hasUndecryptableRelations = hasUndecryptableRelations;
        this.emit(PollEvent.Responses, this.responses);
    }
}
