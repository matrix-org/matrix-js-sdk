import { type EncryptionConfig } from "./MatrixRTCSession.ts";
import { type CallMembership } from "./CallMembership.ts";
import { type EncryptionKeyMapKey } from "./types.ts";

/**
 * The string used for the keys in the the encryption key map.
 * `@bob:examle.org:DEVICEID(UUIDRANDOM_MEMBERID_RANDOMUUID)`
 */
export function getEncryptionKeyMapKey(membership: CallMembershipIdentityParts): EncryptionKeyMapKey {
    return `${membership.userId}:${membership.deviceId}(${membership.memberId})`;
}

/**
 * This interface is for testing and for making it possible to interchange the encryption manager.
 * @internal
 */
export interface IEncryptionManager {
    /**
     * Joins the encryption manager with the provided configuration.
     *
     * @param joinConfig - The configuration for joining encryption, or undefined
     * if no specific configuration is provided.
     */
    join(joinConfig: EncryptionConfig | undefined): void;

    /**
     * Leaves the encryption manager, cleaning up any associated resources.
     */
    leave(): void;

    /**
     * Called from the MatrixRTCSession when the memberships in this session updated.
     *
     * @param oldMemberships - The previous state of call memberships before the update.
     */
    onMembershipsUpdate(oldMemberships: CallMembership[]): void;

    /**
     * Retrieves the encryption keys currently managed by the encryption manager.
     *
     * @returns A map of participant IDs to their encryption keys.
     */
    getEncryptionKeys(): ReadonlyMap<
        EncryptionKeyMapKey,
        ReadonlyArray<{
            key: Uint8Array<ArrayBuffer>;
            keyIndex: number;
            membership: CallMembershipIdentityParts;
            rtcBackendIdentity: string;
        }>
    >;
}

export type CallMembershipIdentityParts = Pick<CallMembership, "userId" | "deviceId" | "memberId">;
