import { Server, ServerCredentials } from "@grpc/grpc-js";
import {
    serve,
    ServerReadableStream,
    ServerDuplexStream
} from "../index"; // replace this with "@hyurl/grpc-async" in your code
import { SERVER_ADDRESS, helloworld, Request, Response} from "./traditional";
import { Greeter, clientMain } from "./async";

export class GreeterService implements Greeter {
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
    serve<Greeter>(helloworld.Greeter, GreeterService, server);

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
