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

import { M_POLL_END, M_POLL_RESPONSE, M_POLL_START, PollStartEvent } from "matrix-events-sdk";
import { MatrixClient } from "..";
import { MPollEventContent } from "../@types/poll";
import { MatrixEvent } from "./event";
import { RelatedRelations } from "./related-relations";
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

export const isTimestampInDuration = (startTimestamp: number, durationMs: number, timestamp: number): boolean =>
    timestamp >= startTimestamp && startTimestamp + durationMs >= timestamp;

// poll info events are uniquely identified by
// `<roomId>_<state_key>`
export type PollIdentifier = string;
export const getPollInfoIdentifier = (event: MatrixEvent): PollIdentifier =>
    `${event.getRoomId()}_${event.getStateKey()}`;

// https://github.com/matrix-org/matrix-spec-proposals/pull/3672
export class Poll extends TypedEventEmitter<Exclude<PollEvent, PollEvent.New>, PollEventHandlerMap> {
    public readonly roomId: string;
    private pollEvent: PollStartEvent | undefined;
    private fetchingResponsesPromise: null | Promise<void> = null;
    private responses: null | Relations = null;
    private endEvent: MatrixEvent | undefined;

    public constructor(private rootEvent: MatrixEvent, private matrixClient: MatrixClient) {
        super();
        this.roomId = this.rootEvent.getRoomId()!;
        this.setPollInstance(this.rootEvent);
    }

    public get pollId(): string {
        return this.rootEvent.getId()!;
    }

    public get isEnded(): boolean {
        // @TODO(kerrya) should be false while responses are loading?
        return !!this.endEvent;
    }

    public setPollInstance(event: MatrixEvent): void {
        this.pollEvent = event.unstableExtensibleEvent as PollStartEvent;
    }

    public getPollInstance(): PollStartEvent {
        return this.pollEvent!;
    }

    public update(pollInfoEvent: MatrixEvent): void {
        
    }

    public destroy(): void {
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

    public onNewRelation(event: MatrixEvent): void {
        if (M_POLL_END.matches(event.getType())) {
            this.endEvent = event;
            this.emit(PollEvent.End);
        }

        // wait for poll to be initialised
        // @TODO(kerrya) races here?
        if (!this.responses) {
            return;
        }

        if (event.isDecryptionFailure()) {
            // undecryptableRelationsCount++
            return;
        }
        const pollCloseTimestamp = this.endEvent?.getTs() || Number.MAX_SAFE_INTEGER;
        if (
            M_POLL_RESPONSE.matches(event.getType()) &&
            // response made before poll closed
            event.getTs() <= pollCloseTimestamp
        ) {
            this.responses.addEvent(event);
        }

    }

    private async fetchResponses(): Promise<void> {
        this.fetchingResponsesPromise = new Promise<void>(() => {});

        // we want:
        // - stable and unstable M_POLL_RESPONSE
        // - stable and unstable M_POLL_END
        // so make one api call and filter by event type client side
        const allRelations = await this.matrixClient.relations(
            this.roomId,
            this.rootEvent.getId()!,
            'm.reference',
        )

        console.log('hhh', { allRelations });

        // @TODO(kerrya) paging results

        const responses = new Relations('m.reference', M_POLL_RESPONSE.name, this.matrixClient);
        let undecryptableRelationsCount = 0;

        const pollEndEvent = allRelations.events.find(event => M_POLL_END.matches(event.getType()));
        const pollCloseTimestamp = pollEndEvent?.getTs() || Number.MAX_SAFE_INTEGER;

        allRelations.events.forEach(event => {
            if (event.isDecryptionFailure()) {
                undecryptableRelationsCount++
                return;
            }
            if (
                M_POLL_RESPONSE.matches(event.getType()) &&
                // response made before poll closed
                event.getTs() <= pollCloseTimestamp
            ) {
                responses.addEvent(event);
            }
        })

        console.log('hhh', 'relations!!', responses);


        this.responses = responses;
        this.endEvent = pollEndEvent;
        this.emit(PollEvent.Responses, this.responses);
    }
}
