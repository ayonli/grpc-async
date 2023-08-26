# gRPC Async

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

In order to install this package, we must install **@grpc/grpc-js** and
**@grpc/proto-loader** as well.

```sh
npm i @grpc/grpc-js @grpc/proto-loader @ayonli/grpc-async
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
    GrpcObject,
    ServiceClientConstructor,
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

const PROTO_PATH = __dirname + '/examples/Greeter.proto';
const SERVER_ADDRESS = "localhost:50051";

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});
const examples = loadPackageDefinition(packageDefinition).examples as GrpcObject;
const Greeter = examples.Greeter as ServiceClientConstructor;

type Request = {
    name: string;
};

type Response = {
    message: string;
};

// ==== server ====
const server = new Server();
server.addService(Greeter.service, {
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

server.bindAsync(SERVER_ADDRESS, ServerCredentials.createInsecure(), () => {
    server.start();
});
// ==== server ====

// ==== client ====
const client = new Greeter(SERVER_ADDRESS, credentials.createInsecure());

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

                // THINK: what should we do with the **reply**? If our code
                // logic is from top to bottom, but we get the reply above the
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
import {
    loadPackageDefinition,
    GrpcObject,
    ServiceClientConstructor,
    Server,
    ServerCredentials,
    credentials
} from "@grpc/grpc-js";
import {
    serve,
    connect,
    ServerReadableStream,
    ServerDuplexStream
} from "@ayonli/grpc-async";

const PROTO_PATH = __dirname + '/examples/Greeter.proto';
const SERVER_ADDRESS = "localhost:50051";

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});
const examples = loadPackageDefinition(packageDefinition).examples as GrpcObject;

type Request = {
    name: string;
};

type Response = {
    message: string;
};

class Greeter {
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
const server = new Server()

serve(server, examples.Greeter as ServiceClientConstructor, new Greeter());

server.bindAsync(SERVER_ADDRESS, ServerCredentials.createInsecure(), () => {
    server.start();
});
// ==== server ====

// ==== client ====
const client = connect<Greeter>(
    examples.Greeter as ServiceClientConstructor,
    SERVER_ADDRESS,
    credentials.createInsecure());

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
    const call = client.sayHelloStreamRequest();
    call.write({ name: "Mr. World" });
    call.write({ name: "Mrs. World" });

    const reply = await call.returns();
    console.log(reply); // { message: "Hello, Mr. World, Mrs. World" }
})().catch(console.error);

(async () => {
    const call = client.sayHelloDuplex();
    let counter = 0;

    call.write({ name: "Mr. World" });
    call.write({ name: "Mrs. World" });

    for await (const reply of call) {
        console.log(reply);
        // { message: "Hello, Mr. World" }
        // { message: "Hello, Mrs. World" }

        if (++counter === 2) {
            call.end(); // this will cause the iterator to close
        }
    }
})().catch(console.error);
// ==== client ====
```

*We can see more about the examples in the [examples](./examples) folder.*

#### Recap

See the major differences here?

**On the server**

1. Instead of calling the `server.addService()` function to register the
    implementation, we use the `serve()` utility function, which supports
    native async (and async generator) functions.
2. Instead of just using an object literal as the service implementation, we
    define a class as implementation that honors the design in the `.proto` file.
3. Instead of accessing the `request` from the `call` context argument, we
    receive the data directly from the function's argument, which honor the same
    design in the `.proto` file.
4. For unary calls, instead of calling the `callback()` to send the response, we
    simply return it from the function, which also honor the same design in the
    `.proto` file.
5. For stream reply calls, instead of calling `call.write()` to send the
    response, we take advantage of the native `yield` expression, which
    generates results overtime.
6. For stream request calls, instead of listening to the `data` and `end` events,
    we use the `for await` statement to receive the requests sent by the client.
7. For duplex calls, instead of listening to the `data` event for requests and
    calling `call.write()` to send back response, we use the `for await`
    statement and the `yield` expression which are more straightforward.

