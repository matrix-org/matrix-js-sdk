// eslint-disable-next-line no-restricted-imports
import EventEmitter from "events";

// load olm before the sdk if possible
import '../olm-loader';

import { logger } from '../../src/logger';
import { IContent, IEvent, IUnsigned, MatrixEvent, MatrixEventEvent } from "../../src/models/event";
import { ClientEvent, EventType, IPusher, MatrixClient, MsgType } from "../../src";
import { SyncState } from "../../src/sync";
import { eventMapperFor } from "../../src/event-mapper";

/**
 * Return a promise that is resolved when the client next emits a
 * SYNCING event.
 * @param {Object} client The client
 * @param {Number=} count Number of syncs to wait for (default 1)
 * @return {Promise} Resolves once the client has emitted a SYNCING event
 */
export function syncPromise(client: MatrixClient, count = 1): Promise<void> {
    if (count <= 0) {
        return Promise.resolve();
    }

    const p = new Promise<void>((resolve) => {
        const cb = (state: SyncState) => {
            logger.log(`${Date.now()} syncPromise(${count}): ${state}`);
            if (state === SyncState.Syncing) {
                resolve();
            } else {
                client.once(ClientEvent.Sync, cb);
            }
        };
        client.once(ClientEvent.Sync, cb);
    });

    return p.then(() => {
        return syncPromise(client, count - 1);
    });
}

/**
 * Create a spy for an object and automatically spy its methods.
 * @param {*} constr The class constructor (used with 'new')
 * @param {string} name The name of the class
 * @return {Object} An instantiated object with spied methods/properties.
 */
export function mock<T>(constr: { new(...args: any[]): T }, name: string): T {
    // Based on http://eclipsesource.com/blogs/2014/03/27/mocks-in-jasmine-tests/
    const HelperConstr = new Function(); // jshint ignore:line
    HelperConstr.prototype = constr.prototype;
    // @ts-ignore
    const result = new HelperConstr();
    result.toString = function() {
        return "mock" + (name ? " of " + name : "");
    };
    for (const key of Object.getOwnPropertyNames(constr.prototype)) { // eslint-disable-line guard-for-in
        try {
            if (constr.prototype[key] instanceof Function) {
                result[key] = jest.fn();
            }
        } catch (ex) {
            // Direct access to some non-function fields of DOM prototypes may
            // cause exceptions.
            // Overwriting will not work either in that case.
        }
    }
    return result;
}

interface IEventOpts {
    type: EventType | string;
    room?: string;
    sender?: string;
    skey?: string;
    content: IContent;
    prev_content?: IContent;
    user?: string;
    unsigned?: IUnsigned;
    redacts?: string;
}

let testEventIndex = 1; // counter for events, easier for comparison of randomly generated events
/**
 * Create an Event.
 * @param {Object} opts Values for the event.
 * @param {string} opts.type The event.type
 * @param {string} opts.room The event.room_id
 * @param {string} opts.sender The event.sender
 * @param {string} opts.skey Optional. The state key (auto inserts empty string)
 * @param {Object} opts.content The event.content
 * @param {boolean} opts.event True to make a MatrixEvent.
 * @param {MatrixClient} client If passed along with opts.event=true will be used to set up re-emitters.
 * @return {Object} a JSON object representing this event.
 */
export function mkEvent(opts: IEventOpts & { event: true }, client?: MatrixClient): MatrixEvent;
export function mkEvent(opts: IEventOpts & { event?: false }, client?: MatrixClient): Partial<IEvent>;
export function mkEvent(opts: IEventOpts & { event?: boolean }, client?: MatrixClient): Partial<IEvent> | MatrixEvent {
    if (!opts.type || !opts.content) {
        throw new Error("Missing .type or .content =>" + JSON.stringify(opts));
    }
    const event: Partial<IEvent> = {
        type: opts.type as string,
        room_id: opts.room,
        sender: opts.sender || opts.user, // opts.user for backwards-compat
        content: opts.content,
        prev_content: opts.prev_content,
        unsigned: opts.unsigned || {},
        event_id: "$" + testEventIndex++ + "-" + Math.random() + "-" + Math.random(),
        txn_id: "~" + Math.random(),
        redacts: opts.redacts,
    };
    if (opts.skey !== undefined) {
        event.state_key = opts.skey;
    } else if ([
        EventType.RoomName,
        EventType.RoomTopic,
        EventType.RoomCreate,
        EventType.RoomJoinRules,
        EventType.RoomPowerLevels,
        EventType.RoomTopic,
        "com.example.state",
    ].includes(opts.type)) {
        event.state_key = "";
    }

    if (opts.event && client) {
        return eventMapperFor(client, {})(event);
    }

    return opts.event ? new MatrixEvent(event) : event;
}

