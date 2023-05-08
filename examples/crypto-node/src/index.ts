import credentials from "./credentials.js";
import { rl, printRoomList, printMessages, printMemberList } from "./io.js";
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

	rl.prompt();
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

	process.stdout.clearLine(-1);
	process.stdout.cursorTo(0);
	console.log(event.getContent().body);
	rl.prompt();
});

rl.on("line", async (line: string) => {
	if (line.trim().length === 0) {
		rl.prompt();
		return;
	}

	if (viewingRoom == null) {
		if (line.indexOf("/join ") === 0) {
			const index = line.split(" ")[1];

			if (roomList[index] == null) {
				console.log("invalid room");
				rl.prompt();
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

			rl.prompt();
			return;
		}
	} else {
		if (line.indexOf("/members") === 0) {
			printMemberList(viewingRoom);
		} else {
			const message = {
				msgtype: sdk.MsgType.Text,
				body: line
			};

			await client.sendMessage(viewingRoom.roomId, message);
		}
		rl.prompt();
		return;
	}

	console.log("invalid command");
	rl.prompt();
});

roomList = getRoomList(client);
printRoomList(roomList);
rl.prompt();
