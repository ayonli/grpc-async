import { serve, connect, ServiceClient, ServerReadableStream, ServerDuplexStream } from "../index";
import {
    Server,
    ServerCredentials,
    credentials,
    loadPackageDefinition
} from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { deepStrictEqual } from "assert";
import { execSync } from "child_process";
import { type ChildProcess, spawn } from "child_process";
import { unlinkSync } from "fs";
import { after, before, describe, it } from "mocha";

const PROTO_PATH = __dirname + "/helloworld.proto";
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

const greeterImpl: Greeter = {
    async sayHello({ name }) {
        return { message: "Hello, " + name } as Response;
    },
    async *sayHelloStreamReply({ name }) {
        yield { message: `Hello 1: ${name}` } as Response;
        yield { message: `Hello 2: ${name}` } as Response;
        yield { message: `Hello 3: ${name}` } as Response;
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

class GreeterService implements Greeter {
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

describe("node-server <=> node-client", () => {
    let server: Server;
    let client: ServiceClient<Greeter>;

    before((done) => {
        server = new Server();

        // @ts-ignore
        serve(helloworld.Greeter, greeterImpl, server);

        server.bindAsync(addr, ServerCredentials.createInsecure(), () => {
            server.start();
            done();
        });

        // @ts-ignore
        client = connect(helloworld.Greeter, addr, credentials.createInsecure());
    });

    after(() => {
        client.close();
        server.forceShutdown();
    });

    it("should call the async function as expected", async () => {
        const result = await client.sayHello({ name: "World" });

        deepStrictEqual(result, { message: "Hello, World" });
    });

    it("should call the async generator function as expected", async () => {
        const results: Response[] = [];

        for await (const result of client.sayHelloStreamReply({ name: "World" })) {
            results.push(result);
        }

        deepStrictEqual(results, [
            { message: "Hello 1: World" },
            { message: "Hello 2: World" },
            { message: "Hello 3: World" }
        ]);
    });

    it("should make stream requests as expected", async () => {
        const call = client.sayHelloStreamRequest();

        call.write({ name: "Mr. World" });
        call.write({ name: "Mrs. World" });

        const result = await call.returns();

        deepStrictEqual(result, { message: "Hello, Mr. World, Mrs. World" });
    });

    it("should make stream requests and receive stream responses as expected", async () => {
        const call = client.sayHelloDuplex();

        call.write({ name: "Mr. World" });
        call.write({ name: "Mrs. World" });

        const results: Response[] = [];

        for await (const reply of call) {
            results.push(reply);

            if (results.length === 2) {
                call.end();
            }
        }

        deepStrictEqual(results, [
            { message: "Hello, Mr. World" },
            { message: "Hello, Mrs. World" }
        ]);
    });
});

describe("go-server <=> node-client", () => {
    let server: ChildProcess;
    let client: ServiceClient<Greeter>;

    before(function (done) {
        // Must build the go program before running it, otherwise the
        // server.kill() won"t be able to release the port, since
        // the server process isn"t the real process the start the gRPC server
        // and when the go process is killed, the real process the holds the port
        // still hangs and hangs the Node.js process as well, reason is unknown.
        this.timeout(120_000); // this could take a while for go installing dependencies
        execSync("go build main.go", { cwd: __dirname + "/go" });
        server = spawn("./main", { cwd: __dirname + "/go" });

        server.on("spawn", () => {
            // @ts-ignore
            client = connect(helloworld.Greeter, addr, credentials.createInsecure());
            done();
        }).on("error", (err) => {
            done(err);
        }).on("exit", () => {
            unlinkSync(__dirname + "/go/main");
        });
    });

    after(() => {
        client.close();
        server.kill();
    });

    it("should call the async function as expected", async function () {
        this.timeout(5000);
        const result = await client.sayHello({ name: "World" });
        deepStrictEqual(result, { message: "Hello, World" });
    });

    it("should call the async generator function as expected", async function () {
        this.timeout(5000);
        const results: Response[] = [];

        for await (const result of client.sayHelloStreamReply({ name: "World" })) {
            results.push(result);
        }

        deepStrictEqual(results, [
            { message: "Hello 1: World" },
            { message: "Hello 2: World" },
            { message: "Hello 3: World" }
        ]);
    });
});

describe("service class", () => {
    let server: Server;
    let client: ServiceClient<Greeter>;

    before((done) => {
        server = new Server();

        // @ts-ignore
        serve(helloworld.Greeter, GreeterService, server);

        server.bindAsync(addr, ServerCredentials.createInsecure(), () => {
            server.start();
            done();
        });

        // @ts-ignore
        client = connect(helloworld.Greeter, addr, credentials.createInsecure());
    });

    after(() => {
        client.close();
        server.forceShutdown();
    });

    it("should call the async function as expected", async () => {
        const result = await client.sayHello({ name: "World" });

        deepStrictEqual(result, { message: "Hello, World" });
    });

    it("should call the async generator function as expected", async () => {
        const results: Response[] = [];

        for await (const result of client.sayHelloStreamReply({ name: "World" })) {
            results.push(result);
        }

        deepStrictEqual(results, [
            { message: "Hello 1: World" },
            { message: "Hello 2: World" },
            { message: "Hello 3: World" }
        ]);
    });

    it("should make stream requests as expected", async () => {
        const call = client.sayHelloStreamRequest();

        call.write({ name: "Mr. World" });
        call.write({ name: "Mrs. World" });

        const result = await call.returns();

        deepStrictEqual(result, { message: "Hello, Mr. World, Mrs. World" });
    });

    it("should make stream requests and receive stream responses as expected", async () => {
        const call = client.sayHelloDuplex();

        call.write({ name: "Mr. World" });
        call.write({ name: "Mrs. World" });

        const results: Response[] = [];

        for await (const reply of call) {
            results.push(reply);

            if (results.length === 2) {
                call.end();
            }
        }

        deepStrictEqual(results, [
            { message: "Hello, Mr. World" },
            { message: "Hello, Mrs. World" }
        ]);
    });
});
