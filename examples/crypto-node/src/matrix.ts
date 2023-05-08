/**
 * This file contains methods to help perform various actions through the matrix
 * sdk.
 */

import sdk from "./matrix-importer.js";
import type { MatrixClient, Room } from "../../../lib/index.js";

/**
 * This interface provides the details needed to perform a password login.
 */
export interface PasswordLogin {
	baseUrl: string
	userId: string
	password: string
}

/**
 * This interface provide the details needed to perform a token login.
 */
export interface TokenLogin {
	baseUrl: string
	userId: string
	accessToken: string
	deviceId: string
}

/**
 * Create a matrix client using a token login.
 */
export const startWithToken = async (tokenLogin: TokenLogin | sdk.ICreateClientOpts): Promise<MatrixClient> => {
	const client = sdk.createClient(tokenLogin);

	// We must initialize the crypto before starting the client.
	await client.initCrypto();

	// Now that crypto is initialized we can start the client.
	await client.startClient({ initialSyncLimit: 20 });

	// Wait until it finishes syncing.
	const state: string = await new Promise(resolve => client.once(sdk.ClientEvent.Sync, resolve));

	// If we do not recieve the correct state something has gone wrong.
	if (state !== "PREPARED") {
		throw new Error("Sync failed.");
	}

	return client;
};

/**
 * Get the access token and other details needed to perform a token login.
 */
export const getTokenLogin = async (passwordLogin: PasswordLogin): Promise<TokenLogin> => {
	// Create a dummy client pointing to the right homeserver.
	const loginClient = sdk.createClient({ baseUrl: passwordLogin.baseUrl });

	// Perform a password login.
	const response = await loginClient.login(sdk.AuthType.Password, {
		user: passwordLogin.userId,
		password: passwordLogin.password
	});

	// Stop the client now that we have got the access token.
	loginClient.stopClient();

	return {
		baseUrl: passwordLogin.baseUrl,
		userId: passwordLogin.userId,
		accessToken: response.access_token,
		deviceId: response.device_id
	};
};

/**
 * Clear all devices associated with this account except for the one currently
 * in use.
 */
export const clearDevices = async (client: MatrixClient) => {
	const devices = await client.getDevices();

	const devicesIds = devices.devices
		.map(device => device.device_id)
		.filter(id => id !== client.getDeviceId());

	await Promise.all(devicesIds.map(id => client.deleteDevice(id)));
};

/**
 * Start the client with a password login.
 */
export const start = async (passwordLogin: PasswordLogin, options?: { forgetDevices?: boolean }): Promise<MatrixClient> => {
	// Get the token login details.
	const tokenLogin = await getTokenLogin(passwordLogin);

	// Start the client with the token.
	const client = await startWithToken(tokenLogin);

	// Clear other devices - this can help resolve olm session issues.
	if (options?.forgetDevices) {
		await clearDevices(client);
	}

	return client;
}

/**
 * Mark a device associated with a user as verified.
 */
export const verifyDevice = async (client: MatrixClient, userId: string, deviceId: string): Promise<void> => {
	await client.setDeviceKnown(userId, deviceId);
	await client.setDeviceVerified(userId, deviceId);
};

/**
 * Verify all unverified devices in a room.
 */
export const verifyRoom = async (client: MatrixClient, room: Room): Promise<void> => {
	const members = await room.getEncryptionTargetMembers();
	const verificationPromises: Promise<void>[] = [];

	for (const member of members) {
		const devices = client.getStoredDevicesForUser(member.userId);

		for (const device of devices) {

			if (device.isUnverified()) {
				verificationPromises.push( verifyDevice(client, member.userId, device.deviceId) );
			}
		}
	}

	await Promise.all(verificationPromises);
};
