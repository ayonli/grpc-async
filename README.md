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
- [@grpc/grpc-js](https://www.npmjs.com/package/@grpc/grpc-js) and [@grpc/proto-loader](https://www.npmjs.com/package/@grpc/proto-loader)
- For server-side code, if using [TypeScript](https://www.typescriptlang.org/),
    make sure the compiling target is `es2018` or higher which outputs native
    async generator functions.

## Install

In order to install this package, you must install **@grpc/grpc-js** and
**@grpc/proto-loader** as well.

```sh
npm i @grpc/grpc-js @grpc/proto-loader @hyurl/grpc-async
```

## Examples

The following examples first show the traditional way of implementations and
then show the async way implementations, so that we can compare how simple it is
in the new way.

### Traditional Way

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

const PROTO_PATH = __dirname + '/examples/index.proto';
const addr = "localhost:50051";

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});
const { examples } = loadPackageDefinition(packageDefinition);

type Request = {
    name: string;
};

type Response = {
    message: string;
};

// ==== server ====
const server = new Server();
// @ts-ignore
server.addService(examples.Greeter.service, {
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
const client = new examples.Greeter(addr, credentials.createInsecure());

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

### Async Way

```ts
import * as protoLoader from '@grpc/proto-loader';
import { loadPackageDefinition, Server, ServerCredentials, credentials } from "@grpc/grpc-js";
import {
    serve,
    connect,
    ServerReadableStream,
    ServerDuplexStream
} from "."; // replace this with "@hyurl/grpc-async" in your code

const PROTO_PATH = __dirname + '/examples/examples.proto';
const addr = "localhost:50051";

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});
const { examples } = loadPackageDefinition(packageDefinition);

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
serve<Greeter>(examples.Greeter, {
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
const client = connect<Greeter>(examples.Greeter, addr, credentials.createInsecure());

(async () => {
    const reply = await client.sayHello({ name: "World" });
    console.log(reply); // { message: "Hello, World" }
})().catch(console.error);

(async () => {
    for await (const reply of client.sayHelloStreamReply({ name: "World" })) {
        console.log(reply);
        // { message: "Hello 1: World" }
        // { message: "Hello 2: World" }
        // { message: "Hello 3: World" }
    }
})().catch(console.error);

(async () => {
    const streamRequestCall = client.sayHelloStreamRequest();
    streamRequestCall.write({ name: "Mr. World" });
    streamRequestCall.write({ name: "Mrs. World" });
    const reply1 = await streamRequestCall.returns();
    console.log(reply1); // { message: "Hello, Mr. World, Mrs. World" }
})().catch(console.error);

(async () => {
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
})().catch(console.error);
// ==== client ====
```

*You can see more about the examples in the [examples](./examples) folder.*

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
Anyway, I'll list them as follows:

```ts
export function serve<T>(
    service: grpc.ServiceClientConstructor | grpc.ServiceDefinition<T>,
    impl: T | (new () => T),
    server: grpc.Server
): void;

export function unserve<T>(
    service: grpc.ServiceClientConstructor | ServiceDefinition<T>,
    server: grpc.Server
): void;

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

export interface ServiceClientConstructor<T extends object> {
    new(address: string, credentials: gprc.ChannelCredentials, options?: Partial<gprc.ChannelOptions>): ServiceClient<T>;
    service: grpc.ServiceDefinition;
    serviceName: string;
}
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

        return await this.sayHello({ name: names.join(", ") });
    }

    async *sayHelloDuplex(stream: ServerDuplexStream<Request, Response>) {
        for await (const req of stream) {
            yield await this.sayHello(req);
        }
    }
}

// ==== server ====
server = new Server();
// @ts-ignorea
serve<Greeter>(examples.Greeter, GreeterService, server);

// ...
```

A class instance holds its own internal state, for example, we can store some
data in a property and use it whenever we need it. And we can use `this` keyword
to access other methods inside the class (as the above example demonstrates).

However, if we're going to use the class, make sure the following rules are
honored:

- The constructor of the class takes no arguments (`0-arguments` design).
- Only the RPC functions are modified public (they're the only ones accessible
    outside the class scope).

## Use ServiceProxy and ConnectionManager

Other than using `connect()` to connect to a certain server, we can use
`new ServiceProxy()` to connect to multiple servers at once and leverage calls with
a programmatic client-side load balancer.

Unlike the traditional load balancer which uses a
DNS resolver that assumes our program runs on different machines, this new load
balancer allows us to run the server in the same machine but in many
process/instances. And we can programmatically control how our traffic is routed
to different servers on demand.

```ts
import { ServiceProxy } from "."; // replace this with `@hyurl/grpc-async` in your code
// ...

// imagine we have three server instances run on the same server (localhost).
const proxy = new ServiceProxy({
    package: "examples", // same package name in the .proto file
    // @ts-ignore
    service: examples.Greeter,
}, [
    { address: "localhost:50051", credentials: credentials.createInsecure() },
    { address: "localhost:50052", credentials: credentials.createInsecure() },
    { address: "localhost:50053", credentials: credentials.createInsecure() }
]);

(async () => {
    // Be default, the proxy uses round-robin algorithm for routing, so
    // this call happens on the first server instance,
    const reply1 = await proxy.getInstance().sayHello({ name: "World" });

    // this call happens on the second server instance.
    const reply2 = await proxy.getInstance().sayHello({ name: "World" });

    // this call happens on the third server instance.
    const reply3 = await proxy.getInstance().sayHello({ name: "World" });

    // this call happens on the first server instance.
    const reply4 = await proxy.getInstance().sayHello({ name: "World" });
})();

// We can define the route resolver to achieve custom load balancing strategy.
import hash from "string-hash"; // assuming this package exists
const proxy2 = new ServiceProxy({
    package: "examples", // same package name in the .proto file
    // @ts-ignore
    service: examples.Greeter,
}, [
    { address: "localhost:50051", credentials: credentials.createInsecure() },
    { address: "localhost:50052", credentials: credentials.createInsecure() },
    { address: "localhost:50053", credentials: credentials.createInsecure() }
], (ctx) => {
    const addresses: string[] = ctx.servers.map(item => item.address);

    if (typeof ctx.params === "string") {
        if (addresses.includes(ctx.params)) {
            return ctx.params; // explicitly use a server instance
        } else {
            // route by hash
            const id: number = hash(ctx.params);
            return addresses[id % addresses.length];
        }
    } else if (typeof ctx.params === "number") {
        return addresses[ctx.params % addresses.length];
    } else if (typeof ctx.params === "object") {
        // This algorithm guarantees the same param structure passed to the
        // `getInstance()` returns the same service instance.
        const id: number = hash(Object.keys(ctx.params ?? {}).sort());
        return addresses[id % addresses.length];
    } else {
        // use round-robin
        return addresses[ctx.acc % addresses.length];
    }
});

(async () => {
    // These two calls will happen on the same server instance since they have
    // the same route param structure:
    const req1: Request = { name: "Mr. World" };
    const reply1 = await proxy2.getInstance(req).sayHello(req);

    const req2: Request = { name: "Mrs. World" };
    const reply2 = await proxy2.getInstance(req).sayHello(req);

    // This call happens on the first server since we explicitly set the server
    // address to use:
    const req3: Request = { name: "Mrs. World" };
    const reply3 = await proxy2.getInstance("localhost:50051").sayHello(req);
})();
```

### ConnectionManager

ConnectionManager provides a place to manage all clients and retrieve instances
via a general approach.

```ts
import { ServiceProxy, ConnectionManager } from "."; // replace this with `@hyurl/grpc-async` in your code
// ...

// imagine we have three server instances run on the same server (localhost).
const proxy = new ServiceProxy({
    package: "examples", // same package name in the .proto file
    // @ts-ignore
    service: examples.Greeter,
}, [
    { address: "localhost:50051", credentials: credentials.createInsecure() },
    { address: "localhost:50052", credentials: credentials.createInsecure() },
    { address: "localhost:50053", credentials: credentials.createInsecure() }
]);

const manager = new ConnectionManager();

manager.register(proxy);

// Instead of calling `proxy.getInstance()`, we do this:
const ins = manager.getInstanceOf<Greeter>("examples.Greeter");
```

A client or a proxy always binds a specific service client constructor and is
a scoped variable, if we are going to access them across our program in different
places, it would very painful and may cause recursive import problem.

The connection manager, however, is a central place and a single variable, we
can assign it to the global namespace and use it to retrieve service instance
anywhere we want without worrying how to import it.

For example:

```ts
import { ConnectionManager } from "."; // replace this with `@hyurl/grpc-async` in your code
// ...

declare global {
    const services: ConnectionManager;
}

// @ts-ignore
const manager = global["services"] = new ConnectionManager();

manager.register(proxy);

// and use it anywhere
const ins = services.getInstanceOf<Greeter>("examples.Greeter");
```

**Further more**, we can extend our `services` via chaining syntax, make our code
even more cleaner and elegant.

```ts
import { ConnectionManager, ServiceProxyOf } from "."; // replace this with `@hyurl/grpc-async` in your code
// ...

declare global {
    // Instead of defining `services` as global constant, we define it as a
    // namespace which contain sub namespace that corresponds the package name
    // in the .proto file.
    namespace services.examples {
        const Greeter: ServiceProxyOf<Greeter>;
    }
}

const manager = new ConnectionManager();

manager.register(proxy);

// @ts-ignore
global["services"] = manager.useChainingSyntax();

// and use it anywhere
const ins = services.examples.Greeter();
```

For more information about the `ServiceProxy` and the `ConnectionManager`, please
refer to the [source code](./proxy.ts) of their definition. They are the
enhancement part of this package that aims to provide straightforward usage of
gRPC in a project with services system design.
