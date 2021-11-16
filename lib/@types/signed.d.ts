export interface ISignatures {
    [entity: string]: {
        [keyId: string]: string;
    };
}
export interface ISigned {
    signatures?: ISignatures;
}
//# sourceMappingURL=signed.d.ts.map