/*
Copyright 2015 - 2021 The Matrix.org Foundation C.I.C.

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

import { deepCompare, escapeRegExp, globToRegexp, isNullOrUndefined } from "./utils.ts";
import { type Logger } from "./logger.ts";
import { type MatrixClient } from "./client.ts";
import { type MatrixEvent } from "./models/event.ts";
import {
    ConditionKind,
    type IAnnotatedPushRule,
    type ICallStartedCondition,
    type ICallStartedPrefixCondition,
    type IContainsDisplayNameCondition,
    type IEventMatchCondition,
    type IEventPropertyContainsCondition,
    type IEventPropertyIsCondition,
    type IPushRule,
    type IPushRules,
    type IRoomMemberCountCondition,
    type ISenderNotificationPermissionCondition,
    type PushRuleAction,
    PushRuleActionName,
    type PushRuleCondition,
    PushRuleKind,
    type PushRuleSet,
    RuleId,
    TweakName,
} from "./@types/PushRules.ts";
import { EventType } from "./@types/event.ts";

const RULEKINDS_IN_ORDER = [
    PushRuleKind.Override,
    PushRuleKind.ContentSpecific,
    PushRuleKind.RoomSpecific,
    PushRuleKind.SenderSpecific,
    PushRuleKind.Underride,
];

// The default override rules to apply to the push rules that arrive from the server.
// We do this for two reasons:
//   1. Synapse is unlikely to send us the push rule in an incremental sync - see
//      https://github.com/matrix-org/synapse/pull/4867#issuecomment-481446072 for
//      more details.
//   2. We often want to start using push rules ahead of the server supporting them,
//      and so we can put them here.
const DEFAULT_OVERRIDE_RULES: Record<string, IPushRule> = {
    ".m.rule.is_room_mention": {
        // Matrix v1.7
        rule_id: ".m.rule.is_room_mention",
        default: true,
        enabled: true,
        conditions: [
            {
                kind: ConditionKind.EventPropertyIs,
                key: "content.m\\.mentions.room",
                value: true,
            },
            {
                kind: ConditionKind.SenderNotificationPermission,
                key: "room",
            },
        ],
        actions: [
            PushRuleActionName.Notify,
            {
                set_tweak: TweakName.Highlight,
            },
        ],
    },
    ".m.rule.reaction": {
        // For homeservers which don't support MSC2153 yet
        rule_id: ".m.rule.reaction",
        default: true,
        enabled: true,
        conditions: [
            {
                kind: ConditionKind.EventMatch,
                key: "type",
                pattern: "m.reaction",
            },
        ],
        actions: [PushRuleActionName.DontNotify],
    },
    ".org.matrix.msc3786.rule.room.server_acl": {
        // For homeservers which don't support MSC3786 yet
        rule_id: ".org.matrix.msc3786.rule.room.server_acl",
        default: true,
        enabled: true,
        conditions: [
            {
                kind: ConditionKind.EventMatch,
                key: "type",
                pattern: EventType.RoomServerAcl,
            },
            {
                kind: ConditionKind.EventMatch,
                key: "state_key",
                pattern: "",
            },
        ],
        actions: [],
    },
};

// A special rule id for `EXPECTED_DEFAULT_OVERRIDE_RULE_IDS` and friends which denotes where user-defined rules live in the order.
const UserDefinedRules = Symbol("UserDefinedRules");

type OrderedRules = Array<string | typeof UserDefinedRules>;

const EXPECTED_DEFAULT_OVERRIDE_RULE_IDS: OrderedRules = [
    RuleId.Master,
    UserDefinedRules,
    RuleId.SuppressNotices,
    RuleId.InviteToSelf,
    RuleId.MemberEvent,
    RuleId.IsUserMention,
    RuleId.ContainsDisplayName,
    RuleId.IsRoomMention,
    RuleId.AtRoomNotification,
    RuleId.Tombstone,
    ".m.rule.reaction",
    ".m.rule.room.server_acl",
    ".org.matrix.msc3786.rule.room.server_acl",
    ".m.rule.suppress_edits",
];

const DEFAULT_UNDERRIDE_RULES: Record<string, IPushRule> = {
    ".org.matrix.msc3914.rule.room.call": {
        // For homeservers which don't support MSC3914 yet
        rule_id: ".org.matrix.msc3914.rule.room.call",
        default: true,
        enabled: true,
        conditions: [
            {
                kind: ConditionKind.EventMatch,
                key: "type",
                pattern: "org.matrix.msc3401.call",
            },
            {
                kind: ConditionKind.CallStarted,
            },
        ],
        actions: [PushRuleActionName.Notify, { set_tweak: TweakName.Sound, value: "default" }],
    },
};

const EXPECTED_DEFAULT_UNDERRIDE_RULE_IDS: OrderedRules = [
    UserDefinedRules,
    RuleId.IncomingCall,
    ".org.matrix.msc3914.rule.room.call",
    RuleId.EncryptedDM,
    RuleId.DM,
    RuleId.Message,
    RuleId.EncryptedMessage,
];

/**
 * Make sure that each of the rules listed in `defaultRuleIds` is listed in the given set of push rules.
 *
 * @param logger - A `Logger` to write log messages to.
 * @param kind - the kind of push rule set being merged.
 * @param incomingRules - the existing set of known push rules for the user.
 * @param defaultRules - a lookup table for the default definitions of push rules.
 * @param orderedRuleIds - the IDs of the expected push rules, in order.
 *
 * @returns A copy of `incomingRules`, with any missing default rules inserted in the right place.
 */
