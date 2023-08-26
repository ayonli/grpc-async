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
    ClientDuplexStream,
    GrpcObject,
    ServiceClientConstructor
} from "@grpc/grpc-js";

const PROTO_PATH = __dirname + '/Greeter.proto';
export const SERVER_ADDRESS = "localhost:50051";

const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true
});
export const examples = loadPackageDefinition(packageDefinition).examples as GrpcObject;
const Greeter = examples.Greeter as ServiceClientConstructor;

export type Request = {
    name: string;
};

export type Response = {
    message: string;
};

if (require.main?.filename === __filename) {
    // ==== server ====
    const server = new Server();
    server.addService(Greeter.service, {
        sayHello: (
            call: ServerUnaryCall<Request, Response>,
            callback: (err: Error, reply: Response) => void
        ) => {
            const { name } = call.request;
            callback(null as any, { message: "Hello, " + name } as Response);
        },
        sayHelloStreamReply: (call: ServerWritableStream<Request, Response>) => {
            const { name } = call.request;
            call.write({ message: "Hello 1: " + name } as Response);
            call.write({ message: "Hello 2: " + name } as Response);
            call.write({ message: "Hello 3: " + name } as Response);
            call.end();
        },
        sayHelloStreamRequest: (
            call: ServerReadableStream<Request, Response>,
            callback: (err: Error, res?: Response) => void
        ) => {
            const names: string[] = [];

            call.on("data", ({ name }: Request) => {
                names.push(name);
            }).once("end", () => {
                callback(null as any, { message: "Hello, " + names.join(", ") } as Response);
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
    client.waitForReady(Date.now() + 5000, (_?: Error) => {
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

        // terminate the program after a while
        setTimeout(() => {
            client.close();
            server.forceShutdown();
        }, 1000);
    });
    // ==== client ====
}
