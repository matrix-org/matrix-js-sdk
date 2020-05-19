/*
 * Utils for generating fake data
 *
 * Not very complete. For now I'm injecting rooms into a live client like this:
 * mxMatrixClientPeg.get()._syncApi._processSyncResponse({}, {
 *   rooms: { join: Faking.randomly(Faking.Rooms(100)) }
 * })
 */

/*
 * Irritatingly, Javascript does not provide a seedable RNG.  A seedable RNG is very
 * helpful when you want reproduceable results.
 */
interface Xorshift128pState {
    a: bigint,
    b: bigint,
}
const MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
export function xorshift128p(s: Xorshift128pState): { state: Xorshift128pState, value: number } {
    let t: bigint = s.a;
    t ^= (t << BigInt(23)) & MAX;
    t ^= (t >> BigInt(17));
    t ^= s.b ^ (s.b >> BigInt(26));
    const state = { a: s.b, b: t };
    const value = Number((t + s.a) & MAX) / Number(MAX);
    return { state, value };
}

/*
 * Now obviously, I'm a monster for introducing monads to this.
 * Here's a state monad. I'll explain why later.
 */
class State<T, V> {
    runState: (s) => { state: T, value: V }

    constructor(runState) {
        this.runState = runState;
    }

    static pure<T, V2>(value: V2): State<T, V2> {
        return new State((state: T) => ({ state, value }));
    }

    static get<T>(): State<T, T> {
        return new State((state: T) => ({ state, value: state }));
    }

    static put<T>(s: T): State<T, undefined> {
        return new State((state: T) => ({ state: s, value: undefined }));
    }

    static sequence<T, V>(a: State<T, V>[]): State<T, V[]> {
        return a.reduce((acc, s) => acc.flatMap((vs) => s.map((v) => [...vs, v])),
        State.pure([]));
    }

    static obj<T, V>(o: Record<string, State<T, any>>): State<T, Record<string, any>> {
        return State.sequence(Object.entries(o).map(([k, s]) => s.map((v) => [k, v])))
                    .map((Object as unknown as any).fromEntries);
    }

    map<V2>(f: (v: V) => V2): State<T, V2> {
        return new State((s: T) => {
            let { state, value } = this.runState(s);
            return { state, value: f(value) };
        });
    }

    flatMap<V2>(f: (v: V) => State<T, V2>): State<T, V2> {
        return new State((s: T) => {
            let { state, value } = this.runState(s);
            return f(value).runState(state);
        });
    }
}

/*
 * Using the state monad here allows us to write random object generators.
 * We can build them up combinatorially while threading the state of
 * the RNG through stuff.
 */
const Random = new State<Xorshift128pState, number>((s: Xorshift128pState) => xorshift128p(s));
const RandInt = (n: number) => Random.map((v) => Math.floor(v * n));
const Choose = <T>(a: T[]) => RandInt(a.length).map(v => a[v]);
const alphabet: string[] = "abcdefghijklmnopqrstuvwxyz".split("");
const RandStr = (l: number) => State.sequence<Xorshift128pState, string>((new Array(l || 1)).fill(Choose(alphabet)))
                                    .map((v) => v.join(""));

const RoomId = RandStr(20).map((v) => `!${v}:localhost`);
const UserId = RandStr(20).map((v) => `@${v}:localhost`);
const EventId = RandStr(40).map((v) => "$" + v);
const MessageEvent = ({roomId, users}: {roomId: string, users?: string[]}) => State.obj({
    type: State.pure("m.room.message"),
    sender: users ? Choose(users) : UserId,
    content: State.obj({
        msgtype: State.pure("m.text"),
        body: RandInt(39).map((v) => v + 1).flatMap(RandStr),
    }),
    event_id: EventId,
    room_id: State.pure(roomId),
});
const Timeline = (l: number, params: {roomId: string, users?: string[]}): State<Xorshift128pState, any[]> =>
  State.sequence<Xorshift128pState, any>((new Array(l === undefined ? 1 : l)).fill(MessageEvent(params)));

function Event(existing: any) {
    return (params: { sender: string, roomId: string }) => {
        return EventId.map(eventId => ({
            event_id: eventId,
            room_id: params.roomId,
            sender: params.sender,
            ...existing
        }));
    }
};