function mergeRulesWithDefaults(
    logger: Logger,
    kind: PushRuleKind,
    incomingRules: IPushRule[],
    defaultRules: Record<string, IPushRule>,
    orderedRuleIds: OrderedRules,
): IPushRule[] {
    // Split the incomingRules into defaults and custom
    const incomingDefaultRules = incomingRules.filter((rule) => rule.default);
    const incomingCustomRules = incomingRules.filter((rule) => !rule.default);

    function insertDefaultPushRule(ruleId: OrderedRules[number]): void {
        if (ruleId === UserDefinedRules) {
            // Re-insert any user-defined rules that were in `incomingRules`
            newRules.push(...incomingCustomRules);
        } else if (ruleId in defaultRules) {
            logger.warn(`Adding default global ${kind} push rule ${ruleId}`);
            newRules.push(defaultRules[ruleId]);
        } else {
            logger.warn(`Missing default global ${kind} push rule ${ruleId}`);
        }
    }

    let nextExpectedRuleIdIndex = 0;
    const newRules: IPushRule[] = [];
    // Merge our expected rules (including the incoming custom rules) into the incoming default rules.
    for (const rule of incomingDefaultRules) {
        const ruleIndex = orderedRuleIds.indexOf(rule.rule_id);
        if (ruleIndex === -1) {
            // an unrecognised rule; copy it over
            newRules.push(rule);
            continue;
        }
        while (ruleIndex > nextExpectedRuleIdIndex) {
            // insert new rules
            const defaultRuleId = orderedRuleIds[nextExpectedRuleIdIndex];
            insertDefaultPushRule(defaultRuleId);
            nextExpectedRuleIdIndex += 1;
        }
        // copy over the existing rule
        newRules.push(rule);
        nextExpectedRuleIdIndex += 1;
    }

    // Now copy over any remaining default rules
    for (const ruleId of orderedRuleIds.slice(nextExpectedRuleIdIndex)) {
        insertDefaultPushRule(ruleId);
    }

    return newRules;
}

export interface IActionsObject {
    /** Whether this event should notify the user or not. */
    notify: boolean;
    /** How this event should be notified. */
    tweaks: Partial<Record<TweakName, any>>;
}

export class PushProcessor {
    /**
     * Construct a Push Processor.
     * @param client - The Matrix client object to use
     */
    public constructor(private readonly client: MatrixClient) {}

    /**
     * Maps the original key from the push rules to a list of property names
     * after unescaping.
     */
    private readonly parsedKeys = new Map<string, string[]>();

