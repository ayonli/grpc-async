import {
    ChannelCredentials,
    ChannelOptions,
    Client,
    ClientWritableStream as gClientWritableStream,
    ClientReadableStream as gClientReadableStream,
    ClientDuplexStream as gClientDuplexStream,
    ServiceClientConstructor,
    Metadata,
    connectivityState
} from "@grpc/grpc-js";
import { ServerReadableStream, ServerDuplexStream } from "./server";
import { applyMagic } from "js-magic";

const NodeVersion = parseInt(process.version.slice(1));

export type ClientWritableStream<Req, Res> = gClientWritableStream<Req> & {
    returns(): Promise<Res>;
};

export type ClientReadableStream<Res> = gClientReadableStream<Res> & AsyncIterable<Res>;

export type ClientDuplexStream<Req, Res> = gClientDuplexStream<Req, Res> & AsyncIterable<Res>;

export type UnaryFunction<Req, Res> = (req: Req, metadata?: Metadata) => Promise<Res>;

export type StreamResponseFunction<Req, Res> = (req: Req, metadata?: Metadata) => AsyncGenerator<Res, void, unknown>;

export type StreamRequestFunction<Req, Res> = (stream: ServerReadableStream<Req>) => Promise<Res>;

export type DuplexFunction<Req, Res> = (stream: ServerDuplexStream<Req, Res>) => AsyncGenerator<Res, void, unknown>;

export type ClientMethods<T extends object> = {
    [K in keyof T]: T[K] extends DuplexFunction<infer Req, infer Res> ? (metadata?: Metadata) => ClientDuplexStream<Req, Res>
    : T[K] extends StreamRequestFunction<infer Req, infer Res> ? (metadata?: Metadata) => ClientWritableStream<Req, Res>
    : T[K] extends StreamResponseFunction<infer Req, infer Res> ? (req: Req, metadata?: Metadata) => AsyncGenerator<Res, void, unknown>
    : T[K] extends UnaryFunction<infer Req, infer Res> ? (req: Req, metadata?: Metadata) => Promise<Res>
    : T[K];
};

export type ServiceClient<T extends object> = Omit<Client, "waitForReady"> & {
    waitForReady(deadline?: Date | number): Promise<void>;
    waitForReady(deadline: Date | number, callback: (err: Error) => void): void;
} & ClientMethods<T>;

function captureCallStack() {
    const call: { stack?: string; } = {};
    Error.captureStackTrace(call, captureCallStack);
    return call as { stack: string };
}

function patchCallStack(err: unknown, trace: { stack: string; }) {
    if (err instanceof Error) {
        Object.defineProperty(err, "stack", {
            configurable: true,
            writable: true,
            enumerable: false,
            value: err.stack + trace.stack
        });
    }
}

