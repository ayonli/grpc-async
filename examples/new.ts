import * as protoLoader from '@grpc/proto-loader';
import { loadPackageDefinition, Server, ServerCredentials, credentials } from "@grpc/grpc-js";
import {
    serve,
    connect,
    ServerReadableStream,
    ServerDuplexStream
} from ".."; // replace this with "@hyurl/grpc-async" in your code

const PROTO_PATH = __dirname + '/../test/helloworld.proto';
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
const server = new Server();

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