    /**
     * Convert a list of actions into a object with the actions as keys and their values
     * @example
     * eg. `[ 'notify', { set_tweak: 'sound', value: 'default' } ]`
     *     becomes `{ notify: true, tweaks: { sound: 'default' } }`
     * @param actionList - The actions list
     *
     * @returns A object with key 'notify' (true or false) and an object of actions
     */
    public static actionListToActionsObject(actionList: PushRuleAction[]): IActionsObject {
        const actionObj: IActionsObject = { notify: false, tweaks: {} };
        for (const action of actionList) {
            if (action === PushRuleActionName.Notify) {
                actionObj.notify = true;
            } else if (typeof action === "object") {
                if (action.value === undefined) {
                    action.value = true;
                }
                actionObj.tweaks[action.set_tweak] = action.value;
            }
        }
        return actionObj;
    }

    /**
     * Rewrites conditions on a client's push rules to match the defaults
     * where applicable. Useful for upgrading push rules to more strict
     * conditions when the server is falling behind on defaults.
     *
     * @param logger - A `Logger` to write log messages to.
     * @param incomingRules - The client's existing push rules
     * @param userId - The Matrix ID of the client.
     * @returns The rewritten rules
     */
    public static rewriteDefaultRules(
        logger: Logger,
        incomingRules: IPushRules,
        userId: string | undefined = undefined,
    ): IPushRules {
        let newRules: IPushRules = JSON.parse(JSON.stringify(incomingRules)); // deep clone

        // These lines are mostly to make the tests happy. We shouldn't run into these
        // properties missing in practice.
        if (!newRules) newRules = {} as IPushRules;
        if (!newRules.global) newRules.global = {} as PushRuleSet;
        if (!newRules.global.override) newRules.global.override = [];
        if (!newRules.global.underride) newRules.global.underride = [];

        // Merge the client-level defaults with the ones from the server
        newRules.global.override = mergeRulesWithDefaults(
            logger,
            PushRuleKind.Override,
            newRules.global.override,
            DEFAULT_OVERRIDE_RULES,
            EXPECTED_DEFAULT_OVERRIDE_RULE_IDS,
        );

        newRules.global.underride = mergeRulesWithDefaults(
            logger,
            PushRuleKind.Underride,
            newRules.global.underride,
            DEFAULT_UNDERRIDE_RULES,
            EXPECTED_DEFAULT_UNDERRIDE_RULE_IDS,
        );

        return newRules;
    }

    /**
     * Create a RegExp object for the given glob pattern with a single capture group around the pattern itself, caching the result.
     * No cache invalidation is present currently,
     * as this will be inherently bounded to the size of the user's own push rules.
     * @param pattern - the glob pattern to convert to a RegExp
     * @param alignToWordBoundary - whether to align the pattern to word boundaries,
     *     as specified for `content.body` matches, will use lookaround assertions to ensure the match only includes the pattern
     * @param flags - the flags to pass to the RegExp constructor, defaults to case-insensitive
     */
    public static getPushRuleGlobRegex(pattern: string, alignToWordBoundary = false, flags = "i"): RegExp {
        const [prefix, suffix] = alignToWordBoundary ? ["(?<=^|\\W)", "(?=\\W|$)"] : ["^", "$"];
        const cacheKey = `${alignToWordBoundary}-${flags}-${pattern}`;

        if (!PushProcessor.cachedGlobToRegex[cacheKey]) {
            PushProcessor.cachedGlobToRegex[cacheKey] = new RegExp(
                prefix + "(" + globToRegexp(pattern) + ")" + suffix,
                flags,
            );
        }
        return PushProcessor.cachedGlobToRegex[cacheKey];
    }

