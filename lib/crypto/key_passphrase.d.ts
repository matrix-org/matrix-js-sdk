interface IAuthData {
    private_key_salt?: string;
    private_key_iterations?: number;
    private_key_bits?: number;
}
interface IKey {
    key: Uint8Array;
    salt: string;
    iterations: number;
}
export declare function keyFromAuthData(authData: IAuthData, password: string): Promise<Uint8Array>;
export declare function keyFromPassphrase(password: string): Promise<IKey>;
export declare function deriveKey(password: string, salt: string, iterations: number, numBits?: number): Promise<Uint8Array>;
export {};
//# sourceMappingURL=key_passphrase.d.ts.map