import { MatrixEvent } from '../../src';
import { TestClient } from '../TestClient';

describe('Store ignored invites', function() {
    let client;

    beforeEach(function() {
        client = new TestClient("foobar", "device");

        // Mockup account data storage.
        const dataStore = new Map();
        client.client.setAccountData = function(eventType, content) {
            dataStore.set(eventType, content);
            return Promise.resolve();
        };
        client.client.getAccountData = function(eventType) {
            const data = dataStore.get(eventType);
            return new MatrixEvent({
                content: data,
            });
        };
    });

    afterEach(function() {
        client.stop();
    });

    it('Stores ignored invites', async function() {
        // Initially, the invite list should be empty but not `null`.
        expect(await client.client.getIgnoredInvites()).toEqual({});

        // Insert something, we should be able to recover it.
        const SAMPLE = {
            ignored_rooms: [
                {
                    room_id: "12345",
                    ts: Date.now(),
                },
            ],
        };
        const promise = client.client.setIgnoredInvites(SAMPLE);
        await client.httpBackend.flush();
        await promise;

        // Check that it was (mock)stored on the client.
        expect(await client.client.getIgnoredInvites()).toEqual(SAMPLE);
    });
});
