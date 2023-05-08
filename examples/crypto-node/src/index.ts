import credentials from "./credentials.js";
import { rl, prompt, printRoomList, printMessages, printMemberList, printRoomInfo } from "./io.js";
import { start, verifyRoom, getRoomList } from "./matrix.js";
import sdk from "./matrix-importer.js";
import type { Room, EventType } from "../../../lib/index.js";

let roomList: Room[] = [];
let viewingRoom: Room | null = null;

const client = await start(credentials, { forgetDevices: true });

client.on(sdk.ClientEvent.Room, () => {
	roomList = getRoomList(client);

	if (!viewingRoom) {
		printRoomList(roomList);
	}

	prompt();
});

client.on(sdk.RoomEvent.Timeline, async(event, room) => {
	const type = event.getType() as EventType;

	if (![sdk.EventType.RoomMessage, sdk.EventType.RoomMessageEncrypted].includes(type)) {
		return;
	}

	if (room != null && room.roomId !== viewingRoom?.roomId) {
		return;
	}

	await client.decryptEventIfNeeded(event);

	prompt(event.getContent().body);
});

rl.on("line", async (line: string) => {
	if (line.trim().length === 0) {
		prompt();
		return;
	}

	if (viewingRoom == null && line.indexOf("/join ") === 0) {
		const index = line.split(" ")[1];

		if (roomList[index] == null) {
			prompt("invalid room");
			return;
		}

		if (roomList[index].getMember(client.getUserId()).membership === sdk.JoinRule.Invite) {
			await client.joinRoom(roomList[index].roomId);
		}

		await verifyRoom(client, roomList[index]);

		viewingRoom = roomList[index];
		await client.roomInitialSync(roomList[index].roomId, 20);

		if (viewingRoom) {
			printMessages(viewingRoom);
		} else {
			printRoomList(roomList);
		}

		prompt();
		return;
	}

	if (viewingRoom != null && line.indexOf("/invite ") === 0) {
		const userId = line.split(" ")[1].trim();

		try {
			await client.invite(viewingRoom.roomId, userId);

			prompt();
		} catch (error) {
			prompt(`/invite Error: ${error}`);
		}

		return;
	}

	if (viewingRoom != null && line.indexOf("/members") === 0) {
		printMemberList(viewingRoom);
		prompt();
		return;
	}

	if (viewingRoom != null && line.indexOf("/roominfo") === 0) {
		printRoomInfo(viewingRoom);
		prompt();
		return;
	}

	if (viewingRoom != null && line.indexOf("/exit") === 0) {
		viewingRoom = null;
		printRoomList(roomList);
		prompt();
		return;
	}

	if (viewingRoom != null) {
		const message = {
			msgtype: sdk.MsgType.Text,
			body: line
		};

		await client.sendMessage(viewingRoom.roomId, message);

		prompt();
		return;
	}

	prompt("invalid command");
});

roomList = getRoomList(client);
printRoomList(roomList);
prompt();
