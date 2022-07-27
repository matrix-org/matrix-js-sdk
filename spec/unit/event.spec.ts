/*
Copyright 2017 New Vector Ltd
Copyright 2019, 2022 The Matrix.org Foundation C.I.C.

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

import { MatrixEvent } from "../../src/models/event";

describe("MatrixEvent", () => {
    describe(".attemptDecryption", () => {
        let encryptedEvent;
        const eventId = 'test_encrypted_event';

        beforeEach(() => {
            encryptedEvent = new MatrixEvent({
                event_id: eventId,
                type: 'm.room.encrypted',
                content: {
                    ciphertext: 'secrets',
                },
            });
        });

        it('should retry decryption if a retry is queued', async () => {
            const eventAttemptDecryptionSpy = jest.spyOn(encryptedEvent, 'attemptDecryption');

            const crypto = {
                decryptEvent: jest.fn()
                    .mockImplementationOnce(() => {
                        // schedule a second decryption attempt while
                        // the first one is still running.
                        encryptedEvent.attemptDecryption(crypto);

                        const error = new Error("nope");
                        error.name = 'DecryptionError';
                        return Promise.reject(error);
                    })
                    .mockImplementationOnce(() => {
                        return Promise.resolve({
                            clearEvent: {
                                type: 'm.room.message',
                            },
                        });
                    }),
            };

            await encryptedEvent.attemptDecryption(crypto);

            expect(eventAttemptDecryptionSpy).toHaveBeenCalledTimes(2);
            expect(crypto.decryptEvent).toHaveBeenCalledTimes(2);
            expect(encryptedEvent.getType()).toEqual('m.room.message');
        });
    });
});
