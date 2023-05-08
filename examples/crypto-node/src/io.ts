import readline from "readline";
import { EventType, Room } from "../../../lib/index.js"

/**
 * Setup the line reader.
 */
export const rl = readline.createInterface({
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
