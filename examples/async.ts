import { Server, ServerCredentials, credentials } from "@grpc/grpc-js";
import {
    serve,
    connect,
    ServerReadableStream,
    ServerDuplexStream
} from "../index"; // replace this with "@hyurl/grpc-async" in your code
import { SERVER_ADDRESS, examples, Request, Response } from "./traditional";

export interface Greeter {
    sayHello(req: Request): Promise<Response>;
    sayHelloStreamReply(req: Request): AsyncGenerator<Response, void, unknown>;
    sayHelloStreamRequest(stream: ServerReadableStream<Request, Response>): Promise<Response>;
    sayHelloDuplex(stream: ServerDuplexStream<Request, Response>): AsyncGenerator<Response, void, unknown>;
}

export const GreeterStaticImpl: Greeter = {
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
};

export async function clientMain() {
    // @ts-ignore
    const client = connect<Greeter>(examples.Greeter, SERVER_ADDRESS, credentials.createInsecure());
    const jobs: Promise<void>[] = [];

    jobs.push((async () => {
        const reply = await client.sayHello({ name: "World" });
        console.log(reply); // { message: "Hello, World" }
    })());

    jobs.push((async () => {
        for await (const reply of client.sayHelloStreamReply({ name: "World" })) {
            console.log(reply);
            // { message: "Hello 1: World" }
            // { message: "Hello 2: World" }
            // { message: "Hello 3: World" }
        }
    })());

    jobs.push((async () => {
        const streamRequestCall = client.sayHelloStreamRequest();
        streamRequestCall.write({ name: "Mr. World" });
        streamRequestCall.write({ name: "Mrs. World" });
        const reply1 = await streamRequestCall.returns();
        console.log(reply1); // { message: "Hello, Mr. World, Mrs. World" }
    })());

    jobs.push((async () => {
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
    })());

    await Promise.all(jobs).catch(console.error);

    client.close();
}

if (require.main?.filename === __filename) {
    // ==== server ====
    const server = new Server();

    // @ts-ignore
    serve<Greeter>(examples.Greeter, GreeterStaticImpl, server);

    server.bindAsync(SERVER_ADDRESS, ServerCredentials.createInsecure(), () => {
        server.start();
    });
    // ==== server ====

    // ==== client ====
    clientMain().then(() => {
        server.forceShutdown();
    });
    // ==== client ====
}