**On the client**

1. Instead of creating the instance via a `new` expression, we use `connect()`
    utility function to generate the instance, which resolves RPC functions with
    native async support.
2. We use the type `Greeter` on the `connect()` function so it can produce
    correct methods in TypeScript that could helps us reduce errors in our code.
3. There is no need for the `waitForReady()` since it's handled automatically
    inside the function call.
4. For unary calls, instead of passing a callback function to retrieve the
    response, we use the `await` expression to get the result.
5. For stream reply calls, instead of listening to the `data` and `end` events,
    we use the `for await` statement to receive the responses yielded by the
    server.
6. For stream request calls, instead using a callback function to receive the
    response, we use the `call.returns()` to retrieve the response just where
    we need it.
7. For duplex calls, instead of listening to the `data` event for responses,
    again, we use the `for await` statement to receive the responses yielded by
    the server.

## LoadBalancer

Other than using `connect()` to connect to a certain server, we can use
`new LoadBalancer()` to connect to multiple servers at once and leverage calls
with a programmatic client-side load balancer.

Unlike the traditional load balancer which uses a DNS resolver that assumes our
program runs on different machines or virtual machines, this new load balancer
allows us to run the server in the same machine but in many processes/instances,
and we can programmatically control how our traffic is routed to different
server instances on demand.

```ts
import { LoadBalancer } from "@ayonli/grpc-async";
// ...

// Imagine we have three server instances run on the same server (localhost).
const balancer = new LoadBalancer(examples.Greeter as ServiceClientConstructor, [
    { address: "localhost:50051", credentials: credentials.createInsecure() },
    { address: "localhost:50052", credentials: credentials.createInsecure() },
    { address: "localhost:50053", credentials: credentials.createInsecure() }
]);

(async () => {
    // Be default, the load balancer uses round-robin algorithm for routing, so
    // this call happens on the first server instance,
    const reply1 = await balancer.getInstance().sayHello({ name: "World" });

    // this call happens on the second server instance.
    const reply2 = await balancer.getInstance().sayHello({ name: "World" });

    // this call happens on the third server instance.
    const reply3 = await balancer.getInstance().sayHello({ name: "World" });

    // this call happens on the first server instance.
    const reply4 = await balancer.getInstance().sayHello({ name: "World" });
})();

// We can define the route resolver to achieve custom load balancing strategy.
import hash from "string-hash"; // assuming this package exists
const balancer2 = new LoadBalancer(examples.Greeter as ServiceClientConstructor, [
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
        const id: number = hash(String(Object.keys(ctx.params ?? {}).sort()));
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
    const reply1 = await balancer2.getInstance(req).sayHello(req);

    const req2: Request = { name: "Mrs. World" };
    const reply2 = await balancer2.getInstance(req).sayHello(req);

    // This call happens on the first server since we explicitly set the server
    // address to use:
    const req3: Request = { name: "Mrs. World" };
    const reply3 = await balancer2.getInstance("localhost:50051").sayHello(req);
})();
```

## ConnectionManager

ConnectionManager provides a place to manage all clients and retrieve instances
via a general approach.

A client or a load balancer always binds a specific service client constructor
and is a scoped variable, if we are going to use them across our program in
different places, it would very painful and may cause recursive import problem.

The connection manager, however, is a central place and a single variable, we
can assign it to the global namespace and use it to retrieve service instances
anywhere we want without worrying how to import them.

For example:

```ts
import { ConnectionManager } from "@ayonli/grpc-async";
// ...

declare global {
    const services: ConnectionManager;
}

// @ts-ignore
const manager = global["services"] = new ConnectionManager();

manager.register(client);
// Or
manager.register(balancer);

// and use it anywhere
const ins = services.getInstanceOf<Greeter>("examples.Greeter");
const result = await ins.sayHello({ name: "World" });
```

**Further more**, we can extend our `services` via chaining syntax, make our code
even more cleaner and elegant.

