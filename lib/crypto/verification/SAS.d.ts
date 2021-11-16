/**
 * Short Authentication String (SAS) verification.
 * @module crypto/verification/SAS
 */
import { VerificationBase as Base } from "./Base";
import { MatrixEvent } from "../../models/event";
declare type EmojiMapping = [emoji: string, name: string];
export interface IGeneratedSas {
    decimal?: [number, number, number];
    emoji?: EmojiMapping[];
}
export interface ISasEvent {
    sas: IGeneratedSas;
    confirm(): Promise<void>;
    cancel(): void;
    mismatch(): void;
}
/**
 * @alias module:crypto/verification/SAS
 * @extends {module:crypto/verification/Base}
 */
export declare class SAS extends Base {
    private waitingForAccept;
    ourSASPubKey: string;
    theirSASPubKey: string;
    sasEvent: ISasEvent;
    static get NAME(): string;
    get events(): string[];
    protected doVerification: () => Promise<void>;
    canSwitchStartEvent(event: MatrixEvent): boolean;
    private sendStart;
    private doSendVerification;
    private doRespondVerification;
    private sendMAC;
    private checkMAC;
}
export {};
//# sourceMappingURL=SAS.d.ts.map