export function connect<T extends object>(
    service: ServiceClientConstructor,
    address: string,
    credentials: ChannelCredentials,
    options: Partial<ChannelOptions> & { connectTimeout?: number; } = {}
) {
    const { connectTimeout = 120_000, ...rest } = options;
    const ins = new service(address, credentials, rest);

    const _waitForReady = ins.waitForReady.bind(ins);
    const waitForReady = (deadline?: Date | number, callback?: (err: Error | void) => void) => {
        deadline ??= Date.now() + connectTimeout;

        if (callback) {
            _waitForReady(deadline as Date | number, callback);
        } else {
            return new Promise<void>((resolve, reject) => {
                _waitForReady(deadline as Date | number, (err: Error | void) => {
                    err ? reject(err) : resolve();
                });
            });
        }
    };

    Object.defineProperty(ins, "waitForReady", {
        configurable: true,
        writable: true,
        enumerable: false,
        value: waitForReady,
    });

    for (const name of Object.getOwnPropertyNames(service.service)) {
        const def = service.service[name];
        const originalFn = ins[name]?.bind(ins);
        let newFn: (data?: any) => any = null as any;

        if (!originalFn)
            continue;

        if (def.requestStream) {
            if (def.responseStream) {
                newFn = function (metadata: Metadata | undefined = void 0) {
                    const call: gClientDuplexStream<any, any> = originalFn(metadata);
                    const originalIteratorFn = call[Symbol.asyncIterator].bind(call);

                    call[Symbol.asyncIterator] = async function* () {
                        try {
                            for await (const value of originalIteratorFn()) {
                                yield value;
                            }
                        } catch (err: any) {
                            if (err["metadata"] && err["code"] === 2) {
                                // When either the server or the client ends the connection in
                                // duplex mode, the default behavior of gRPC client will throw an
                                // error saying 'The operation was aborted', DON'T KNOW WHY, we
                                // should bypass this error for the sake of `for await` syntax.
                                return;
                            } else {
                                throw err;
                            }
                        }
                    };

                    if (NodeVersion < 18) {
                        // Prior to Node.js v18, `stream.end()` does't release the
                        // connection and causing the `for await` loop to hang,
                        // so we overwrite it with `stream.destroy()` at the bottom.
                        const _end = call.end;
                        call.end = (...args: any[]) => {
                            setImmediate(() => {
                                call.destroy();
                            });

                            return _end.apply(call, args);
                        };
                    }

                    return call;
                };
            } else {
                newFn = function (metadata: Metadata | undefined = void 0) {
                    let task: {
                        resolve: (reply: any) => void,
                        reject: (err: unknown) => void;
                    } = null as any;
                    let result: {
                        err: unknown,
                        reply: any;
                    } = null as any;

                    let call: gClientWritableStream<any>;

                    if (metadata) {
                        call = originalFn(metadata, (err: unknown, reply: any) => {
                            if (task) {
                                err ? task.reject(err) : task.resolve(reply);
                            } else {
                                result = { err, reply };
                            }
                        });
                    } else {
                        call = originalFn((err: unknown, reply: any) => {
                            if (task) {
                                err ? task.reject(err) : task.resolve(reply);
                            } else {
                                result = { err, reply };
                            }
                        });
                    }

                    call["returns"] = () => {
                        return new Promise<any>((resolve, reject) => {
                            if (!call.closed && !call.destroyed) {
                                call.end();
                            }

                            if (result) {
                                result.err ? reject(result.err) : resolve(result.reply);
                            } else {
                                task = { resolve, reject };
                            }
                        });
                    };

                    return call as ClientWritableStream<any, any>;
                };
            }
        } else if (def.responseStream) {
            newFn = async function* (data: any, metadata: Metadata | undefined = void 0) {
                const stack = captureCallStack();

                try {
                    await waitForReady();
                    const call: gClientReadableStream<any> = originalFn(data, metadata);

                    for await (const value of call) {
                        yield value;
                    }
                } catch (err) {
                    patchCallStack(err, stack);
                    throw err;
                }
            } as AsyncGeneratorFunction;
        } else {
            newFn = (data: any, metadata: Metadata | undefined = void 0) => {
                const stack = captureCallStack();

                return new Promise((resolve, reject) => {
                    Promise.resolve(waitForReady()).then(() => {
                        if (metadata) {
                            originalFn(data, metadata, (err: unknown, res: any) => {
                                if (err) {
                                    patchCallStack(err, stack);
                                    reject(err);
                                } else {
                                    resolve(res);
                                }
                            });
                        } else {
                            originalFn(data, (err: unknown, res: any) => {
                                if (err) {
                                    patchCallStack(err, stack);
                                    reject(err);
                                } else {
                                    resolve(res);
                                }
                            });
                        }
                    }).catch(reject);
                });
            };
        }

        if (newFn) {
            Object.defineProperty(newFn, "name", {
                configurable: true,
                writable: false,
                enumerable: false,
                value: name,
            });
            ins[name] = newFn;

            if (def.originalName) {
                Object.defineProperty(ins, def.originalName, {
                    configurable: true,
                    writable: true,
                    enumerable: false,
                    value: newFn,
                });
            }
        }
    }

    return ins as any as ServiceClient<T>;
}

