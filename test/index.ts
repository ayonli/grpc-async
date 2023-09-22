import { deepStrictEqual, ok, strictEqual } from "assert";
import { execSync } from "child_process";
import { type ChildProcess, spawn } from "child_process";
import { unlinkSync } from "fs";
import { after, before, describe, it } from "mocha";
import { Server, ServerCredentials, credentials, ServiceClientConstructor, Metadata } from "@grpc/grpc-js";
import {
    serve,
    connect,
    ServiceClient,
    unserve,
    LoadBalancer,
    ConnectionManager
} from "../index";
import { SERVER_ADDRESS, examples, Request, Response } from "../examples/traditional";
import { Greeter } from "../examples/async";
import { _try } from "@ayonli/jsext";

describe("node-server <=> node-client", () => {
    let server: Server;
    let client: ServiceClient<Greeter>;

    before((done) => {
        server = new Server();

        serve(server, examples.Greeter as ServiceClientConstructor, new Greeter());

        server.bindAsync(SERVER_ADDRESS, ServerCredentials.createInsecure(), () => {
            server.start();
            done();
        });

        client = connect(
            examples.Greeter as ServiceClientConstructor,
            SERVER_ADDRESS,
            credentials.createInsecure());
    });

    after(() => {
        client.close();
        server.forceShutdown();
    });

    it("should call the async function as expected", async () => {
        const result = await client.sayHello({ name: "World" });
        deepStrictEqual(result, { message: "Hello, World" });
    });

    it("should call the async function with metadata", async () => {
        const metadata = new Metadata();
        metadata.set("foo", "bar");

        const result = await client.sayHello({ name: "World" }, metadata);
        deepStrictEqual(result, { message: "Hello, World with { foo: bar }" });
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

    it("should call the async generator function with metadata", async () => {
        const results: Response[] = [];
        const metadata = new Metadata();
        metadata.set("foo", "bar");

        for await (const result of client.sayHelloStreamReply({ name: "World" }, metadata)) {
            results.push(result);
        }

        deepStrictEqual(results, [
            { message: "Hello 1: World with { foo: bar }" },
            { message: "Hello 2: World with { foo: bar }" },
            { message: "Hello 3: World with { foo: bar }" }
        ]);
    });

    it("should make stream requests as expected", async () => {
        const call = client.sayHelloStreamRequest();

        call.write({ name: "Mr. World" });
        call.write({ name: "Mrs. World" });

        const result = await call.returns();
        deepStrictEqual(result, { message: "Hello, Mr. World, Mrs. World" });
    });

    it("should make stream requests with metadata", async () => {
        const metadata = new Metadata();
        metadata.set("foo", "bar");

        const call = client.sayHelloStreamRequest(metadata);

        call.write({ name: "Mr. World" });
        call.write({ name: "Mrs. World" });

        const result = await call.returns();
        deepStrictEqual(result, { message: "Hello, Mr. World, Mrs. World with { foo: bar }" });
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

    it("should make stream requests and receive stream responses with metadata", async () => {
        const metadata = new Metadata();
        metadata.set("foo", "bar");
        const call = client.sayHelloDuplex(metadata);

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
            { message: "Hello, Mr. World with { foo: bar }" },
            { message: "Hello, Mrs. World with { foo: bar }" }
        ]);
    });

    describe("reload service", () => {
        class NewGreeter extends Greeter {
            override async sayHello({ name }: Request): Promise<Response> {
                return { message: "Hi, " + name };
            }
        }

        before(() => {
            unserve(server, examples.Greeter as ServiceClientConstructor);
            serve(server, examples.Greeter as ServiceClientConstructor, new NewGreeter());
        });

        after(() => {
            client.close();
            server.forceShutdown();
        });

        it("should call the new function as expected", async () => {
            const result = await client.sayHello({ name: "World" });

            deepStrictEqual(result, { message: "Hi, World" });
        });
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
        execSync("go build main.go", { cwd: __dirname });
        server = spawn(__dirname + "/main");

        server.on("spawn", () => {
            client = connect(
                examples.Greeter as ServiceClientConstructor,
                SERVER_ADDRESS,
                credentials.createInsecure());
            done();
        }).on("error", (err) => {
            done(err);
        }).on("exit", () => {
            unlinkSync(__dirname + "/main");
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

const addresses = [
    "localhost:50051",
    "localhost:50052",
    "localhost:50053"
];

class Greeter1 extends Greeter {
    override async sayHello({ name }: Request) {
        return { message: "Hello, " + name + ". I'm server 1" } as Response;
    }
}

class Greeter2 extends Greeter {
    override async sayHello({ name }: Request) {
        return { message: "Hello, " + name + ". I'm server 2" } as Response;
    }
}

class Greeter3 extends Greeter {
    override async sayHello({ name }: Request) {
        return { message: "Hello, " + name + ". I'm server 3" } as Response;
    }
}

describe("LoadBalancer", () => {
    let servers: Server[] = [];

    before(async () => {
        for (let i = 0; i < addresses.length; i++) {
            const addr = addresses[i] as string;
            const server = new Server();

            if (i === 0) {
                serve(server, examples.Greeter as ServiceClientConstructor, new Greeter1());
            } else if (i === 1) {
                serve(server, examples.Greeter as ServiceClientConstructor, new Greeter2());
            } else if (i === 2) {
                serve(server, examples.Greeter as ServiceClientConstructor, new Greeter3());
            }

            await new Promise<void>((resolve, reject) => {
                server.bindAsync(addr, ServerCredentials.createInsecure(), (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        server.start();
                        resolve();
                    }
                });
            });

            servers.push(server);
        }

    });

    after(() => {
        servers.forEach(server => {
            server.forceShutdown();
        });
    });

    it("should balance the load as expected", async () => {
        const balancer = new LoadBalancer<Greeter>(
            examples.Greeter as ServiceClientConstructor,
            addresses.map(address => ({
                address,
                credentials: credentials.createInsecure(),
            }))
        );

        const result1 = await balancer.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result1, { message: "Hello, World. I'm server 1" });

        const result2 = await balancer.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result2, { message: "Hello, World. I'm server 2" });

        const result3 = await balancer.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result3, { message: "Hello, World. I'm server 3" });

        balancer.close();
    });

    it("should balance the load via a custom route resolver", async () => {
        const balancer = new LoadBalancer<Greeter, Request>(
            examples.Greeter as ServiceClientConstructor,
            addresses.map(address => ({
                address,
                credentials: credentials.createInsecure(),
            })),
            ({ servers, params }) => {
                if (params?.name === "Mr. World") {
                    return servers[0]!.address;
                } else {
                    return servers[1]!.address;
                }
            }
        );

        const req1: Request = { name: "Mr. World" };
        const result1 = await balancer.getInstance(req1).sayHello(req1);
        deepStrictEqual(result1, { message: "Hello, Mr. World. I'm server 1" });

        const req2: Request = { name: "Mr. World" };
        const result2 = await balancer.getInstance(req2).sayHello(req2);
        deepStrictEqual(result2, { message: "Hello, Mr. World. I'm server 1" });

        const req3: Request = { name: "Mrs. World" };
        const result3 = await balancer.getInstance(req3).sayHello(req3);
        deepStrictEqual(result3, { message: "Hello, Mrs. World. I'm server 2" });

        balancer.close();
    });

    it("should dynamically add and remove server as expected", async () => {
        const balancer = new LoadBalancer<Greeter>(
            examples.Greeter as ServiceClientConstructor,
            addresses.map(address => ({
                address,
                credentials: credentials.createInsecure(),
            }))
        );

        const result1 = await balancer.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result1, { message: "Hello, World. I'm server 1" });

        const result2 = await balancer.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result2, { message: "Hello, World. I'm server 2" });

        const result3 = await balancer.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result3, { message: "Hello, World. I'm server 3" });

        const server = new Server();
        const address = "localhost:50054";
        serve(server, examples.Greeter as ServiceClientConstructor, new Greeter());
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.bindAsync(address, ServerCredentials.createInsecure(), (err) => {
                if (err) {
                    reject(err);
                } else {
                    server.start();
                    resolve();
                }
            });
        });

        balancer.addServer({ address, credentials: credentials.createInsecure() });

        const result4 = await balancer.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result4, { message: "Hello, World" });

        balancer.removeServer(address);

        const result5 = await balancer.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result5, { message: "Hello, World. I'm server 2" });

        balancer.close();
    });
});