    /**
     * Pre-caches the parsed keys for push rules and cleans out any obsolete cache
     * entries. Should be called after push rules are updated.
     * @param newRules - The new push rules.
     */
    public updateCachedPushRuleKeys(newRules: IPushRules): void {
        // These lines are mostly to make the tests happy. We shouldn't run into these
        // properties missing in practice.
        if (!newRules) newRules = {} as IPushRules;
        if (!newRules.global) newRules.global = {} as PushRuleSet;
        if (!newRules.global.override) newRules.global.override = [];
        if (!newRules.global.room) newRules.global.room = [];
        if (!newRules.global.sender) newRules.global.sender = [];
        if (!newRules.global.underride) newRules.global.underride = [];

        // Process the 'key' property on event_match conditions pre-cache the
        // values and clean-out any unused values.
        const toRemoveKeys = new Set(this.parsedKeys.keys());
        for (const ruleset of [
            newRules.global.override,
            newRules.global.room,
            newRules.global.sender,
            newRules.global.underride,
        ]) {
            for (const rule of ruleset) {
                if (!rule.conditions) {
                    continue;
                }

                for (const condition of rule.conditions) {
                    if (condition.kind !== ConditionKind.EventMatch) {
                        continue;
                    }

                    // Ensure we keep this key.
                    toRemoveKeys.delete(condition.key);

                    // Pre-process the key.
                    this.parsedKeys.set(condition.key, PushProcessor.partsForDottedKey(condition.key));
                }
            }
        }
        // Any keys that were previously cached, but are no longer needed should
        // be removed.
        toRemoveKeys.forEach((k) => this.parsedKeys.delete(k));
    }

    private static cachedGlobToRegex: Record<string, RegExp> = {}; // $glob: RegExp

    private matchingRuleFromKindSet(ev: MatrixEvent, kindset: PushRuleSet): IAnnotatedPushRule | null {
        for (const kind of RULEKINDS_IN_ORDER) {
            const ruleset = kindset[kind];
            if (!ruleset) {
                continue;
            }

            for (const rule of ruleset) {
                if (!rule.enabled) {
                    continue;
                }

                const rawrule = this.templateRuleToRaw(kind, rule);
                if (!rawrule) {
                    continue;
                }

                if (this.ruleMatchesEvent(rawrule, ev)) {
                    return {
                        ...rule,
                        kind,
                    };
                }
            }
        }
        return null;
    }

    private templateRuleToRaw(
        kind: PushRuleKind,
        tprule: IPushRule,
    ): Pick<IPushRule, "rule_id" | "actions" | "conditions"> | null {
        const rawrule: Pick<IPushRule, "rule_id" | "actions" | "conditions"> = {
            rule_id: tprule.rule_id,
            actions: tprule.actions,
            conditions: [],
        };
        switch (kind) {
            case PushRuleKind.Underride:
            case PushRuleKind.Override:
                rawrule.conditions = tprule.conditions;
                break;
            case PushRuleKind.RoomSpecific:
                if (!tprule.rule_id) {
                    return null;
                }
                rawrule.conditions!.push({
                    kind: ConditionKind.EventMatch,
                    key: "room_id",
                    value: tprule.rule_id,
                });
                break;
            case PushRuleKind.SenderSpecific:
                if (!tprule.rule_id) {
                    return null;
                }
                rawrule.conditions!.push({
                    kind: ConditionKind.EventMatch,
                    key: "user_id",
                    value: tprule.rule_id,
                });
                break;
            case PushRuleKind.ContentSpecific:
                if (!tprule.pattern) {
                    return null;
                }
                rawrule.conditions!.push({
                    kind: ConditionKind.EventMatch,
                    key: "content.body",
                    pattern: tprule.pattern,
                });
                break;
        }
        return rawrule;
    }

