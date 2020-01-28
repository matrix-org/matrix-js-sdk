export class InvalidStoreError extends Error {
    constructor(reason, value) {
        super(`Store is invalid because ${reason}, ` +
            `please stop the client, delete all data and start the client again`);
        this.reason = reason;
        this.value = value;
    }
    static TOGGLED_LAZY_LOADING = "TOGGLED_LAZY_LOADING";
}

export class InvalidCryptoStoreError extends Error {
    constructor(reason) {
        super(`Crypto store is invalid because ${reason}, ` +
            `please stop the client, delete all data and start the client again`);
        this.reason = reason;
        this.name = 'InvalidCryptoStoreError';
    }
    static TOO_NEW = "TOO_NEW";
}
