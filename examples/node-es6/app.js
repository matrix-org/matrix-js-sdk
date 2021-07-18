import log from 'loglevel';
import matrix from 'matrix-js-sdk';

const room = 'YourRoomHere';
const baseUrl = 'YourBaseUrlHere';

// These are passed as script arguments.
const user = process.argv[2];
const password = process.argv[3];

// Filter to help reduce number of events listened.
// Q: Can it be made more precise for this example?
const definition = {
    room: {
        rooms: [room],
        timeline: {
            limit: 0, // do not sync old events
            types: ['m.room.message'] // listen to only messages
        }
    }
};

// Reduce matrix logging to only warnings.
log.getLogger('matrix').setDefaultLevel('WARN');

const client = matrix.createClient({ baseUrl });
await client.login('m.login.password', { user, password });

// Q: Will this filter be saved on the server?
const filter = matrix.Filter.fromJson(client.getUserId(), null, definition);
await client.startClient({ filter });

// Q: Is this handled automatically in the previous `startClient` call?
await new Promise((resolve, reject) => {
    client.once('sync', (state) => {
        if (state === 'PREPARED') {
            resolve();
        } else {
            reject(new Error('matrix client sync failed'));
        }
    });
});

client.on('Room.timeline', async (event) => {
    const sender = event.getSender();
    const message = event.getContent().body;

    // Print every message - including our own.
    console.info(`${sender}: ${message}`);

    // Super awkward small talk.
    // Note that they might have already left by the time our message is sent.
    if (sender !== client.getUserId()) {
        if (message === 'hello everyone') {
            await client.sendTextMessage(room, `hello ${event.getSender()}`);
        } else if (message === 'adios everyone') {
            await client.sendTextMessage(room, `adios ${event.getSender()}`);
        }
    }
});

await client.joinRoom(room);
await client.sendTextMessage(room, 'hello everyone');

// Leave after 50 seconds.
setTimeout(async () => {
    await client.sendTextMessage(room, 'adios everyone');
    await client.leave(room);
    client.stopClient();
}, 50_000);
