/// <reference types="node" />
/**
 * QR code key verification.
 * @module crypto/verification/QRCode
 */
import { VerificationBase as Base } from "./Base";
import { VerificationRequest } from "./request/VerificationRequest";
import { MatrixClient } from "../../client";
import { IVerificationChannel } from "./request/Channel";
import { MatrixEvent } from "../../models/event";
export declare const SHOW_QR_CODE_METHOD = "m.qr_code.show.v1";
export declare const SCAN_QR_CODE_METHOD = "m.qr_code.scan.v1";
/**
 * @class crypto/verification/QRCode/ReciprocateQRCode
 * @extends {module:crypto/verification/Base}
 */
export declare class ReciprocateQRCode extends Base {
    reciprocateQREvent: {
        confirm(): void;
        cancel(): void;
    };
    static factory(channel: IVerificationChannel, baseApis: MatrixClient, userId: string, deviceId: string, startEvent: MatrixEvent, request: VerificationRequest): ReciprocateQRCode;
    static get NAME(): string;
    protected doVerification: () => Promise<void>;
}
declare enum Mode {
    VerifyOtherUser = 0,
    VerifySelfTrusted = 1,
    VerifySelfUntrusted = 2
}
export declare class QRCodeData {
    readonly mode: Mode;
    private readonly sharedSecret;
    readonly otherUserMasterKey: string | undefined;
    readonly otherDeviceKey: string | undefined;
    readonly myMasterKey: string | undefined;
    private readonly buffer;
    constructor(mode: Mode, sharedSecret: string, otherUserMasterKey: string | undefined, otherDeviceKey: string | undefined, myMasterKey: string | undefined, buffer: Buffer);
    static create(request: VerificationRequest, client: MatrixClient): Promise<QRCodeData>;
    /**
     * The unpadded base64 encoded shared secret.
     */
    get encodedSharedSecret(): string;
    getBuffer(): Buffer;
    private static generateSharedSecret;
    private static getOtherDeviceKey;
    private static determineMode;
    private static generateQrData;
    private static generateBuffer;
}
export {};
//# sourceMappingURL=QRCode.d.ts.map