```ts
import { ConnectionManager, ServiceClient } from "@ayonli/grpc-async";
// ...

declare global {
    // Instead of defining `services` as global constant, we define it as a
    // namespace which contains sub namespaces that corresponds the package name
    // in the .proto file.
    namespace services.examples {
        const Greeter: ServiceClient<Greeter>;
    }
}

const manager = new ConnectionManager();

manager.register(client);
// Or
manager.register(balancer);

// @ts-ignore
global["services"] = manager.useChainingSyntax();

// and use it anywhere
const result = await services.examples.Greeter.sayHello({ name: "World" });
```

For more information about the `LoadBalancer` and the `ConnectionManager`, please
refer to the [source code](./client.ts) of their definition. They are the
enhancement part of this package that aims to provide straightforward usage of
gRPC in a project with distributed system design.

## API

Apart from the functions and classes, for better TypeScript support, this package
also rewrites some of the interfaces/types seen in the **@grpc/grpc-js** library,
I'll list them all as follows:

```ts
import * as grpc from "@grpc/grpc-js";

export declare function serve<T>(
    server: grpc.Server,
    service: grpc.ServiceClientConstructor | grpc.ServiceDefinition<T>,
    instance: T
): void;

export declare function unserve<T>(
    server: grpc.Server,
    service: grpc.ServiceClientConstructor | grpc.ServiceDefinition<T>
): void;

export declare function connect<T>(
    service: grpc.ServiceClientConstructor,
    address: string,
    credentials: grpc.ChannelCredentials,
    options?: Partial<grpc.ChannelOptions> & {
        connectTimeout?: number; // default 120_000 ms
    }
): ServiceClient<T>;

export type ServerWritableStream<Req, Res> = grpc.ServerWritableStream<Req, Res>;

export type ServerReadableStream<Req, Res = void> = grpc.ServerReadableStream<Req, Res> & AsyncIterable<Req>;

export type ServerDuplexStream<Req, Res> = grpc.ServerDuplexStream<Req, Res> & AsyncIterable<Req>;

export type ClientWritableStream<Req, Res> = grpc.ClientWritableStream<Req> & {
    returns(): Promise<Res>;
};

export type ClientReadableStream<Res> = grpc.ClientReadableStream<Res> & AsyncIterable<Res>;

export type ClientDuplexStream<Req, Res> = grpc.ClientDuplexStream<Req, Res> & AsyncIterable<Res>;

export type UnaryFunction<Req, Res> = (req: Req, metadata?: grpc.Metadata) => Promise<Res>;

export type StreamResponseFunction<Req, Res> = (req: Req, metadata?: grpc.Metadata) => AsyncGenerator<Res, void, unknown>;

export type StreamRequestFunction<Req, Res> = (stream: ServerReadableStream<Req>) => Promise<Res>;

export type DuplexFunction<Req, Res> = (stream: ServerDuplexStream<Req, Res>) => AsyncGenerator<Res, void, unknown>;

export type ClientMethods<T extends object> = {
    [K in keyof T]: T[K] extends DuplexFunction<infer Req, infer Res> ? (metadata?: grpc.Metadata) => ClientDuplexStream<Req, Res>
    : T[K] extends StreamRequestFunction<infer Req, infer Res> ? (metadata?: grpc.Metadata) => ClientWritableStream<Req, Res>
    : T[K] extends StreamResponseFunction<infer Req, infer Res> ? (req: Req, metadata?: grpc.Metadata) => AsyncGenerator<Res, void, unknown>
    : T[K] extends UnaryFunction<infer Req, infer Res> ? (req: Req, metadata?: grpc.Metadata) => Promise<Res>
    : T[K];
};

export type ServiceClient<T extends object> = Omit<grpc.Client, "waitForReady"> & {
    waitForReady(deadline?: Date | number): Promise<void>;
    waitForReady(deadline: Date | number, callback: (err: Error) => void): void;
} & ClientMethods<T>;

export type ServerConfig = {
    address: string;
    credentials: grpc.ChannelCredentials,
    options?: Partial<grpc.ChannelOptions> & { connectTimeout?: number; };
};

export declare class LoadBalancer<T extends object, P extends any = any> {
    readonly service: grpc.ServiceClientConstructor;

    /**
     * @param target 
     * @param servers The server configurations used to create service client.
     * @param routeResolver Custom route resolver used to implement load
     *  balancing algorithms, if not provided, a default round-robin algorithm
     *  is used. The function takes a context object and returns an address
     *  filtered from the `ctx.servers`.
     */
    constructor(
        service: grpc.ServiceClientConstructor,
        servers: ServerConfig[],
        routeResolver?: ((ctx: {
            service: grpc.ServiceClientConstructor;
            servers: (ServerConfig & { state: grpc.connectivityState; })[];
            /**
             * The route params passed when calling the `getInstance()` function, we
             * can use this object to calculate the desired route address.
             */
            params: P | null;
            acc: number;
        }) => string)
    );

    /**
     * Dynamically add server configurations at runtime, this is useful when we 
     * need to implement some kind of service discovery strategy.
     */
    addServer(server: ServerConfig): boolean;

    /**
     * Dynamically remove server configurations at runtime, this is useful when we 
     * need to implement some kind of service discovery strategy.
     */
    removeServer(address: string): boolean;

    /**
     * Retrieves an instance of the service client.
     * 
     * @param routeParams If a custom `routeResolver` is provided when initiating
     *  the load balancer, this argument will be passed to the function for route
     *  calculation, otherwise, it has no effect.
     * @returns 
     */
    getInstance(routeParams?: P): ServiceClient<T>;

    /** Closes all the connection. */
    close(): void;
}

export type ChainingProxyInterface = ServiceClient<any> | {
    [nsp: string]: ChainingProxyInterface;
};

export declare class ConnectionManager {
    register(target: ServiceClient<any> | LoadBalancer<any>): boolean;

    /**
     * @param target If the target is a string, it is the full name of the
     *  service (includes the package name, concatenated with `.`).
     */
    deregister(target: string | ServiceClient<any> | LoadBalancer<any>, closeConnection?: boolean): boolean;

    /**
     * @param target If the target is a string, it is the full name of the
     *  service (includes the package name, concatenated with `.`).
     * @param routeParams If a custom `routeResolver` is provided when initiating
     *  the load balancer, this argument will be passed to the function for route
     *  calculation, otherwise, it has no effect.
     * @throws If the target service is not registered, a ReferenceError will be
     *  thrown.
     */
    getInstanceOf<T extends object>(
        target: string | ServiceClient<T> | LoadBalancer<T>
    ): ServiceClient<T>;
    getInstanceOf<T extends object, P extends any = any>(
        target: string | ServiceClient<T> | LoadBalancer<T>,
        routeParams: P
    ): ServiceClient<T>;

    /** Closes all the connections of all proxies. */
    close(): void;

    /**
     * Instead of calling `#getInstanceOf()` to retrieve the service client,
     * this function allows us to use chaining syntax to dynamically generated
     * namespaces and client constructors that can be used as a syntax sugar.
     * @example
     *  // Instead of doing this:
     *  const ins = manager.getInstanceOf<Greeter>("examples.Greeter");
     *  const result = await ins.sayHello({ name: "World" });
     * 
     *  // We do this:
     *  const services = manager.useChainingSyntax();
     *  const result = await services.examples.Greeter.sayHello({ name: "World" });
     * @param rootNsp If set, the namespace will start from the given name.
     *  Usually leave blank or set to the package name in the proto file.
     * @example
     *  const examples = manager.useChainingSyntax("examples");
     *  const result = await examples.Greeter.sayHello({ name: "World" });
     */
    useChainingSyntax(rootNsp?: string): ChainingProxyInterface;
}
```
