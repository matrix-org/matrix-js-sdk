import { MatrixClient } from "./client";
import { MatrixEvent } from "./models/event";
import { IPushRule, IPushRules, PushRuleAction, TweakName } from "./@types/PushRules";
export interface IActionsObject {
    notify: boolean;
    tweaks: Partial<Record<TweakName, any>>;
}
export declare class PushProcessor {
    private readonly client;
    /**
     * Construct a Push Processor.
     * @constructor
     * @param {Object} client The Matrix client object to use
     */
    constructor(client: MatrixClient);
    /**
     * Convert a list of actions into a object with the actions as keys and their values
     * eg. [ 'notify', { set_tweak: 'sound', value: 'default' } ]
     *     becomes { notify: true, tweaks: { sound: 'default' } }
     * @param {array} actionList The actions list
     *
     * @return {object} A object with key 'notify' (true or false) and an object of actions
     */
    static actionListToActionsObject(actionList: PushRuleAction[]): IActionsObject;
    /**
     * Rewrites conditions on a client's push rules to match the defaults
     * where applicable. Useful for upgrading push rules to more strict
     * conditions when the server is falling behind on defaults.
     * @param {object} incomingRules The client's existing push rules
     * @returns {object} The rewritten rules
     */
    static rewriteDefaultRules(incomingRules: IPushRules): IPushRules;
    private static cachedGlobToRegex;
    private matchingRuleFromKindSet;
    private templateRuleToRaw;
    private eventFulfillsCondition;
    private eventFulfillsSenderNotifPermCondition;
    private eventFulfillsRoomMemberCountCondition;
    private eventFulfillsDisplayNameCondition;
    private eventFulfillsEventMatchCondition;
    private createCachedRegex;
    private valueForDottedKey;
    private matchingRuleForEventWithRulesets;
    private pushActionsForEventAndRulesets;
    ruleMatchesEvent(rule: IPushRule, ev: MatrixEvent): boolean;
    /**
     * Get the user's push actions for the given event
     *
     * @param {module:models/event.MatrixEvent} ev
     *
     * @return {PushAction}
     */
    actionsForEvent(ev: MatrixEvent): IActionsObject;
    /**
     * Get one of the users push rules by its ID
     *
     * @param {string} ruleId The ID of the rule to search for
     * @return {object} The push rule, or null if no such rule was found
     */
    getPushRuleById(ruleId: string): IPushRule;
}
/**
 * @typedef {Object} PushAction
 * @type {Object}
 * @property {boolean} notify Whether this event should notify the user or not.
 * @property {Object} tweaks How this event should be notified.
 * @property {boolean} tweaks.highlight Whether this event should be highlighted
 * on the UI.
 * @property {boolean} tweaks.sound Whether this notification should produce a
 * noise.
 */
//# sourceMappingURL=pushprocessor.d.ts.map