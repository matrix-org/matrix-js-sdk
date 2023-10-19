/*
Copyright 2023 Šimon Brandner <simon.bra.ag@gmail.com>

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

import { IRoomSummaryAPIResponse } from "../client";

export interface BreakoutEventContentRoom {
    via: string[];
    users: string[];
}

export interface BreakoutEventContentRooms {
    [key: string]: BreakoutEventContentRoom;
}

export interface BreakoutEventContent {
    "m.breakout": BreakoutEventContentRooms;
}

export interface BreakoutRoomBase {
    users: string[];
}

export interface NewBreakoutRoom extends BreakoutRoomBase {
    roomName: string;
}

export interface ExistingBreakoutRoom extends BreakoutRoomBase {
    roomId: string;
}

export interface ExistingBreakoutRoomWithSummary extends ExistingBreakoutRoom {
    roomSummary: IRoomSummaryAPIResponse;
}