type GeneratedMetadata = {
    event_id: string;
    txn_id: string;
    origin_server_ts: number;
};

export function mkEventCustom<T>(base: T): T & GeneratedMetadata {
    return {
        event_id: "$" + testEventIndex++ + "-" + Math.random() + "-" + Math.random(),
        txn_id: "~" + Math.random(),
        origin_server_ts: Date.now(),
        ...base,
    };
}

interface IPresenceOpts {
    user?: string;
    sender?: string;
    url?: string;
    name?: string;
    ago?: number;
    presence?: string;
    event?: boolean;
}

/**
 * Create an m.presence event.
 * @param {Object} opts Values for the presence.
 * @return {Object|MatrixEvent} The event
 */
export function mkPresence(opts: IPresenceOpts & { event: true }): MatrixEvent;
export function mkPresence(opts: IPresenceOpts & { event?: false }): Partial<IEvent>;
export function mkPresence(opts: IPresenceOpts & { event?: boolean }): Partial<IEvent> | MatrixEvent {
    const event = {
        event_id: "$" + Math.random() + "-" + Math.random(),
        type: "m.presence",
        sender: opts.sender || opts.user, // opts.user for backwards-compat
        content: {
            avatar_url: opts.url,
            displayname: opts.name,
            last_active_ago: opts.ago,
            presence: opts.presence || "offline",
        },
    };
    return opts.event ? new MatrixEvent(event) : event;
}

interface IMembershipOpts {
    room?: string;
    mship: string;
    sender?: string;
    user?: string;
    skey?: string;
    name?: string;
    url?: string;
    event?: boolean;
}

/**
 * Create an m.room.member event.
 * @param {Object} opts Values for the membership.
 * @param {string} opts.room The room ID for the event.
 * @param {string} opts.mship The content.membership for the event.
 * @param {string} opts.sender The sender user ID for the event.
 * @param {string} opts.skey The target user ID for the event if applicable
 * e.g. for invites/bans.
 * @param {string} opts.name The content.displayname for the event.
 * @param {string} opts.url The content.avatar_url for the event.
 * @param {boolean} opts.event True to make a MatrixEvent.
 * @return {Object|MatrixEvent} The event
 */
export function mkMembership(opts: IMembershipOpts & { event: true }): MatrixEvent;
export function mkMembership(opts: IMembershipOpts & { event?: false }): Partial<IEvent>;
export function mkMembership(opts: IMembershipOpts & { event?: boolean }): Partial<IEvent> | MatrixEvent {
    const eventOpts: IEventOpts = {
        ...opts,
        type: EventType.RoomMember,
        content: {
            membership: opts.mship,
        },
    };

    if (!opts.skey) {
        eventOpts.skey = opts.sender || opts.user;
    }
    if (opts.name) {
        eventOpts.content.displayname = opts.name;
    }
    if (opts.url) {
        eventOpts.content.avatar_url = opts.url;
    }
    return mkEvent(eventOpts);
}

export function mkMembershipCustom<T>(
    base: T & { membership: string, sender: string, content?: IContent },
): T & { type: EventType, sender: string, state_key: string, content: IContent } & GeneratedMetadata {
    const content = base.content || {};
    return mkEventCustom({
        ...base,
        content: { ...content, membership: base.membership },
        type: EventType.RoomMember,
        state_key: base.sender,
    });
}

interface IMessageOpts {
    room?: string;
    user: string;
    msg?: string;
    event?: boolean;
}

/**
 * Create an m.room.message event.
 * @param {Object} opts Values for the message
 * @param {string} opts.room The room ID for the event.
 * @param {string} opts.user The user ID for the event.
 * @param {string} opts.msg Optional. The content.body for the event.
 * @param {boolean} opts.event True to make a MatrixEvent.
 * @param {MatrixClient} client If passed along with opts.event=true will be used to set up re-emitters.
 * @return {Object|MatrixEvent} The event
 */
