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

import {type MatrixEvent} from "./event.ts";
import {MsgType} from "../@types/event.ts";

// XXX: The events-sdk doesn't have updated types for as-accepted MSC1767
interface MTextContentBlock {
    "m.text": {"body": string}[]; // XXX: Incomplete types
}

/**
 * Represents all of a bot's commands, as described by MSC4332. Consumes an MSC4332-shaped state event.
 *
 * Warning: this is an unstable API/interface and may change without notice.
 */
export class MSC4332BotCommands {
    public readonly sigil: string;
    public readonly commands: MSC4332BotCommand[] = [];

    /**
     * Creates a new MSC4332BotCommands object from an MSC4332-shaped state event.
     * @param stateEvent The `org.matrix.msc4332.commands` state event to parse.
     * @throws Error If the event is not a valid MSC4332-shaped state event.
     */
    public constructor(private stateEvent: MatrixEvent) {
        // Sanity checks
        if (!this.stateEvent.isState()) {
            throw new Error("Not a state event");
        }
        if (this.stateEvent.getType() !== "org.matrix.msc4332.commands") {
            throw new Error("Not a commands event");
        }
        if (this.stateEvent.getStateKey() !== stateEvent.getSender()) {
            throw new Error("Not a commands event for the sender");
        }

        // We now have vaguely the right shape, so try to parse it
        this.sigil = this.stateEvent.getContent()["sigil"];
        if (!this.sigil) {
            throw new Error("No sigil");
        }
        const commands = stateEvent.getContent()["commands"];
        if (!commands) {
            throw new Error("No commands");
        }
        for (const command of commands) {
            this.commands.push(new MSC4332BotCommand(this, command));
        }
    }

    /**
     * Gets the bot's user ID.
     */
    public get userId(): string {
        return this.stateEvent.getSender()!;
    }

    /**
     * Gets a command, or null if it doesn't exist.
     * @param syntaxOrId The syntax of the command, or the ID of the command.
     * @returns The command, or null if it doesn't exist.
     */
    public getCommand(syntaxOrId: string): MSC4332BotCommand | null {
        // For now, command IDs are just the syntax strings
        for (const command of this.commands) {
            if (command.definition.syntax === syntaxOrId) {
                return command;
            }
        }
        return null; // not found
    }
}

/**
 * An MSC4332 command definition.
 */
export interface MSC4332BotCommandDefinition {
    /**
     * The syntax of the command.
     */
    syntax: string;

    /**
     * The variables and their descriptions from the syntax.
     */
    variables: Record<string, MTextContentBlock>;

    /**
     * The description of the command.
     */
    description: MTextContentBlock;
}

/**
 * A rendered MSC4332 command, expected to be sent as an `m.room.message` event to the room.
 */
export interface MSC4332MRoomMessageContent {
    body: string;
    msgtype: MsgType.Text;
    "m.mentions": {
        user_ids: string[];
    };
    "org.matrix.msc4332.command": {
        syntax: string;
        variables: Record<string, string>;
    };
}

/**
 * An MSC4332 command.
 */
export class MSC4332BotCommand {
    /**
     * Creates a new MSC4332BotCommand object from the given parent bot commands definition and the specific command definition.
     * @param botCommands The parent bot commands object.
     * @param definition The command definition.
     * @throws Error If the command definition is invalid.
     */
    public constructor(public readonly botCommands: MSC4332BotCommands, public readonly definition: MSC4332BotCommandDefinition) {
        if (!this.definition.syntax) {
            throw new Error("No syntax");
        }
        if (!this.definition.variables) {
            this.definition.variables = {};
        }
        for (const [name, variable] of Object.entries(this.definition.variables)) {
            // XXX: This is not how you search for a plaintext representation.
            if (!variable["m.text"]?.[0]?.body) {
                throw new Error(`Variable ${name} has no body`);
            }
        }
        // XXX: This is not how you search for a plaintext representation.
        if (!this.definition.description || !this.definition.description["m.text"]?.[0]?.body) {
            throw new Error("No description");
        }
    }

    /**
     * Renders the command to a room message event content object using the supplied variables as replacements.
     * @param variables The variables to populate.
     * @returns The rendered command.
     * @throws Error If any of the variables supplied are not defined, or if any variables are not supplied.
     */
    public render(variables: Record<string, string>): MSC4332MRoomMessageContent {
        let rendered = this.definition.syntax;
        for (const [name, val] of Object.entries(variables)) {
            const variable = this.definition.variables[name];
            if (!variable) {
                throw new Error(`Variable ${name} not defined`);
            }
            rendered = rendered.replace(`{${name}}`, val);
        }
        for (const name of Object.keys(this.definition.variables)) {
            if (!variables[name]) {
                throw new Error(`Variable ${name} not supplied`);
            }
        }

        return {
            body: `${this.botCommands.sigil}${rendered}`,
            msgtype: MsgType.Text,
            "m.mentions": {
                user_ids: [this.botCommands.userId],
            },
            "org.matrix.msc4332.command": {
                syntax: this.definition.syntax,
                variables,
            },
        };
    }
}