export type ServerConfig = {
    address: string;
    credentials: ChannelCredentials,
    options?: Partial<ChannelOptions> & { connectTimeout?: number; };
};

/**
 * LoadBalancer gives the ability to connect to multiple servers and implement
 * custom client-side load balancing algorithms.
 */
export class LoadBalancer<T extends object, P extends any = any> {
    protected instances: { [address: string]: ServiceClient<T>; } = {};
    protected acc = 0;

    /**
     * @param target 
     * @param servers The server configurations used to create service client.
     * @param routeResolver Custom route resolver used to implement load
     *  balancing algorithms, if not provided, a default round-robin algorithm
     *  is used. The function takes a context object and returns an address
     *  filtered from the `ctx.servers`.
     */
    constructor(
        readonly service: ServiceClientConstructor,
        protected servers: ServerConfig[],
        protected routeResolver: ((ctx: {
            service: ServiceClientConstructor;
            servers: (ServerConfig & { state: connectivityState; })[];
            /**
             * The route params passed when calling the `getInstance()` function, we
             * can use this object to calculate the desired route address.
             */
            params: P | null;
            acc: number;
        }) => string) | null = null
    ) { }

    /**
     * Dynamically add server configurations at runtime, this is useful when we 
     * need to implement some kind of service discovery strategy.
     */
    addServer(server: ServerConfig) {
        if (!this.servers.some(item => item.address === server.address)) {
            this.servers.push(server);
            return true;
        } else {
            return false;
        }
    }

    /**
     * Dynamically remove server configurations at runtime, this is useful when we 
     * need to implement some kind of service discovery strategy.
     */
    removeServer(address: string) {
        if (this.servers.some(item => item.address === address)) {
            this.servers = this.servers.filter(item => item.address !== address);
            return true;
        } else {
            return false;
        }
    }

    /**
     * Retrieves an instance of the service client.
     * 
     * @param routeParams If a custom `routeResolver` is provided when initiating
     *  the load balancer, this argument will be passed to the function for route
     *  calculation, otherwise, it has no effect.
     */
    getInstance(routeParams: P | null = null): ServiceClient<T> {
        let address: string;

        if (this.routeResolver) {
            address = this.routeResolver({
                service: this.service,
                servers: this.servers.map(config => {
                    const ins = this.instances[config.address];
                    return {
                        ...config,
                        state: ins
                            ? ins.getChannel().getConnectivityState(false)
                            : connectivityState.IDLE,
                    };
                }),
                params: routeParams,
                acc: this.acc,
            });
            this.acc++;
        } else {
            const addresses = this.servers.map(config => config.address)
                .filter(address => {
                    const ins = this.instances[address];

                    if (ins) {
                        const state = ins.getChannel().getConnectivityState(false);
                        return state !== connectivityState.SHUTDOWN
                            && state !== connectivityState.TRANSIENT_FAILURE;
                    } else {
                        return true;
                    }
                });
            address = addresses[this.acc++ % addresses.length];
        }

        if (this.acc > Number.MAX_SAFE_INTEGER) {
            this.acc = 0;
        }

        if (!address) {
            throw new Error("No server address is available");
        }

        let ins = this.instances[address];

        if (!ins) {
            const config = this.servers.find(config => config.address === address);

            if (!config) {
                throw new Error("The resolve server address is invalid");
            }

            ins = connect(this.service, config.address, config.credentials, config.options);
            this.instances[address] = ins;
        }

        return ins;
    }

    /** Closes all the connection. */
    close() {
        Object.values(this.instances).forEach(ins => {
            ins.close();
        });
    }
}

export type ChainingProxyInterface = ServiceClient<any> | {
    [nsp: string]: ChainingProxyInterface;
};

