import { Server, ServerCredentials, credentials } from "@grpc/grpc-js";
import {
    serve,
    connect,
    ServerReadableStream,
    ServerDuplexStream
} from "../index"; // replace this with "@hyurl/grpc-async" in your code
import { SERVER_ADDRESS, examples, Request, Response } from "./traditional";

export class Greeter {
    async sayHello({ name }: Request) {
        return { message: "Hello, " + name } as Response;
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
        for await (const { name } of stream) {
            yield await this.sayHello({ name });
        }
    }
}

if (require.main?.filename === __filename) {
    // ==== server ====
    const server = new Server();

    // @ts-ignore
    serve<Greeter>(server, examples.Greeter, new Greeter());

    server.bindAsync(SERVER_ADDRESS, ServerCredentials.createInsecure(), () => {
        server.start();
    });
    // ==== server ====

    // ==== client ====
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

    Promise.all(jobs).then(() => {
        client.close();
        server.forceShutdown();
    }).catch(console.error);
    // ==== client ====
}
