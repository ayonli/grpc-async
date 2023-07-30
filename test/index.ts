import { deepStrictEqual, ok, strictEqual } from "assert";
import { execSync } from "child_process";
import { type ChildProcess, spawn } from "child_process";
import { unlinkSync } from "fs";
import { after, before, describe, it } from "mocha";
import { Server, ServerCredentials, credentials } from "@grpc/grpc-js";
import {
    serve,
    connect,
    ServiceClient,
    unserve,
    ServiceProxy,
    ConnectionManager
} from "../index";
import { SERVER_ADDRESS, helloworld, Request, Response } from "../examples/traditional";
import { Greeter, GreeterStaticImpl } from "../examples/async";
import { GreeterService } from "../examples/class";
import _try from "dotry";

describe("node-server <=> node-client", () => {
    let server: Server;
    let client: ServiceClient<Greeter>;

    before((done) => {
        server = new Server();

        // @ts-ignore
        serve(helloworld.Greeter, GreeterStaticImpl, server);

        server.bindAsync(SERVER_ADDRESS, ServerCredentials.createInsecure(), () => {
            server.start();
            done();
        });

        // @ts-ignore
        client = connect(helloworld.Greeter, SERVER_ADDRESS, credentials.createInsecure());
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
            client = connect(helloworld.Greeter, SERVER_ADDRESS, credentials.createInsecure());
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

describe("service class", () => {
    let server: Server;
    let client: ServiceClient<Greeter>;

    before((done) => {
        server = new Server();

        // @ts-ignore
        serve(helloworld.Greeter, GreeterService, server);

        server.bindAsync(SERVER_ADDRESS, ServerCredentials.createInsecure(), () => {
            server.start();
            done();
        });

        // @ts-ignore
        client = connect(helloworld.Greeter, SERVER_ADDRESS, credentials.createInsecure());
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

    describe("reload service", () => {
        class NewGreeterService extends GreeterService {
            async sayHello({ name }: Request): Promise<Response> {
                return { message: "Hi, " + name };
            }
        }

        before(() => {
            // @ts-ignore
            unserve(helloworld.Greeter, server);
            // @ts-ignore
            serve(helloworld.Greeter, NewGreeterService, server);
        });

        after(() => {
            client.close();
            server.forceShutdown();
        });

        it("should call the async function as expected", async () => {
            const result = await client.sayHello({ name: "World" });

            deepStrictEqual(result, { message: "Hi, World" });
        });
    });
});

describe("ServiceProxy", () => {
    const addresses = [
        "localhost:50051",
        "localhost:50052",
        "localhost:50053"
    ];
    let servers: Server[] = [];

    class GreeterService1 extends GreeterService {
        async sayHello({ name }: Request) {
            return { message: "Hello, " + name + ". I'm server 1" } as Response;
        }
    }

    class GreeterService2 extends GreeterService {
        async sayHello({ name }: Request) {
            return { message: "Hello, " + name + ". I'm server 2" } as Response;
        }
    }

    class GreeterService3 extends GreeterService {
        async sayHello({ name }: Request) {
            return { message: "Hello, " + name + ". I'm server 3" } as Response;
        }
    }

    before(async () => {
        for (let i = 0; i < addresses.length; i++) {
            const addr = addresses[i];
            const server = new Server();

            if (i === 0) {
                // @ts-ignore
                serve(helloworld.Greeter, GreeterService1, server);
            } else if (i === 1) {
                // @ts-ignore
                serve(helloworld.Greeter, GreeterService2, server);
            } else if (i === 2) {
                // @ts-ignore
                serve(helloworld.Greeter, GreeterService3, server);
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
        const proxy = new ServiceProxy<Greeter>({
            package: "helloworld",
            // @ts-ignore
            service: helloworld.Greeter
        }, addresses.map(address => ({
            address,
            credentials: credentials.createInsecure(),
        })));

        const result1 = await proxy.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result1, { message: "Hello, World. I'm server 1" });

        const result2 = await proxy.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result2, { message: "Hello, World. I'm server 2" });

        const result3 = await proxy.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result3, { message: "Hello, World. I'm server 3" });

        proxy.close();
    });

    it("should balance the load via a custom route resolver", async () => {
        const proxy = new ServiceProxy<Greeter>({
            package: "helloworld",
            // @ts-ignore
            service: helloworld.Greeter
        }, addresses.map(address => ({
            address,
            credentials: credentials.createInsecure(),
        })), ({ servers, params }) => {
            if (params?.name === "Mr. World") {
                return servers[0].address;
            } else {
                return servers[1].address;
            }
        });

        const req1: Request = { name: "Mr. World" };
        const result1 = await proxy.getInstance(req1).sayHello(req1);
        deepStrictEqual(result1, { message: "Hello, Mr. World. I'm server 1" });

        const req2: Request = { name: "Mr. World" };
        const result2 = await proxy.getInstance(req2).sayHello(req2);
        deepStrictEqual(result2, { message: "Hello, Mr. World. I'm server 1" });

        const req3: Request = { name: "Mrs. World" };
        const result3 = await proxy.getInstance(req3).sayHello(req3);
        deepStrictEqual(result3, { message: "Hello, Mrs. World. I'm server 2" });

        proxy.close();
    });

    it("should dynamically add and remove server as expected", async () => {
        const proxy = new ServiceProxy<Greeter>({
            package: "helloworld",
            // @ts-ignore
            service: helloworld.Greeter
        }, addresses.map(address => ({
            address,
            credentials: credentials.createInsecure(),
        })));

        const result1 = await proxy.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result1, { message: "Hello, World. I'm server 1" });

        const result2 = await proxy.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result2, { message: "Hello, World. I'm server 2" });

        const result3 = await proxy.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result3, { message: "Hello, World. I'm server 3" });

        const server = new Server();
        const address = "localhost:50054";
        // @ts-ignore
        serve(helloworld.Greeter, GreeterService, server);
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

        proxy.addServer(address, credentials.createInsecure());

        const result4 = await proxy.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result4, { message: "Hello, World" });

        proxy.removeServer(address);

        const result5 = await proxy.getInstance().sayHello({ name: "World" });
        deepStrictEqual(result5, { message: "Hello, World. I'm server 2" });

        proxy.close();
    });

    describe("ConnectionManager", () => {
        const manager = new ConnectionManager();

        it("should register proxy as expected", async () => {
            const proxy = new ServiceProxy<Greeter>({
                package: "helloworld",
                // @ts-ignore
                service: helloworld.Greeter
            }, addresses.map(address => ({
                address,
                credentials: credentials.createInsecure(),
            })));

            ok(manager.register(proxy));
            ok(!manager.register(proxy));

            const name = proxy.packageName + "." + proxy.serviceCtor.serviceName;
            strictEqual(name, "helloworld.Greeter");

            const ins1 = manager.getInstanceOf(proxy);
            const result1 = await ins1?.sayHello({ name: "World" });
            deepStrictEqual(result1, { message: "Hello, World. I'm server 1" });

            const ins2 = manager.getInstanceOf<Greeter>(name);
            const result2 = await ins2?.sayHello({ name: "World" });
            deepStrictEqual(result2, { message: "Hello, World. I'm server 2" });

            const [err1] = _try(() => manager.getInstanceOf("foo.Greeter"));
            strictEqual(String(err1), "ReferenceError: service foo.Greeter is not registered");

            ok(manager.deregister(name));
            ok(!manager.deregister(proxy));

            const [err2] = _try(() => manager.getInstanceOf(name));
            strictEqual(String(err2), "ReferenceError: service helloworld.Greeter is not registered");

            manager.close();
        });

        it("should use chaining syntax as expected", async () => {
            const proxy = new ServiceProxy<Greeter>({
                package: "helloworld",
                // @ts-ignore
                service: helloworld.Greeter
            }, addresses.map(address => ({
                address,
                credentials: credentials.createInsecure(),
            })));
            manager.register(proxy);

            const services = manager.useChainingSyntax();

            // @ts-ignore
            const ins = services.helloworld.Greeter() as ServiceClient<Greeter>;
            const result1 = await ins.sayHello({ name: "World" });
            deepStrictEqual(result1, { message: "Hello, World. I'm server 1" });
        });
    });
});
