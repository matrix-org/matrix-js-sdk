// Description:
//
// Example showing how to send an end-to-end-encrypted (E2EE) message via
// Matrix.

// Requirements:
//
// - A user must exist (enter credentials below).
// - A room must exist, where the existing user is a joined member (enter room
//   ID, below).
//
// Tested with:
//
// - NodeJS v18.17.1
// - matrix-js-sdk v28.2.0
// - olm v3.1.5

import * as sdk from 'matrix-js-sdk';
import olm from 'olm';

const sLogPrefix = '*** MAIN ***: ',
    sC = {
        userName: '********',
        password: '********',
        rawUrl: 'matrix.org',

        roomId: '********',
        msg: 'Hello World!'
    };

function log(msg)
{
    console.log(`${sLogPrefix}${msg}`);
};

let client = null;

globalThis.Olm = olm;

client = sdk.createClient({ baseUrl: `https://${sC.rawUrl}` });    

const pwLoginRes = await client.loginWithPassword(sC.userName, sC.password);

client = sdk.createClient(
    {
        baseUrl: `https://${sC.rawUrl}`,
        cryptoStore: new sdk.MemoryCryptoStore(),
        deviceId: pwLoginRes.device_id,
        accessToken: pwLoginRes.access_token,
        userId: pwLoginRes.user_id
    });

client.on(
    'sync',
    async (state/*, prevState, res*/) =>
    {
        log(`State \"${state}\" is reached.`);

        if(state === 'PREPARED')
        {
            try
            {
                await client.setRoomEncryption(
                    sC.roomId, 
                    { 
                        algorithm: 'm.megolm.v1.aes-sha2' // Seems to be OK..
                    });
            }
            catch(roomEncErr)
            {
                log(`Error: \"${roomEncErr.message}\"!`);
                process.exit(1);
            }

            // Marking all devices as verified:
            //
            {
                const room = client.getRoom(sC.roomId);
                const encTargetMembRes =
                    await room.getEncryptionTargetMembers();
                const userIds = encTargetMembRes.map(
                    roomMemb => roomMemb.userId);

                const devInfoRes = await client.downloadKeys(userIds, false);
                //
                // Better use the function below, but it fails with
                // NodeJS v18.17.1, matrix-js-sdk v28.2.0 and olm v3.1.5:
                //
                // const devInfoRes = await client.getUserDeviceInfo(
                //     userIds, true);

                for(const [userId, devInfos] of devInfoRes)
                {
                    for(const devId of devInfos.keys())
                    {
                        try
                        {
                            await client.setDeviceVerified(userId, devId, true);
                        }
                        catch(devVerifyErr)
                        {
                            log(`Error: \"${devVerifyErr.message}\"!`);
                            process.exit(1);
                        }
                    }
                }
            }

            try
            {
                await client.sendTextMessage(sC.roomId, sC.msg);
            }
            catch(sendErr)
            {
                log(`Error: \"${sendErr.message}\"!`);
                process.exit(1);
            }

            await client.stopClient();
            await client.logout();
            process.exit(0);
        }
    });

await client.initCrypto();
await client.startClient();