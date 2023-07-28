# @hyurl/grpc-async

A gRPC wrapper for Node.js with async functions.

The design of [@grpc/grpc-js](https://www.npmjs.com/package/@grpc/grpc-js) uses
a traditional Node.js callback design for function implementations, which, in
nowadays programming world, is painful. So this little library wraps the
async/await functionality into both the gRPC server and the client.

*(NOTE: this package only supports dynamic generated version of gRPC functions*
*since the static generated version lacks typing support.)*

## Prerequisites

- [Node.js](https://nodejs.org) v14+
- [@grpc/grpc-js](https://www.npmjs.com/package/@grpc/grpc-js)
- For server-side code, if using [TypeScript](https://www.typescriptlang.org/),
    make sure the compiling target is `es2018` or higher which outputs native
    async generator functions.

## Examples

The following examples first show the traditional way of implementations and
then show the async way implementations, so that we can compare how simple it is
in the new way.

### Traditional

```ts
import * as protoLoader from '@grpc/proto-loader';
import {
    loadPackageDefinition,
    Server,
    ServerUnaryCall,
    ServerWritableStream,
    ServerReadableStream,
    ServerDuplexStream,
    ServerCredentials,
    credentials,
    ClientReadableStream,
    ClientWritableStream,
    ClientDuplexStream
} from "@grpc/grpc-js"

const PROTO_PATH = __dirname + '/test/helloworld.proto';
const addr = "localhost:50051";

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});
const { helloworld } = loadPackageDefinition(packageDefinition);

type Request = {
    name: string;
};

type Response = {
    message: string;
};

// ==== server ====
const server = new Server();
// @ts-ignore
server.addService(helloworld.Greeter.service, {
    sayHello: (
        call: ServerUnaryCall<Request, Response>,
        callback: (err: Error, reply: Response) => void
    ) => {
        const { name } = call.request;
        callback(null, { message: "Hello, " + name } as Response);
    },
    sayHelloStreamReply: (call: ServerWritableStream<Request, Response>) => {
        const { name } = call.request;
        call.write({ message: "Hello 1: " + name } as Response);
        call.write({ message: "Hello 2: " + name } as Response);
        call.write({ message: "Hello 3: " + name } as Response);
        call.end();
    },
    sayHelloStreamRequest: (call: ServerReadableStream<Request, Response>, callback) => {
        const names: string[] = [];

        call.on("data", ({ name }: Request) => {
            names.push(name);
        }).once("end", () => {
            callback(null, { message: "Hello, " + names.join(", ") } as Response);
        }).once("error", (err) => {
            callback(err, void 0);
        });
    },
    sayHelloDuplex: (call: ServerDuplexStream<Request, Response>) => {
        call.on("data", ({ name }: Request) => {
            call.write({ message: "Hello, " + name });
        });
    }
});

server.bindAsync(addr, ServerCredentials.createInsecure(), () => {
    server.start();
});
// ==== server ====

// ==== client ====
// @ts-ignore
const client = new helloworld.Greeter(addr, credentials.createInsecure());

// Calling #waitForReady() is required since at this point the server may not be
// available yet.
client.waitForReady(Date.now() + 5000, (_: Error) => {
    client.sayHello({ name: "World" } as Request, (err: Error, reply: Response) => {
        if (err) {
            console.error(err);
        } else {
            console.log(reply); // { message: "Hello, World" }
        }
    });

    const streamReplyCall: ClientReadableStream<Response> = client.sayHelloStreamReply({
        name: "World",
    } as Request);
    streamReplyCall.on("data", (reply: Response) => {
        console.log(reply);
        // { message: "Hello 1: World" }
        // { message: "Hello 2: World" }
        // { message: "Hello 3: World" }
    }).on("error", err => {
        console.error(err);
    });

    const streamRequestCall: ClientWritableStream<Request> = client.sayHelloStreamRequest(
        (err: Error, reply: Response) => {
            if (err) {
                console.error(err);
            } else {
                console.log(reply); // { message: "Hello, Mr. World, Mrs. World" }

                // THINK: do you know what to do with the **reply**? If your code
                // logic is from top to bottom, but you get the reply above your
                // logic.
            }
        }
    );
    streamRequestCall.write({ name: "Mr. World" } as Request);
    streamRequestCall.write({ name: "Mrs. World" } as Request);
    streamRequestCall.end();

    const duplexCall: ClientDuplexStream<Request, Response> = client.sayHelloDuplex();
    duplexCall.on("data", (reply: Response) => {
        console.log(reply);
        // { message: "Hello, Mr. World" }
        // { message: "Hello, Mrs. World" }
    });
    duplexCall.write({ name: "Mr. World" });
    duplexCall.write({ name: "Mrs. World" });
    duplexCall.end();
});
// ==== client ====
```

### New

```ts
import * as protoLoader from '@grpc/proto-loader';
import { loadPackageDefinition, Server, ServerCredentials, credentials } from "@grpc/grpc-js";
import {
    serve,
    connect,
    ServerReadableStream,
    ServerDuplexStream
} from "."; // replace this with "@hyurl/grpc-async" in your code

const PROTO_PATH = __dirname + '/test/helloworld.proto';
const addr = "localhost:50051";

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});
const { helloworld } = loadPackageDefinition(packageDefinition);

type Request = {
    name: string;
};

type Response = {
    message: string;
};

interface Greeter {
    sayHello(req: Request): Promise<Response>;
    sayHelloStreamReply(req: Request): AsyncGenerator<Response, void, unknown>;
    sayHelloStreamRequest(stream: ServerReadableStream<Request, Response>): Promise<Response>;
    sayHelloDuplex(stream: ServerDuplexStream<Request, Response>): AsyncGenerator<Response, void, unknown>;
}

// ==== server ====
const server = new Server()

// @ts-ignore
serve<Greeter>(helloworld.Greeter, {
    async sayHello({ name }: Request) {
        return { message: "Hello, " + name } as Response;
    },
    async *sayHelloStreamReply({ name }: Request) {
        yield { message: "Hello 1: " + name } as Response;
        yield { message: "Hello 2: " + name } as Response;
        yield { message: "Hello 3: " + name } as Response;
    },
    async sayHelloStreamRequest(stream) {
        const names: string[] = [];

        for await (const { name } of stream) {
            names.push(name);
        }

        return { message: "Hello, " + names.join(", ") } as Response;
    },
    async *sayHelloDuplex(stream) {
        for await (const { name } of stream) {
            yield { message: "Hello, " + name } as Response;
        }
    }
}, server);

server.bindAsync(addr, ServerCredentials.createInsecure(), () => {
    server.start();
});
// ==== server ====

// ==== client ====
// @ts-ignore
const client = connect<Greeter>(helloworld.Greeter, addr, credentials.createInsecure());

(async () => {
    const reply = await client.sayHello({ name: "World" });
    console.log(reply); // { message: "Hello, World" }

    for await (const reply of client.sayHelloStreamReply({ name: "World" })) {
        console.log(reply);
        // { message: "Hello 1: World" }
        // { message: "Hello 2: World" }
        // { message: "Hello 3: World" }
    }

    const streamRequestCall = client.sayHelloStreamRequest();
    streamRequestCall.write({ name: "Mr. World" });
    streamRequestCall.write({ name: "Mrs. World" });
    const reply1 = await streamRequestCall.returns();
    console.log(reply1); // { message: "Hello, Mr. World, Mrs. World" }

    const duplexCall = client.sayHelloDuplex();
    let counter = 0;
    duplexCall.write({ name: "Mr. World" });
    duplexCall.write({ name: "Mrs. World" });

    for await (const reply of duplexCall) {
        console.log(reply);
        // { message: "Hello, Mr. World" }
        // { message: "Hello, Mrs. World" }

        if (++counter === 2) {
            duplexCall.end(); // this will cause the iterator to close
        }
    }
})().catch(err => {
    console.error(err);
});
// ==== client ====
```

#### Recap

See the major differences here?

**On the server**

1. Instead of calling the `server.addService()` function to register the
    implementations, we use the `serve()` utility function, which supports
    native async (and async generator) functions.
2. Instead of accessing the `request` from the `call` context argument, we
    receive the data directly from the function's argument, which honor the same
    design in the `.proto` file.
3. For unary calls, instead of calling the `callback()` to send the response, we
    simply return it from the function, which also honor the same design in the
    `.proto` file.
4. For stream reply calls, instead of calling `call.write()` to send the
    response, we take advantage of the native `yield` expression, which
    generates results overtime.
5. For stream request calls, instead of listening to the `data` and `end` events,
    we use the `for await` statement to receive the requests sent by the client.
6. For duplex calls, instead of listening to the `data` event for requests and
    calling `call.write()` to send back response, we use the `for await`
    statement and the `yield` expression which are more straightforward.

**On the client**

1. Instead of creating the instance via a `new` expression, we use `connect()`
    utility function to generate the instance, which resolves RPC functions with
    native async support.
2. There is no need for the `waitForReady()` since it's handled automatically
    inside the function call.
3. For unary calls, instead of passing a callback function to retrieve the
    response, we use the `await` expression to get the result.
4. For stream reply calls, instead of listening to the `data` and `end` events,
    we use the `for await` statement to receive the responses yielded by the
    server.
5. For stream request calls, instead using a callback function to receive the
    response, we use the `call.returns()` to retrieve the response just where
    we need it.
6. For duplex calls, instead of listening to the `data` event for responses,
    again, we use the `for await` statement to receive the responses yielded by
    the server.

**On both sides**

We define an interface `Greeter` which constraints the signature of the
functions, which is used on the `serve()` function that guarantees
implementations satisfying our needs, it is also used on the `connect()`
function which allows the program producing correct methods that patched to the
client instance. This technique allows us take benefits from the TypeScript
typing system and reduce errors in our code.

## API

There are only two major functions in this package and we have gone through them
in the above examples. However, for better TypeScript support, this package also
rewrites some of the interfaces/types seen in the **@grpc/grpc-js** library.
Anyway, I'll list them all as follows:

```ts
export function serve<T>(
    service: grpc.ServiceClientConstructor | grpc.ServiceDefinition<T>,
    impl: T | (new () => T),
    server: grpc.Server
): grpc.Server;

export function connect<T>(
    serviceCtor: grpc.ServiceClientConstructor,
    address: string,
    credentials: grpc.ChannelCredentials,
    options?: Partial<grpc.ChannelOptions> & {
        connectTimeout?: number; // default 120_000 ms
    }
): ServiceClient<T>;

export type ServerWritableStream<Req, Res> = grpc.ServerWritableStream<Req, Res>;

export type ServerReadableStream<Req, Res = void> = grpc.ServerReadableStream<Req, Res> & AsyncIterable<Req>;

export type ServerDuplexStream<Req, Res> = grpc.gServerDuplexStream<Req, Res> & AsyncIterable<Req>;

export type StreamRequestFunction<Req, Res> = (stream: ServerReadableStream<Req>) => Promise<Res>;

export type DuplexFunction<Req, Res> = (stream: ServerDuplexStream<Req, Res>) => AsyncGenerator<Res, void, unknown>;

export type ClientWritableStream<Req, Res> = grpc.ClientWritableStream<Req> & {
    returns(): Promise<Res>;
};

export type ClientReadableStream<Res> = grpc.ClientReadableStream<Res> & AsyncIterable<Res>;

export type ClientDuplexStream<Req, Res> = grpc.ClientDuplexStream<Req, Res> & AsyncIterable<Res>;

export type WrapMethods<T extends object> = {
    [K in keyof T]: T[K] extends StreamRequestFunction<infer Req, infer Res> ? () => ClientWritableStream<Req, Res>
    : T[K] extends DuplexFunction<infer Req, infer Res> ? () => ClientDuplexStream<Req, Res>
    : T[K];
};

export type ServiceClient<T extends object> = Omit<grpc.Client, "waitForReady"> & {
    waitForReady(deadline?: Date | number): Promise<void>;
    waitForReady(deadline: Date | number, callback: (err: Error) => void): void;
} & WrapMethods<T>;
```

## Use Service Class

Some people (me, in particular) may prefer a service class instead of an object
literal as the implementation of the gRPC functions. It could be done by passing
the class constructor to the `serve()` function, as the function signature shown
above. For instance, the `Greeter` example used in this article, we can define
its implementation in a `class`ic way.

```ts
// ...

class GreeterService implements Greeter { // or just class Greeter {}
    async sayHello({ name }: Request) {
        return { message: 'Hello ' + name } as Response;
    }

    async *sayHelloStreamReply({ name }: Request) {
        yield { message: `Hello 1: ${name}` } as Response;
        yield { message: `Hello 2: ${name}` } as Response;
        yield { message: `Hello 3: ${name}` } as Response;
    }

    async sayHelloStreamRequest(stream: ServerReadableStream<Request, Response>) {
        const names: string[] = [];

        for await (const { name } of stream) {
            names.push(name);
        }

        return { message: "Hello, " + names.join(", ") } as Response;
    }

    async *sayHelloDuplex(stream: ServerDuplexStream<Request, Response>) {
        for await (const { name } of stream) {
            yield { message: "Hello, " + name } as Response;
        }
    }
}

// ==== server ====

server = new Server();
// @ts-ignorea
serve<Greeter>(helloworld.Greeter, GreeterService, server);

// ...
```

A class instance holds its own internal state, for example, we can store some
data in a property and use it whenever we need it. And we can use `this` keyword
to access other methods inside the class.

However, if we're going to use the class, make sure the following rules are
honored:

- The constructor of the class takes no arguments (`0-arguments` design).
- Only the RPC functions are modified public (they're the only ones accessible
    outside the class scope).
