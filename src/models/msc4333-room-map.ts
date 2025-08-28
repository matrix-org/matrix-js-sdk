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
    banCommand: MSC4332BotCommand;
    kickCommand: MSC4332BotCommand;
    redactEventCommand: MSC4332BotCommand;
    redactUserCommand: MSC4332BotCommand;
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

                const parse = (action: string): MSC4333ActionCommand | null => {
                    const actionConfig = moderationConfig.getContent()["commands"]?.[action] as MSC4333ModerationCommand;
                    const command = parsedCommands.getCommand(actionConfig?.use);
                    if (!command) {
                        return null;
                    }
                    return new MSC4333ActionCommand(parsedCommands, {
                        prefillVariables: actionConfig.prefill_variables,
                        ...command.definition,
                    });
                };

                const banCommand = parse("ban");
                const kickCommand = parse("kick");
                const redactEventCommand = parse("redact_event");
                const redactUserCommand = parse("redact_user");
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

export class MSC4333ActionCommand extends MSC4332BotCommand {
    public constructor(botCommands: MSC4332BotCommands, definition: MSC4333ModerationCommandDefinition) {
        super(botCommands, definition);
    }

    public renderAsUserAction(againstUserId: string, inRoomId: string, forReason: string): MSC4332MRoomMessageContent {
        return super.render({
            // Apply prefill first so we can override it
            ...(this.definition as MSC4333ModerationCommandDefinition).prefillVariables,

            // Supply everything we can
            userId: againstUserId,
            roomId: inRoomId,
            reason: forReason,
            permalink: `https://matrix.to/#/${encodeURIComponent(againstUserId)}`,
        });
    }

    public renderAsEventAction(againstEventId: string, inRoomId: string, forReason: string): MSC4332MRoomMessageContent {
        return super.render({
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