const PowerLevels = ({sender, roomId}: {sender: string, roomId: string}) => EventId.map((eventId) =>
  ({
    "type": "m.room.power_levels",
    "sender": sender,
    "content": {
        "users": { [sender]: 100 },
        "users_default": 0,
        "events": {
            "m.room.name": 50,
            "m.room.power_levels": 100,
            "m.room.history_visibility": 100,
            "m.room.canonical_alias": 50,
            "m.room.avatar": 50,
            "m.room.tombstone": 100,
            "m.room.server_acl": 100,
            "m.room.encryption": 100
        },
        "events_default": 0,
        "state_default": 50,
        "ban": 50,
        "kick": 50,
        "redact": 50,
        "invite": 0
    },
    "state_key": "",
    "event_id": eventId,
    room_id: roomId,
  }));

const NameStateEvent = ({sender, roomId}: {sender: string, roomId: string}) => State.obj({
    eventId: EventId,
    name: RandStr(10),
}).map(({eventId, name}) => ({
    type: "m.room.name",
    sender: sender,
    content: { name },
    state_key: "",
    event_id: eventId,
    room_id: roomId
  }));

const CreateEvent = ({sender, roomId}) => EventId.map(eventId => ({
    content: {
        creator: sender,
        "m.federate": true,
        "room_version": 5,
    },
    event_id: eventId,
    room_id: roomId,
    state_key: "",
    type: "m.room.create",
}));

const JoinEvent = ({sender, roomId}) => EventId.map(eventId => ({
    type: "m.room.member",
    content: {
        membership: "join",
    },
    sender: sender,
    state_key: sender,
    room_id: roomId,
    event_id: eventId
}));

const EncryptionEvent = ({sender, roomId}) => EventId.map(eventId => ({
    content: {
        "algorithm": "m.megolm.v1.aes-sha2",
        "rotation_period_ms": 604800000,
        "rotation_period_msgs": 100
    },
    sender,
    room_id: roomId,
    event_id: eventId,
    state_key: "",
    type: "m.room.encryption",
}));

const JoinUsers = ({ users, roomId }): State<Xorshift128pState, any> => State.sequence(users.map((user) => JoinEvent({sender: user, roomId})));

const JoinRules = Event({
    type: "m.room.join_rules",
    content: {
        join_rule: "public"
    },
    state_key: "",
});

const Room = State.obj({
    roomId: RoomId,
    users: RandInt(100).flatMap((v) => State.sequence((new Array(v + 1)).fill(UserId))),
    count: RandInt(100),
}).flatMap(({roomId, users, count}) => State.obj({
  [roomId]: State.obj({
      timeline: State.sequence<Xorshift128pState, any>([
        CreateEvent({ sender: users[0], roomId }),
        PowerLevels({ sender: users[0], roomId }),
        JoinRules({ sender: users[0], roomId }),
        NameStateEvent({ sender: users[0], roomId: roomId }),
        JoinUsers({ roomId, users }),
        EncryptionEvent({ roomId, sender: users[0] }),
        Timeline(count, { roomId, users }),
      ]).map(([create, power, rules, name, joinusers, enc, timeline]) => ({
          events: [create, power, rules, name, ...joinusers, enc, ...timeline]
      })),
  }),
}));

const Rooms = (n: number) => State.sequence((new Array(n)).fill(Room)).map((rs) =>
  Object.assign({}, ...rs));

// This is just {a: 1n, b: 1n} iterated 20 times
const Seed = State.put({a: BigInt(1), b: BigInt(1)})
             .flatMap(() => State.sequence((new Array(20)).fill(Random)))
             .map(() => undefined);

function randomly<T, V>(s: State<undefined, V>) {
    return Seed.flatMap(() => s).runState(undefined).value;
}

(window as unknown as any).Faking = {
    xorshift128p,
    State,
    Random,
    RandInt,
    Choose,
    RandStr,
    RoomId,
    MessageEvent,
    Seed,
    Timeline,
    PowerLevels,
    NameStateEvent,
    Room,
    Rooms,
    JoinUsers,
    randomly,
};
