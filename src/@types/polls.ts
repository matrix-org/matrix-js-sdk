/*
Copyright 2021 The Matrix.org Foundation C.I.C.

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

import { UnstableValue } from "../NamespacedValue";
import { IContent } from "../models/event";
import { TEXT_NODE_TYPE } from "./extensible_events";

export const POLL_START_EVENT_TYPE = new UnstableValue(
    "m.poll.start", "org.matrix.msc3381.poll.start");

export const POLL_RESPONSE_EVENT_TYPE = new UnstableValue(
    "m.poll.response", "org.matrix.msc3381.poll.response");

export const POLL_END_EVENT_TYPE = new UnstableValue(
    "m.poll.end", "org.matrix.msc3381.poll.end");

export const POLL_KIND_DISCLOSED = new UnstableValue(
    "m.poll.disclosed", "org.matrix.msc3381.poll.disclosed");

export const POLL_KIND_UNDISCLOSED = new UnstableValue(
    "m.poll.undisclosed", "org.matrix.msc3381.poll.undisclosed");

export interface IPollAnswer extends IContent {
    id: string;
    [TEXT_NODE_TYPE.name]: string;
}

export interface IPollContent extends IContent {
    [POLL_START_EVENT_TYPE.name]: {
        kind: string; // disclosed or undisclosed (untypeable for now)
        question: {
            [TEXT_NODE_TYPE.name]: string;
        };
        answers: IPollAnswer[];
    };
    [TEXT_NODE_TYPE.name]: string;
}

export interface IPollResponseContent extends IContent {
    [POLL_RESPONSE_EVENT_TYPE.name]: {
        answers: string[];
    };
    "m.relates_to": {
        "event_id": string;
        "rel_type": string;
    };
}

export interface IPollEndContent extends IContent {
    [POLL_END_EVENT_TYPE.name]: {};
    "m.relates_to": {
        "event_id": string;
        "rel_type": string;
    };
}