    private eventFulfillsCondition(cond: PushRuleCondition, ev: MatrixEvent): boolean {
        switch (cond.kind) {
            case ConditionKind.EventMatch:
                return this.eventFulfillsEventMatchCondition(cond, ev);
            case ConditionKind.EventPropertyIs:
                return this.eventFulfillsEventPropertyIsCondition(cond, ev);
            case ConditionKind.EventPropertyContains:
                return this.eventFulfillsEventPropertyContains(cond, ev);
            case ConditionKind.ContainsDisplayName:
                return this.eventFulfillsDisplayNameCondition(cond, ev);
            case ConditionKind.RoomMemberCount:
                return this.eventFulfillsRoomMemberCountCondition(cond, ev);
            case ConditionKind.SenderNotificationPermission:
                return this.eventFulfillsSenderNotifPermCondition(cond, ev);
            case ConditionKind.CallStarted:
            case ConditionKind.CallStartedPrefix:
                return this.eventFulfillsCallStartedCondition(cond, ev);
        }

        // unknown conditions: we previously matched all unknown conditions,
        // but given that rules can be added to the base rules on a server,
        // it's probably better to not match unknown conditions.
        return false;
    }

    private eventFulfillsSenderNotifPermCondition(
        cond: ISenderNotificationPermissionCondition,
        ev: MatrixEvent,
    ): boolean {
        const notifLevelKey = cond["key"];
        if (!notifLevelKey) {
            return false;
        }

        const room = this.client.getRoom(ev.getRoomId());
        if (!room?.currentState) {
            return false;
        }

        // Note that this should not be the current state of the room but the state at
        // the point the event is in the DAG. Unfortunately the js-sdk does not store
        // this.
        return room.currentState.mayTriggerNotifOfType(notifLevelKey, ev.getSender()!);
    }

    private eventFulfillsRoomMemberCountCondition(cond: IRoomMemberCountCondition, ev: MatrixEvent): boolean {
        if (!cond.is) {
            return false;
        }

        const room = this.client.getRoom(ev.getRoomId());
        if (!room || !room.currentState || !room.currentState.members) {
            return false;
        }

        const memberCount = room.currentState.getJoinedMemberCount();

        const m = cond.is.match(/^([=<>]*)(\d*)$/);
        if (!m) {
            return false;
        }
        const ineq = m[1];
        const rhs = parseInt(m[2]);
        if (isNaN(rhs)) {
            return false;
        }
        switch (ineq) {
            case "":
            case "==":
                return memberCount == rhs;
            case "<":
                return memberCount < rhs;
            case ">":
                return memberCount > rhs;
            case "<=":
                return memberCount <= rhs;
            case ">=":
                return memberCount >= rhs;
            default:
                return false;
        }
    }

    private eventFulfillsDisplayNameCondition(cond: IContainsDisplayNameCondition, ev: MatrixEvent): boolean {
        let content = ev.getContent();
        if (ev.isEncrypted() && ev.getClearContent()) {
            content = ev.getClearContent()!;
        }
        if (!content || !content.body || typeof content.body != "string") {
            return false;
        }

        const room = this.client.getRoom(ev.getRoomId());
        const member = room?.currentState?.getMember(this.client.credentials.userId!);
        if (!member) {
            return false;
        }

        const displayName = member.name;

        // N.B. we can't use \b as it chokes on unicode. however \W seems to be okay
        // as shorthand for [^0-9A-Za-z_].
        const pat = new RegExp("(^|\\W)" + escapeRegExp(displayName) + "(\\W|$)", "i");
        return content.body.search(pat) > -1;
    }

    /**
     * Check whether the given event matches the push rule condition by fetching
     * the property from the event and comparing against the condition's glob-based
     * pattern.
     * @param cond - The push rule condition to check for a match.
     * @param ev - The event to check for a match.
     */
    private eventFulfillsEventMatchCondition(cond: IEventMatchCondition, ev: MatrixEvent): boolean {
        if (!cond.key) {
            return false;
        }

        const val = this.valueForDottedKey(cond.key, ev);
        if (typeof val !== "string") {
            return false;
        }

        // XXX This does not match in a case-insensitive manner.
        //
        // See https://spec.matrix.org/v1.5/client-server-api/#conditions-1
        if (cond.value) {
            return cond.value === val;
        }

        if (typeof cond.pattern !== "string") {
            return false;
        }

        // Align to word boundary on `content.body` matches, whole string otherwise
        // https://spec.matrix.org/v1.13/client-server-api/#conditions-1
        const regex = PushProcessor.getPushRuleGlobRegex(cond.pattern, cond.key === "content.body");
        return !!val.match(regex);
    }