describe("ConnectionManager", () => {
    let servers: Server[] = [];

    before(async () => {
        for (let i = 0; i < addresses.length; i++) {
            const addr = addresses[i] as string;
            const server = new Server();

            if (i === 0) {
                serve(server, examples.Greeter as ServiceClientConstructor, new Greeter1());
            } else if (i === 1) {
                serve(server, examples.Greeter as ServiceClientConstructor, new Greeter2());
            } else if (i === 2) {
                serve(server, examples.Greeter as ServiceClientConstructor, new Greeter3());
            }

            await new Promise<void>((resolve, reject) => {
                server.bindAsync(addr, ServerCredentials.createInsecure(), (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        server.start();
                        resolve();
                    }
                });
            });

            servers.push(server);
        }

    });

    after(() => {
        servers.forEach(server => {
            server.forceShutdown();
        });
    });

    it("should register a client as expected", async () => {
        const manager = new ConnectionManager();
        const client = connect<Greeter>(
            examples.Greeter as ServiceClientConstructor,
            SERVER_ADDRESS,
            credentials.createInsecure());

        ok(manager.register(client));
        ok(!manager.register(client));

        const ins = manager.getInstanceOf(client);
        const result1 = await ins?.sayHello({ name: "World" });
        deepStrictEqual(result1, { message: "Hello, World. I'm server 1" });

        const [err1] = _try(() => manager.getInstanceOf("foo.Greeter"));
        strictEqual(String(err1), "ReferenceError: service foo.Greeter is not registered");

        ok(manager.deregister("examples.Greeter"));
        ok(!manager.deregister(client));

        const [err2] = _try(() => manager.getInstanceOf<Greeter>("examples.Greeter"));
        strictEqual(String(err2), "ReferenceError: service examples.Greeter is not registered");

        manager.close();
    });

    it("should register a load balancer as expected", async () => {
        const manager = new ConnectionManager();
        const balancer = new LoadBalancer<Greeter>(
            examples.Greeter as ServiceClientConstructor,
            addresses.map(address => ({
                address,
                credentials: credentials.createInsecure(),
            }))
        );

        ok(manager.register(balancer));
        ok(!manager.register(balancer));

        const ins1 = manager.getInstanceOf(balancer);
        const result1 = await ins1?.sayHello({ name: "World" });
        deepStrictEqual(result1, { message: "Hello, World. I'm server 1" });

        const ins2 = manager.getInstanceOf<Greeter>("examples.Greeter");
        const result2 = await ins2?.sayHello({ name: "World" });
        deepStrictEqual(result2, { message: "Hello, World. I'm server 2" });

        const [err1] = _try(() => manager.getInstanceOf("foo.Greeter"));
        strictEqual(String(err1), "ReferenceError: service foo.Greeter is not registered");

        ok(manager.deregister("examples.Greeter"));
        ok(!manager.deregister(balancer));

        const [err2] = _try(() => manager.getInstanceOf<Greeter>("examples.Greeter"));
        strictEqual(String(err2), "ReferenceError: service examples.Greeter is not registered");

        manager.close();
    });

    it("should use chaining syntax for the client", async () => {
        const manager = new ConnectionManager();
        const client = connect<Greeter>(
            examples.Greeter as ServiceClientConstructor,
            SERVER_ADDRESS,
            credentials.createInsecure());
        manager.register(client);

        // @ts-ignore
        global["services"] = manager.useChainingSyntax();

        const result = await services.examples.Greeter.sayHello({ name: "World" });
        deepStrictEqual(result, { message: "Hello, World. I'm server 1" });

        manager.close();
    });

    it("should use chaining syntax for the load balancer", async () => {
        const manager = new ConnectionManager();
        const balancer = new LoadBalancer<Greeter>(
            examples.Greeter as ServiceClientConstructor,
            addresses.map(address => ({
                address,
                credentials: credentials.createInsecure(),
            }))
        );
        manager.register(balancer);

        // @ts-ignore
        global["services"] = manager.useChainingSyntax();

        const result = await services.examples.Greeter.sayHello({ name: "World" });
        deepStrictEqual(result, { message: "Hello, World. I'm server 1" });

        manager.close();
    });

    it("should use chaining syntax with a root namespace", async () => {
        const manager = new ConnectionManager();
        const client = connect<Greeter>(
            examples.Greeter as ServiceClientConstructor,
            SERVER_ADDRESS,
            credentials.createInsecure());
        manager.register(client);

        const _examples = manager.useChainingSyntax("examples");

        const result = await (_examples.Greeter as ServiceClient<Greeter>).sayHello({ name: "World" });
        deepStrictEqual(result, { message: "Hello, World. I'm server 1" });

        manager.close();
    });
});

declare global {
    namespace services.examples {
        const Greeter: ServiceClient<Greeter>;
    }
}