export function mkMessage(opts: IMessageOpts & { event: true }, client?: MatrixClient): MatrixEvent;
export function mkMessage(opts: IMessageOpts & { event?: false }, client?: MatrixClient): Partial<IEvent>;
export function mkMessage(
    opts: IMessageOpts & { event?: boolean },
    client?: MatrixClient,
): Partial<IEvent> | MatrixEvent {
    const eventOpts: IEventOpts = {
        ...opts,
        type: EventType.RoomMessage,
        content: {
            msgtype: MsgType.Text,
            body: opts.msg,
        },
    };

    if (!eventOpts.content.body) {
        eventOpts.content.body = "Random->" + Math.random();
    }
    return mkEvent(eventOpts, client);
}

interface IReplyMessageOpts extends IMessageOpts {
    replyToMessage: MatrixEvent;
}

/**
 * Create a reply message.
 *
 * @param {Object} opts Values for the message
 * @param {string} opts.room The room ID for the event.
 * @param {string} opts.user The user ID for the event.
 * @param {string} opts.msg Optional. The content.body for the event.
 * @param {MatrixEvent} opts.replyToMessage The replied message
 * @param {boolean} opts.event True to make a MatrixEvent.
 * @param {MatrixClient} client If passed along with opts.event=true will be used to set up re-emitters.
 * @return {Object|MatrixEvent} The event
 */
export function mkReplyMessage(opts: IReplyMessageOpts & { event: true }, client?: MatrixClient): MatrixEvent;
export function mkReplyMessage(opts: IReplyMessageOpts & { event?: false }, client?: MatrixClient): Partial<IEvent>;
export function mkReplyMessage(
    opts: IReplyMessageOpts & { event?: boolean },
    client?: MatrixClient,
): Partial<IEvent> | MatrixEvent {
    const eventOpts: IEventOpts = {
        ...opts,
        type: EventType.RoomMessage,
        content: {
            "msgtype": MsgType.Text,
            "body": opts.msg,
            "m.relates_to": {
                "rel_type": "m.in_reply_to",
                "event_id": opts.replyToMessage.getId(),
                "m.in_reply_to": {
                    "event_id": opts.replyToMessage.getId()!,
                },
            },
        },
    };

    if (!eventOpts.content.body) {
        eventOpts.content.body = "Random->" + Math.random();
    }
    return mkEvent(eventOpts, client);
}

/**
 * A mock implementation of webstorage
 *
 * @constructor
 */
export class MockStorageApi {
    private data: Record<string, any> = {};

    public get length() {
        return Object.keys(this.data).length;
    }

    public key(i: number): any {
        return Object.keys(this.data)[i];
    }

    public setItem(k: string, v: any): void {
        this.data[k] = v;
    }

    public getItem(k: string): any {
        return this.data[k] || null;
    }

    public removeItem(k: string): void {
        delete this.data[k];
    }
}

/**
 * If an event is being decrypted, wait for it to finish being decrypted.
 *
 * @param {MatrixEvent} event
 * @returns {Promise} promise which resolves (to `event`) when the event has been decrypted
 */
export async function awaitDecryption(event: MatrixEvent): Promise<MatrixEvent> {
    // An event is not always decrypted ahead of time
    // getClearContent is a good signal to know whether an event has been decrypted
    // already
    if (event.getClearContent() !== null) {
        return event;
    } else {
        logger.log(`${Date.now()} event ${event.getId()} is being decrypted; waiting`);

        return new Promise((resolve) => {
            event.once(MatrixEventEvent.Decrypted, (ev) => {
                logger.log(`${Date.now()} event ${event.getId()} now decrypted`);
                resolve(ev);
            });
        });
    }
}

export const emitPromise = (e: EventEmitter, k: string): Promise<any> => new Promise(r => e.once(k, r));

export const mkPusher = (extra: Partial<IPusher> = {}): IPusher => ({
    app_display_name: "app",
    app_id: "123",
    data: {},
    device_display_name: "name",
    kind: "http",
    lang: "en",
    pushkey: "pushpush",
    ...extra,
});