    /**
     * Check whether the given event matches the push rule condition by fetching
     * the property from the event and comparing exactly against the condition's
     * value.
     * @param cond - The push rule condition to check for a match.
     * @param ev - The event to check for a match.
     */
    private eventFulfillsEventPropertyIsCondition(cond: IEventPropertyIsCondition, ev: MatrixEvent): boolean {
        if (!cond.key || cond.value === undefined) {
            return false;
        }
        return cond.value === this.valueForDottedKey(cond.key, ev);
    }

    /**
     * Check whether the given event matches the push rule condition by fetching
     * the property from the event and comparing exactly against the condition's
     * value.
     * @param cond - The push rule condition to check for a match.
     * @param ev - The event to check for a match.
     */
    private eventFulfillsEventPropertyContains(cond: IEventPropertyContainsCondition, ev: MatrixEvent): boolean {
        if (!cond.key || cond.value === undefined) {
            return false;
        }
        const val = this.valueForDottedKey(cond.key, ev);
        if (!Array.isArray(val)) {
            return false;
        }
        return val.includes(cond.value);
    }

    private eventFulfillsCallStartedCondition(
        _cond: ICallStartedCondition | ICallStartedPrefixCondition,
        ev: MatrixEvent,
    ): boolean {
        // Since servers don't support properly sending push notification
        // about MSC3401 call events, we do the handling ourselves
        return (
            ["m.ring", "m.prompt"].includes(ev.getContent()["m.intent"]) &&
            !("m.terminated" in ev.getContent()) &&
            (ev.getPrevContent()["m.terminated"] !== ev.getContent()["m.terminated"] ||
                deepCompare(ev.getPrevContent(), {}))
        );
    }

    /**
     * Parse the key into the separate fields to search by splitting on
     * unescaped ".", and then removing any escape characters.
     *
     * @param str - The key of the push rule condition: a dotted field.
     * @returns The unescaped parts to fetch.
     * @internal
     */
    public static partsForDottedKey(str: string): string[] {
        const result: string[] = [];

        // The current field and whether the previous character was the escape
        // character (a backslash).
        let part = "";
        let escaped = false;

        // Iterate over each character, and decide whether to append to the current
        // part (following the escape rules) or to start a new part (based on the
        // field separator).
        for (const c of str) {
            // If the previous character was the escape character (a backslash)
            // then decide what to append to the current part.
            if (escaped) {
                if (c === "\\" || c === ".") {
                    // An escaped backslash or dot just gets added.
                    part += c;
                } else {
                    // A character that shouldn't be escaped gets the backslash prepended.
                    part += "\\" + c;
                }
                // This always resets being escaped.
                escaped = false;
                continue;
            }

            if (c == ".") {
                // The field separator creates a new part.
                result.push(part);
                part = "";
            } else if (c == "\\") {
                // A backslash adds no characters, but starts an escape sequence.
                escaped = true;
            } else {
                // Otherwise, just add the current character.
                part += c;
            }
        }

        // Ensure the final part is included. If there's an open escape sequence
        // it should be included.
        if (escaped) {
            part += "\\";
        }
        result.push(part);

        return result;
    }

    /**
     * For a dotted field and event, fetch the value at that position, if one
     * exists.
     *
     * @param key - The key of the push rule condition: a dotted field to fetch.
     * @param ev - The matrix event to fetch the field from.
     * @returns The value at the dotted path given by key.
     */
    private valueForDottedKey(key: string, ev: MatrixEvent): any {
        // The key should already have been parsed via updateCachedPushRuleKeys,
        // but if it hasn't (maybe via an old consumer of the SDK which hasn't
        // been updated?) then lazily calculate it here.
        let parts = this.parsedKeys.get(key);
        if (parts === undefined) {
            parts = PushProcessor.partsForDottedKey(key);
            this.parsedKeys.set(key, parts);
        }
        let val: any;

        // special-case the first component to deal with encrypted messages
        const firstPart = parts[0];
        let currentIndex = 0;
        if (firstPart === "content") {
            val = ev.getContent();
            ++currentIndex;
        } else if (firstPart === "type") {
            val = ev.getType();
            ++currentIndex;
        } else {
            // use the raw event for any other fields
            val = ev.event;
        }

        for (; currentIndex < parts.length; ++currentIndex) {
            // The previous iteration resulted in null or undefined, bail (and
            // avoid the type error of attempting to retrieve a property).
            if (isNullOrUndefined(val)) {
                return undefined;
            }

            const thisPart = parts[currentIndex];
            val = val[thisPart];
        }
        return val;
    }

