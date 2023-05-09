/**
 * This file glues the matrix helper methods in './matrix.ts' with the IO helper
 * methods in './io.ts' together to create a simple CLI.
 */

import Path from "path";
import { fileURLToPath } from 'url';

/**
 * Import out IO helper methods.
 */
import {
	readCredentials,
	prompt,
	fixWidth,
	printRoomList,
	printMessage,
	printMessages,
	printMemberList,
	printRoomInfo,
	addCommand
} from "./io.js";

/**
 * Import our matrix helper methods.
 */
import { start, verifyRoom, getRoomList, clearDevices } from "./matrix.js";

/**
 * Import the types and enums from matrix-js-sdk.
 */
import { ClientEvent, RoomEvent, EventType, JoinRule, MsgType } from "matrix-js-sdk"
import type { Room } from "matrix-js-sdk";

/**
 * Global state for keeping track of rooms.
 */
let roomList: Room[] = [];
let viewingRoom: Room | null = null;

/**
* Import the user's credentials.
*/
const dirname = Path.dirname(fileURLToPath(import.meta.url));
const credentials = await readCredentials(Path.join(dirname, "../credentials.json"));

/**
 * Create our matrix client.
 */
const client = await start(credentials);

/**
 * When a room is added or removed update the room list.
 */
client.on(ClientEvent.Room, () => {
	roomList = getRoomList(client);

	if (!viewingRoom) {
		printRoomList(roomList);
	}

	prompt();
});

/**
 * When we receive a message, check if we are in that room and if so display it.
 */
client.on(RoomEvent.Timeline, async(event, room) => {
	const type = event.getType() as EventType;

	if (![EventType.RoomMessage, EventType.RoomMessageEncrypted].includes(type)) {
		return;
	}

	if (room != null && room.roomId !== viewingRoom?.roomId) {
		return;
	}

	await client.decryptEventIfNeeded(event);

	printMessage(event);
	prompt();
});

/**
 * Below is all of the possible commands and definitions.
 */

/**
 * Basic help command, displays the possible commands.
 */
addCommand("/help", () => {
	const displayCommand = (command: string, description: string) => {
		console.log(`  ${fixWidth(command, 20)} : ${description}`);
	};

	console.log("Global commands:");
	displayCommand("/help", "Show this help.");
	displayCommand("/quit", "Quit the program.");
	displayCommand("/cleardevices", "Clear all other devices from this account.");

	console.log("Room list index commands:");
	displayCommand("/join <index>", "Join a room, e.g. '/join 5'");

	console.log("Room commands:");
	displayCommand("/exit", "Return to the room list index.");
	displayCommand("/send <message>", "Send a message to the room, e.g. '/send Hello World.'");
	displayCommand("/members", "Show the room member list.");
	displayCommand("/invite @foo:bar", "Invite @foo:bar to the room.");
	displayCommand("/roominfo", "Display room info e.g. name, topic.");
});

/**
 * Quit command for quitting the program.
 */
addCommand("/quit", () => {
	process.exit();
});

/**
 * Clear devices command for removing all other devices from the users account.
 */
addCommand("/cleardevices", async () => {
	await clearDevices(client);
});

/**
 * Join room command for joining a room from the room index.
 */
addCommand("/join", async (index) => {
	if (viewingRoom != null) {
		return "You must first exit your current room.";
	}

	viewingRoom = roomList[index];

	if (viewingRoom == null) {
		return "Invalid Room.";
	}

	if (viewingRoom.getMember(client.getUserId() ?? "")?.membership === JoinRule.Invite) {
		await client.joinRoom(viewingRoom.roomId);
	}

	await verifyRoom(client, viewingRoom);
	await client.roomInitialSync(viewingRoom.roomId, 20);

	printMessages(viewingRoom);
});

/**
 * Exit command for exiting a joined room.
 */
addCommand("/exit", () => {
	viewingRoom = null;
	printRoomList(roomList);
});

/**
 * Invite command for inviting a user to the current room.
 */
addCommand("/invite", async (userId) => {
	if (viewingRoom == null) {
		return "You must first join a room.";
	}

	try {
		await client.invite(viewingRoom.roomId, userId);
	} catch (error) {
		return `/invite Error: ${error}`;
	}
});

/**
 * Members command, displays the list of members in the current room.
 */
addCommand("/members", async () => {
	if (viewingRoom == null) {
		return "You must first join a room.";
	}

	printMemberList(viewingRoom);
});

/**
 * Members command, displays the information about the current room.
 */
addCommand("/roominfo", async () => {
	if (viewingRoom == null) {
		return "You must first join a room.";
	}

	printRoomInfo(viewingRoom);
});

/**
 * Send command for allowing the user to send messages in the current room.
 */
addCommand("/send", async (...tokens) => {
	if (viewingRoom == null) {
		return "You must first join a room.";
	}

	console.log(tokens);
	console.log(tokens.join(" "));

	const message = {
		msgtype: MsgType.Text,
		body: tokens.join(" ")
	};

	await client.sendMessage(viewingRoom.roomId, message);
});

/**
 * Initialize the room list.
 */
roomList = getRoomList(client);

/**
 * Print the list of rooms.
 */
printRoomList(roomList);

/**
 * Request the first input from the user.
 */
prompt();
