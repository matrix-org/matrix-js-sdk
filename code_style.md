## Guiding principles

1. We want the lint rules to feel natural for most team members. No one should have to think too much
   about the linter.
2. We want to stay relatively close to [industry standards](https://google.github.io/styleguide/tsguide.html)
   to make onboarding easier.
3. We describe what good code looks like rather than point out bad examples. We do this to avoid
   excessively punishing people for writing code which fails the linter.
4. When something isn't covered by the style guide, we come up with a reasonable rule rather than
   claim that it "passes the linter". We update the style guide and linter accordingly.
5. While we aim to improve readability, understanding, and other aspects of the code, we deliberately
   do not let solely our personal preferences drive decisions.
6. We aim to have an understandable guide.

## Coding practices

1. Lint rules enforce decisions made by this guide. The lint rules and this guide are kept in
   perfect sync.
2. Commit messages are descriptive for the changes. When the project supports squash merging,
   only the squashed commit needs to have a descriptive message.
3. When there is disagreement with a code style approved by the linter, a PR is opened against
   the lint rules rather than making exceptions on the responsible code PR.
4. Rules which are intentionally broken (via eslint-ignore, @ts-ignore, etc) have a comment
   included in the immediate vicinity for why. Determination of whether this is valid applies at
   code review time.
5. When editing a file, nearby code is updated to meet the modern standards. "Nearby" is subjective,
   but should be whatever is reasonable at review time. Such an example might be to update the
   class's code style, but not the file's.
    1. These changes should be minor enough to include in the same commit without affecting a code
       reviewer's job.

## All code

Unless otherwise specified, the following applies to all code:

1. Files must be formatted with Prettier.
2. 120 character limit per line. Match existing code in the file if it is using a lower guide.
3. A tab/indentation is 4 spaces.
4. Newlines are Unix.
5. A file has a single empty line at the end.
6. Lines are trimmed of all excess whitespace, including blank lines.
7. Long lines are broken up for readability.

## TypeScript / JavaScript

1. Write TypeScript. Turn JavaScript into TypeScript when working in the area.
2. Use [TSDoc](https://tsdoc.org/) to document your code. See [Comments](#comments) below.
3. Use named exports.
4. Use semicolons for block/line termination.
    1. Except when defining interfaces, classes, and non-arrow functions specifically.
5. When a statement's body is a single line, it must be written without curly braces, so long as the body is placed on
   the same line as the statement.

    ```typescript
    if (x) doThing();
    ```

6. Blocks for `if`, `for`, `switch` and so on must have a space surrounding the condition, but not
   within the condition.

    ```typescript
    if (x) {
        doThing();
    }
    ```

7. lowerCamelCase is used for function and variable naming.
8. UpperCamelCase is used for general naming.
9. Interface names should not be marked with an uppercase `I`.
10. One variable declaration per line.
11. If a variable is not receiving a value on declaration, its type must be defined.

    ```typescript
    let errorMessage: Optional<string>;
    ```

12. Objects can use shorthand declarations, including mixing of types.

    ```typescript
    {
        room,
        prop: this.prop,
    }
    // ... or ...
    { room, prop: this.prop }
    ```

13. Object keys should always be non-strings when possible.

    ```typescript
    {
        property: "value",
        "m.unavoidable": true,
        [EventType.RoomMessage]: true,
    }
    ```

14. If a variable's type should be boolean, make sure it really is one.

    ```typescript
    const isRealUser = !!userId && ...; // good
    const isRealUser = Boolean(userId) && Boolean(userName); // also good
    const isRealUser = Boolean(userId) && isReal; // also good (where isReal is another boolean variable)
    const isRealUser = Boolean(userId && userName); // also fine
    const isRealUser = Boolean(userId || userName); // good: same as &&
    const isRealUser = userId && ...;   // bad: isRealUser is userId's type, not a boolean

    if (userId) // fine: userId is evaluated for truthiness, not stored as a boolean
    ```

15. Use `switch` statements when checking against more than a few enum-like values.
16. Use `const` for constants, `let` for mutability.
17. Describe types exhaustively (ensure noImplictAny would pass).
    1. Notable exceptions are arrow functions used as parameters, when a void return type is
       obvious, and when declaring and assigning a variable in the same line.
18. Declare member visibility (public/private/protected).
19. Private members are private and not prefixed unless required for naming conflicts.
    1. Convention is to use an underscore or the word "internal" to denote conflicted member names.
    2. "Conflicted" typically refers to a getter which wants the same name as the underlying variable.
20. Prefer readonly members over getters backed by a variable, unless an internal setter is required.
21. Prefer Interfaces for object definitions, and types for parameter-value-only declarations.

    1. Note that an explicit type is optional if not expected to be used outside of the function call,
       unlike in this example:

        ```typescript
        interface MyObject {
            hasString: boolean;
        }

        type Options = MyObject | string;

        function doThing(arg: Options) {
            // ...
        }
        ```

22. Variables/properties which are `public static` should also be `readonly` when possible.
23. Interface and type properties are terminated with semicolons, not commas.
24. Prefer arrow formatting when declaring functions for interfaces/types:

    ```typescript
    interface Test {
        myCallback: (arg: string) => Promise<void>;
    }
    ```

25. Prefer a type definition over an inline type. For example, define an interface.
26. Always prefer to add types or declare a type over the use of `any`. Prefer inferred types
    when they are not `any`.
    1. When using `any`, a comment explaining why must be present.
27. `import` should be used instead of `require`, as `require` does not have types.
28. Export only what can be reused.
29. Prefer a type like `Optional<X>` (`type Optional<T> = T | null | undefined`) instead
    of truly optional parameters.

    1. A notable exception is when the likelihood of a bug is minimal, such as when a function
       takes an argument that is more often not required than required. An example where the
       `?` operator is inappropriate is when taking a room ID: typically the caller should
       supply the room ID if it knows it, otherwise deliberately acknowledge that it doesn't
       have one with `null`.

        ```typescript
        function doThingWithRoom(
            thing: string,
            room: Optional<string>, // require the caller to specify
        ) {
            // ...
        }
        ```

30. There should be approximately one interface, class, or enum per file unless the file is named
    "types.ts", "global.d.ts", or ends with "-types.ts".
    1. The file name should match the interface, class, or enum name.
31. Bulk functions can be declared in a single file, though named as "foo-utils.ts" or "utils/foo.ts".
32. Imports are grouped by external module imports first, then by internal imports.
33. File ordering is not strict, but should generally follow this sequence:
    1. Licence header
    2. Imports
    3. Constants
    4. Enums
    5. Interfaces
    6. Functions
    7. Classes
        1. Public/protected/private static properties
        2. Public/protected/private properties
        3. Constructors
        4. Public/protected/private getters & setters
        5. Protected and abstract functions
        6. Public/private functions
        7. Public/protected/private static functions
34. Variable names should be noticeably unique from their types. For example, "str: string" instead
    of "string: string".
35. Use double quotes to enclose strings. You may use single quotes if the string contains double quotes.

    ```typescript
    const example1 = "simple string";
    const example2 = 'string containing "double quotes"';
    ```

36. Prefer async-await to promise-chaining

    ```typescript
    async function () {
        const result = await anotherAsyncFunction();
        // ...
    }
    ```

37. Avoid functions whose fundamental behaviour varies with different parameter types.
    Multiple return types are fine, but if the function's behaviour is going to change significantly,
    have two separate functions. For example, `SDKConfig.get()` with a string param which returns the
    type according to the param given is ok, but `SDKConfig.get()` with no args returning the whole
    config object would not be: this should just be a separate function.

## Tests

1. Tests must be written in TypeScript.
2. Jest mocks are declared below imports, but above everything else.
3. Use the following convention template:

    ```typescript
    // Describe the class, component, or file name.
    describe("FooComponent", () => {
        // all test inspecific variables go here

        beforeEach(() => {
            // exclude if not used.
        });

        afterEach(() => {
            // exclude if not used.
        });

        // Use "it should..." terminology
        it("should call the correct API", async () => {
            // test-specific variables go here
            // function calls/state changes go here
            // expectations go here
        });
    });

    // If the file being tested is a utility class:
    describe("foo-utils", () => {
        describe("firstUtilFunction", () => {
            it("should...", async () => {
                // ...
            });
        });

        describe("secondUtilFunction", () => {
            it("should...", async () => {
                // ...
            });
        });
    });
    ```

## Comments

1. As a general principle: be liberal with comments. This applies to all files: stylesheets as well as
   JavaScript/TypeScript.

    Good comments not only help future readers understand and maintain the code; they can also encourage good design
    by clearly setting out how different parts of the codebase interact where that would otherwise be implicit and
    subject to interpretation.

2. Aim to document all types, methods, class properties, functions, etc, with [TSDoc](https://tsdoc.org/) doc comments.
   This is _especially_ important for public interfaces in `matrix-js-sdk`, but is good practice in general.

    Even very simple interfaces can often benefit from a doc-comment, both as a matter of consistency, and because simple
    interfaces have a habit of becoming more complex over time.

3. Inside a function, there is no need to comment every line, but consider:

    - before a particular multiline section of code within the function, give an overview of what it does,
      to make it easier for a reader to follow the flow through the function as a whole.
    - if it is anything less than obvious, explain _why_ we are doing a particular operation, with particular emphasis
      on how this function interacts with other parts of the codebase.

4. When making changes to existing code, authors are expected to read existing comments and make any necessary changes
   to ensure they remain accurate.

5. Reviewers are encouraged to consider whether more comments would be useful, and to ask the author to add them.

    It is natural for an author to feel that the code they have just written is "obvious" and that comments would be
    redundant, whereas in reality it would take some time for reader unfamiliar with the code to understand it. A
    reviewer is well-placed to make a more objective judgement.
