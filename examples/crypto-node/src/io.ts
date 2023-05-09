import readline from "readline";
import { Direction, EventType, Room } from "../../../lib/index.js"

export type Command = (...args: string[]) => Promise<string | void> | string | void

/**
 * Setup the line reader.
 */
const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

rl.setPrompt("$ ");

/**
 * Clear any text on the current line.
 */
export const clearLine = (): void => {
	process.stdout.clearLine(-1);
	process.stdout.cursorTo(0);
};

const commands = new Map<string, Command>();

rl.on("line", async line => {
	for (const [command, method] of commands.entries()) {
		if (line.indexOf(command) === 0) {
			const args = line.split(" ");

			args.shift();

			const result = await method(...args);

			// Result can be void so we need to use this nullish coalescing operator
			// to convert it to undefined.
			prompt(result ?? undefined);
			return;
		}
	}

	prompt("Invalid command.");
});

/**
 * Prompt the user with an optional string preserving input text.
 */
export const prompt = (text?: string): void => {
	const cursor = rl.getCursorPos();

	clearLine();

	if (text != null) {
		console.log(text);
	}

	process.stdout.cursorTo(cursor.cols);

	rl.prompt(true);
};

/**
 * Add a command to execute when the user sends input.
 */
export const addCommand = (command: string, method: Command): void => {
	commands.set(command, method);
};

/**
 * Fix a string to a specific width.
 */
export const fixWidth = (str: string, len: number): string =>
	str.length > len ? `${str.substring(0, len - 1)}\u2026` : str.padEnd(len);

/**
 * Create a human readable string from a timestamp.
 */
export const tsToDateString = (ts: number): string =>
	new Date(ts).toISOString().replace(/T/, " ").replace(/\..+/, "");

/**
 * Print a list of rooms to the console.
 */
export const printRoomList = (rooms: Room[]): void => {
	console.log("\nRoom List:");

	for (const [i, room] of rooms.entries()) {
		const events = room.getLiveTimeline().getEvents();
		const msg = events[events.length - 1];
		const date = msg ? tsToDateString(msg.getTs()) : "---";
		const name = fixWidth(room.name, 25);
		const count = room.getJoinedMembers().length;

		console.log(`[${i}] ${name} (${count} members)  ${date}`);
	}
};

/**
 * Print a list of messages for a room.
 */
export const printMessages = (room: Room): void => {
	const events = room.getLiveTimeline().getEvents();

	for (const event of events) {
		// Ignore events that are not messages.
		if (event.getType() !== EventType.RoomMessage) {
			continue;
		}

		console.log(event.getContent().body);
	}
};

/**
 * Print a list of members in the room.
 */
export const printMemberList = (room: Room): void => {
	const members = room.getMembers();

	members.sort((a, b) => a.name === b.name ? 0 : a.name > b.name ? -1 : 1);

	console.log(`Membership list for room "${room.name}"`);

	for (const member of members) {
		if (member.membership == null) {
			continue;
		}

		const membership = fixWidth(member.membership, 10);

		console.log(`${membership} :: ${member.name} (${member.userId})`);
	}
};

/**
 * Print additional information about a room.
 */
export const printRoomInfo = (room: Room): void => {
	const state = room.getLiveTimeline().getState(Direction.Forward);
	const eTypeHeader = fixWidth("Event Type(state_key)", 26);
	const sendHeader = fixWidth("Sender", 26);
	const contentHeader = fixWidth("Content", 26);

	console.log(`${eTypeHeader}|${sendHeader}|${contentHeader}`);

	if (state == null) {
		return;
	}

	for (const [key, events] of state.events) {

		if (key === EventType.RoomMember) {
			continue;
		}

		for (const [stateKey, event] of events) {
			const postfix = stateKey.length < 1 ? "" : `(${stateKey})`;
			const typeAndKey = `${key}${postfix}`;
			const typeStr = fixWidth(typeAndKey, eTypeHeader.length);
			const sendStr = fixWidth(event.getSender() ?? "", sendHeader.length);
			const contentStr = fixWidth(JSON.stringify(event.getContent()), 26);

			console.log(`${typeStr}|${sendStr}|${contentStr}`);
		}
	}
};
