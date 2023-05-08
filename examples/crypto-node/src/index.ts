import olm from "@matrix-org/olm";
import fs from "fs/promises";
import readline from "readline";
import credentials from "./credentials.js";

const oldFetch = fetch;

global.fetch = async function (input: RequestInfo | URL | string, init?: RequestInit): Promise<Response> {
	if (typeof input == "string" && input.charAt(0) === "/") {
		return await fs.readFile(input).then(d => new Response(d, {
			headers: { "content-type": "application/wasm" }
		}));
	}

	return await oldFetch.apply(this, [input, init]);
};

global.Olm = olm;

import * as sdk from "../../../lib/index.js";
import { logger } from "../../../lib/logger.js";
import type { MatrixClient, Room } from "../../../lib/index.js";

logger.setLevel(4);

let roomList: Room[] = [];
let viewingRoom: Room | null = null;

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout
});

rl.setPrompt("$ ");

const clearDevices = async (client: MatrixClient) => {
	const devices = await client.getDevices();

	const devicesIds = devices.devices
		.map(device => device.device_id)
		.filter(id => id !== client.getDeviceId());

	await Promise.all(devicesIds.map(id => client.deleteDevice(id)));
};

const startWithAccessToken = async (accessToken: string, deviceId: string) => {
	const client = sdk.createClient({
		userId: credentials.userId,
		baseUrl: credentials.baseUrl,
		accessToken,
		deviceId
	});

	await client.initCrypto();

	await client.startClient({ initialSyncLimit: 20 });

	const state: string = await new Promise(resolve => client.once(sdk.ClientEvent.Sync, resolve));

	if (state !== "PREPARED") {
		throw new Error("Sync failed.");
	}

	await clearDevices(client);

	return client;
};

const start = async () => {
	const loginClient = sdk.createClient({ baseUrl: credentials.baseUrl });

	const res = await loginClient.login("m.login.password", {
		user: credentials.userId,
		password: credentials.password
	});

	loginClient.stopClient();

	return await startWithAccessToken(res.access_token, res.device_id);
};

const verify = async (userId: string, deviceId: string) => {
	await client.setDeviceKnown(userId, deviceId);
	await client.setDeviceVerified(userId, deviceId);
};

const verifyAll = async (room: Room) => {
	const members = await room.getEncryptionTargetMembers();
	const verificationPromises: Promise<void>[] = [];

	for (const member of members) {
		const devices = client.getStoredDevicesForUser(member.userId);

		for (const device of devices) {

			if (device.isUnverified()) {
				verificationPromises.push( verify(member.userId, device.deviceId) );
			}
		}
	}

	await Promise.all(verificationPromises);
};


const setRoomList = (client: MatrixClient) => {
	roomList = client.getRooms();
	roomList.sort((a, b) => {
		const aEvents = a.getLiveTimeline().getEvents();
		const bEvents = b.getLiveTimeline().getEvents();

		const aMsg = aEvents[aEvents.length - 1];

		if (aMsg == null) {
			return -1;
		}

		const bMsg = bEvents[bEvents.length - 1];

		if (bMsg == null) {
			return 1;
		}

		if (aMsg.getTs() === bMsg.getTs()) {
			return 0;
		}

		return aMsg.getTs() > bMsg.getTs() ? 1 : -1;
	});
};

const fixWidth = (str: string, len: number) =>
	str.length > len ? `${str.substring(0, len - 1)}\u2026` : str.padEnd(len);

const printRoomList = () => {
	console.log("\nRoom List:");

	for (let i = 0; i < roomList.length; i++) {
		const events = roomList[i].getLiveTimeline().getEvents();
		const msg = events[events.length - 1];
		const dateStr = msg ? new Date(msg.getTs()).toISOString().replace(/T/, " ").replace(/\..+/, "") : "---";

		const roomName = fixWidth(roomList[i].name, 25);
		const memberCount = roomList[i].getJoinedMembers().length;

		console.log(`[${i}] ${roomName} (${memberCount} members)  ${dateStr}`);
	}
};

const printMessages = () => {
	if (!viewingRoom) {
		printRoomList();
		return;
	}

	const events = viewingRoom.getLiveTimeline().getEvents();

	for (const event of events) {
		if (event.getType() !== sdk.EventType.RoomMessage) {
			continue;
		}

		console.log(event.getContent().body);
	}
};

const client = await start();

client.on(sdk.ClientEvent.Room, () => {
	setRoomList(client);

	if (!viewingRoom) {
		printRoomList();
	}

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

			await verifyAll(roomList[index]);

			viewingRoom = roomList[index];
			await client.roomInitialSync(roomList[index].roomId, 20);

			printMessages();

			rl.prompt();
			return;
		}
	} else {
		const message = {
			msgtype: sdk.MsgType.Text,
			body: line
		};

		await client.sendMessage(viewingRoom.roomId, message);
		rl.prompt();
		return;
	}

	console.log("invalid command");
	rl.prompt();
});

client.on(sdk.RoomEvent.Timeline, async(event, room) => {
	if (!["m.room.message", "m.room.encrypted"].includes(event.getType())) {
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


setRoomList(client);
printRoomList();
rl.prompt();
