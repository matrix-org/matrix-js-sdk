/// <reference types="node" />
import { EventEmitter } from "events";
export declare class ReEmitter {
    private target;
    constructor(target: EventEmitter);
    reEmit(source: EventEmitter, eventNames: string[]): void;
}
//# sourceMappingURL=ReEmitter.d.ts.map