/**
 * ConnectionManager provides a place to manage all service proxies and retrieve
 * instances via a general approach.
 */
export class ConnectionManager {
    protected registry = new Map<string, ServiceClient<any> | LoadBalancer<any>>();

    register(target: ServiceClient<any> | LoadBalancer<any>) {
        let name: string;

        if (target instanceof LoadBalancer) {
            name = this.getServiceFullName(target.service);
        } else {
            const ctor = target.constructor as ServiceClientConstructor;
            name = this.getServiceFullName(ctor);
        }

        if (this.registry.has(name)) {
            return false;
        } else {
            this.registry.set(name, target);
            return true;
        }
    }

    /**
     * @param target If the target is a string, it is the full name of the
     *  service (includes the package name, concatenated with `.`).
     */
    deregister(target: string | ServiceClient<any> | LoadBalancer<any>, closeConnection = false) {
        const name = this.unpackServiceFullName(target);

        if (closeConnection) {
            const balancer = this.registry.get(name);

            if (balancer) {
                balancer.close();
            } else {
                return false;
            }
        }

        return this.registry.delete(name);
    }

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
    getInstanceOf<T extends object, P extends any = any>(
        target: string | ServiceClient<T> | LoadBalancer<T>,
        routeParams: P | null = null
    ): ServiceClient<T> {
        const name = this.unpackServiceFullName(target);
        const client = this.registry.get(name);

        if (client) {
            if (client instanceof LoadBalancer) {
                return client.getInstance(routeParams);
            } else {
                return client;
            }
        } else {
            throw new ReferenceError(`service ${name} is not registered`);
        }
    }

    private getServiceFullName(ctor: ServiceClientConstructor) {
        const { service } = ctor;
        const firstMethod = Object.getOwnPropertyNames(service)[0];
        const { path } = service[firstMethod];
        return path.split("/")[1];
    }

    private unpackServiceFullName(target: string | ServiceClient<any> | LoadBalancer<any>) {
        if (typeof target === "string") {
            return target;
        } else if (target instanceof LoadBalancer) {
            return this.getServiceFullName(target.service);
        } else {
            const ctor = target.constructor as ServiceClientConstructor;
            return this.getServiceFullName(ctor);
        }
    }

    /** Closes all the connections of all proxies. */
    close() {
        this.registry.forEach(balancer => {
            balancer.close();
        });
    }

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
    useChainingSyntax(rootNsp = "") {
        return new ChainingProxy(rootNsp, this) as any as ChainingProxyInterface;
    }
}

@applyMagic
class ChainingProxy {
    protected __target: string;
    protected __manager: ConnectionManager;
    protected __children: { [prop: string]: ChainingProxy; } = {};

    constructor(target: string, manager: ConnectionManager) {
        this.__target = target;
        this.__manager = manager;
    }

    protected __get(prop: string | symbol) {
        if (prop in this) {
            return this[prop];
        } else if (prop in this.__children) {
            return this.__children[String(prop)];
        } else if (typeof prop !== "symbol") {
            return (this.__children[prop] = createChainingProxy(
                (this.__target ? this.__target + "." : "") + String(prop),
                this.__manager
            ));
        }
    }

    protected __has(prop: string | symbol) {
        return (prop in this) || (prop in this.__children);
    }
}

function createChainingProxy(target: string, manager: ConnectionManager) {
    const chain: ChainingProxy = function (data: any = null) {
        const index = target.lastIndexOf(".");
        const serviceName = target.slice(0, index);
        const method = target.slice(index + 1);
        const ins = manager.getInstanceOf(serviceName, data);

        if (typeof ins[method] === "function") {
            return ins[method](data);
        } else {
            throw new TypeError(`${target} is not a function`);
        }
    } as any;

    Object.setPrototypeOf(chain, ChainingProxy.prototype);
    Object.assign(chain, { __target: target, __manager: manager, __children: {} });

    return applyMagic(chain as any, true);
}