    private matchingRuleForEventWithRulesets(ev: MatrixEvent, rulesets?: IPushRules): IAnnotatedPushRule | null {
        if (!rulesets) {
            return null;
        }

        if (ev.getSender() === this.client.getSafeUserId()) {
            return null;
        }

        return this.matchingRuleFromKindSet(ev, rulesets.global);
    }

    private pushActionsForEventAndRulesets(
        ev: MatrixEvent,
        rulesets?: IPushRules,
    ): {
        actions?: IActionsObject;
        rule?: IAnnotatedPushRule;
    } {
        const rule = this.matchingRuleForEventWithRulesets(ev, rulesets);
        if (!rule) {
            return {};
        }

        const actionObj = PushProcessor.actionListToActionsObject(rule.actions);

        // Some actions are implicit in some situations: we add those here
        if (actionObj.tweaks.highlight === undefined) {
            // if it isn't specified, highlight if it's a content
            // rule but otherwise not
            actionObj.tweaks.highlight = rule.kind == PushRuleKind.ContentSpecific;
        }

        return { actions: actionObj, rule };
    }

    public ruleMatchesEvent(rule: Partial<IPushRule> & Pick<IPushRule, "conditions">, ev: MatrixEvent): boolean {
        // Disable the deprecated mentions push rules if the new mentions property exists.
        if (
            this.client.supportsIntentionalMentions() &&
            ev.getContent()["m.mentions"] !== undefined &&
            (rule.rule_id === RuleId.ContainsUserName ||
                rule.rule_id === RuleId.ContainsDisplayName ||
                rule.rule_id === RuleId.AtRoomNotification)
        ) {
            return false;
        }

        return !rule.conditions?.some((cond) => !this.eventFulfillsCondition(cond, ev));
    }

    /**
     * Get the user's push actions for the given event
     */
    public actionsForEvent(ev: MatrixEvent): IActionsObject {
        const { actions } = this.pushActionsForEventAndRulesets(ev, this.client.pushRules);
        return actions || ({} as IActionsObject);
    }

    public actionsAndRuleForEvent(ev: MatrixEvent): {
        actions?: IActionsObject;
        rule?: IAnnotatedPushRule;
    } {
        return this.pushActionsForEventAndRulesets(ev, this.client.pushRules);
    }

    /**
     * Get one of the users push rules by its ID
     *
     * @param ruleId - The ID of the rule to search for
     * @returns The push rule, or null if no such rule was found
     */
    public getPushRuleById(ruleId: string): IPushRule | null {
        const result = this.getPushRuleAndKindById(ruleId);
        return result?.rule ?? null;
    }

    /**
     * Get one of the users push rules by its ID
     *
     * @param ruleId - The ID of the rule to search for
     * @returns rule The push rule, or null if no such rule was found
     * @returns kind - The PushRuleKind of the rule to search for
     */
    public getPushRuleAndKindById(ruleId: string): { rule: IPushRule; kind: PushRuleKind } | null {
        for (const scope of ["global"] as const) {
            if (this.client.pushRules?.[scope] === undefined) continue;

            for (const kind of RULEKINDS_IN_ORDER) {
                if (this.client.pushRules[scope][kind] === undefined) continue;

                for (const rule of this.client.pushRules[scope][kind]!) {
                    if (rule.rule_id === ruleId) return { rule, kind };
                }
            }
        }
        return null;
    }
}
