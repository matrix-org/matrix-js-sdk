export class InvalidStoreError extends Error {
    static TOGGLED_LAZY_LOADING = "TOGGLED_LAZY_LOADING";
    reason: string;
    value: unknown;

    constructor(reason: string, value: unknown) {
        const message = `Store is invalid because ${reason}, `
            + `please stop the client, delete all data and start the client again`;
        super(message);
        this.reason = reason;
        this.value = value;
    }
}

export class InvalidCryptoStoreError extends Error {
    static TOO_NEW = "TOO_NEW";
    reason: string;

    constructor(reason: string) {
        const message = `Crypto store is invalid because ${reason}, ` +
            `please stop the client, delete all data and start the client again`;
        super(message);
        this.reason = reason;
    }
}

export class KeySignatureUploadError extends Error {
    value: unknown;

    constructor(message: string, value: unknown) {
        super(message);
        this.value = value;
    }
}
