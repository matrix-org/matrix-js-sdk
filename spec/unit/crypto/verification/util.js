/*
Copyright 2019 New Vector Ltd

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

import TestClient from '../../../TestClient';

import sdk from '../../../..';
const MatrixEvent = sdk.MatrixEvent;

export async function makeTestClients(userInfos, options) {
    const clients = [];
    const clientMap = {};
    const sendToDevice = function(type, map) {
        // console.log(this.getUserId(), "sends", type, map);
        for (const [userId, devMap] of Object.entries(map)) {
            if (userId in clientMap) {
                for (const [deviceId, msg] of Object.entries(devMap)) {
                    if (deviceId in clientMap[userId]) {
                        const event = new MatrixEvent({
                            sender: this.getUserId(), // eslint-disable-line babel/no-invalid-this
                            type: type,
                            content: msg,
                        });
                        setTimeout(
                            () => clientMap[userId][deviceId]
                                .emit("toDeviceEvent", event),
                            0,
                        );
                    }
                }
            }
        }
    };

    for (const userInfo of userInfos) {
        const client = (new TestClient(
            userInfo.userId, userInfo.deviceId, undefined, undefined,
            options,
        )).client;
        if (!(userInfo.userId in clientMap)) {
            clientMap[userInfo.userId] = {};
        }
        clientMap[userInfo.userId][userInfo.deviceId] = client;
        client.sendToDevice = sendToDevice;
        clients.push(client);
    }

    await Promise.all(clients.map((client) => client.initCrypto()));

    return clients;
}
