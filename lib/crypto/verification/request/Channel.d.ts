import { MatrixEvent } from "../../../models/event";
import { VerificationRequest } from "./VerificationRequest";
export interface IVerificationChannel {
    request?: VerificationRequest;
    readonly userId: string;
    readonly roomId?: string;
    readonly deviceId?: string;
    readonly transactionId: string;
    readonly receiveStartFromOtherDevices?: boolean;
    getTimestamp(event: MatrixEvent): number;
    send(type: string, uncompletedContent: Record<string, any>): Promise<void>;
    completeContent(type: string, content: Record<string, any>): Record<string, any>;
    sendCompleted(type: string, content: Record<string, any>): Promise<void>;
    completedContentFromEvent(event: MatrixEvent): Record<string, any>;
    canCreateRequest(type: string): boolean;
}
//# sourceMappingURL=Channel.d.ts.map