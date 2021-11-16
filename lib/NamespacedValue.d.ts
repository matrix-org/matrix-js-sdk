/**
 * Represents a simple Matrix namespaced value. This will assume that if a stable prefix
 * is provided that the stable prefix should be used when representing the identifier.
 */
export declare class NamespacedValue<S extends string, U extends string> {
    readonly stable: S | null | undefined;
    readonly unstable?: U;
    constructor(stable: S | null | undefined, unstable?: U);
    get name(): U | S;
    get altName(): U | S | null;
    matches(val: string): boolean;
    findIn<T>(obj: any): T;
    includedIn(arr: any[]): boolean;
}
/**
 * Represents a namespaced value which prioritizes the unstable value over the stable
 * value.
 */
export declare class UnstableValue<S extends string, U extends string> extends NamespacedValue<S, U> {
    constructor(stable: S, unstable: U);
    get name(): U;
    get altName(): S;
}
//# sourceMappingURL=NamespacedValue.d.ts.map