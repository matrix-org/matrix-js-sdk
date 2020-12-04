export interface KeyInformation {
    keys: Record<string, {
        algorithm: string;
        passphrase: {
            algorithm: string;
            iterations: number;
            salt: string;
        },
        iv: string;
        mac: string;
    }>;
}



