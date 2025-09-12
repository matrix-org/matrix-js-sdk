/*
Copyright 2025 The Matrix.org Foundation C.I.C.

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

import type {MatrixClient} from "../client.ts";
import {Direction} from "./event-timeline.ts";
import {
    MSC4332BotCommand,
    type MSC4332BotCommandDefinition,
    MSC4332BotCommands,
    type MSC4332MRoomMessageContent
} from "./msc4332-commands.ts";
import {KnownMembership} from "../@types/membership.ts";

export interface MSC4333RoomModerationConfig {
    managementRoomId: string;
    botUserId: string;
    banCommand: MSC4333UserActionCommand;
    kickCommand: MSC4333UserActionCommand;
    redactEventCommand: MSC4333EventActionCommand;
    redactUserCommand: MSC4333UserActionCommand;
}

interface MSC4333ModerationCommand {
    use: string;
    prefill_variables?: Record<string, string>;
}

export class MSC4333RoomMap {
    public constructor(private client: MatrixClient) {
    }

    public getModerationConfigFor(roomId: string): MSC4333RoomModerationConfig | null {
        for (const room of this.client.getRooms()) {
            const roomState = room.getLiveTimeline().getState(Direction.Forward)!;

            const moderationConfigs = roomState.getStateEvents("org.matrix.msc4333.moderation_config");
            for (const moderationConfig of moderationConfigs) {
                if (moderationConfig.getStateKey() !== moderationConfig.getSender()) {
                    continue; // not a config for a bot
                }
                if (room.getMember(moderationConfig.getSender()!)?.membership !== KnownMembership.Join) {
                    continue; // bot isn't in the room
                }
                const protectedRooms = moderationConfig.getContent()["protected_room_ids"] as string[];
                if (!protectedRooms?.includes(roomId)) {
                    continue; // not a protected room for this management room
                }

                const botCommands = roomState.getStateEvents("org.matrix.msc4332.commands", moderationConfig.getSender()!);
                if (!botCommands) {
                    continue; // not a bot with commands
                }
                const parsedCommands = new MSC4332BotCommands(botCommands);

                const parse = <E extends MSC4333ActionCommand>(action: string): E | null => {
                    const actionConfig = moderationConfig.getContent()["commands"]?.[action] as MSC4333ModerationCommand;
                    const command = parsedCommands.getCommand(actionConfig?.use);
                    if (!command) {
                        return null;
                    }
                    const definition: MSC4333ModerationCommandDefinition = {
                        prefillVariables: actionConfig.prefill_variables,
                        ...command.definition,
                    };
                    if (action === "redact_event") {
                        return new MSC4333EventActionCommand(parsedCommands, definition) as E;
                    }
                    return new MSC4333UserActionCommand(parsedCommands, definition) as E;
                };

                const banCommand = parse<MSC4333UserActionCommand>("ban");
                const kickCommand = parse<MSC4333UserActionCommand>("kick");
                const redactEventCommand = parse<MSC4333EventActionCommand>("redact_event");
                const redactUserCommand = parse<MSC4333UserActionCommand>("redact_user");
                if (banCommand && kickCommand && redactEventCommand && redactUserCommand) {
                    return {
                        managementRoomId: moderationConfig.getRoomId()!,
                        botUserId: moderationConfig.getSender()!,
                        banCommand,
                        kickCommand,
                        redactEventCommand,
                        redactUserCommand,
                    };
                }
            }
        }

        return null; // no config found
    }
}

export interface MSC4333ModerationCommandDefinition extends MSC4332BotCommandDefinition {
    prefillVariables?: Record<string, string>;
}

export type MSC4333ActionCommand = MSC4333UserActionCommand | MSC4333EventActionCommand;

export class MSC4333UserActionCommand {
    private command: MSC4332BotCommand;

    public constructor(botCommands: MSC4332BotCommands, private definition: MSC4333ModerationCommandDefinition) {
        this.command = new MSC4332BotCommand(botCommands, definition);
    }

    public render(againstUserId: string, inRoomId: string, forReason: string): MSC4332MRoomMessageContent {
        return this.command.render({
            // Apply prefill first so we can override it
            ...(this.definition as MSC4333ModerationCommandDefinition).prefillVariables,

            // Supply everything we can
            userId: againstUserId,
            roomId: inRoomId,
            reason: forReason,
            permalink: `https://matrix.to/#/${encodeURIComponent(againstUserId)}`,
        });
    }
}

export class MSC4333EventActionCommand {
    private command: MSC4332BotCommand;

    public constructor(botCommands: MSC4332BotCommands, private definition: MSC4333ModerationCommandDefinition) {
        this.command = new MSC4332BotCommand(botCommands, definition);
    }

    public render(againstEventId: string, inRoomId: string, forReason: string): MSC4332MRoomMessageContent {
        return this.command.render({
            // Apply prefill first so we can override it
            ...(this.definition as MSC4333ModerationCommandDefinition).prefillVariables,

            // Supply everything we can
            eventId: againstEventId,
            roomId: inRoomId,
            reason: forReason,
            permalink: `https://matrix.to/#/${encodeURIComponent(inRoomId)}/${encodeURIComponent(againstEventId)}`,
        });
    }
}
