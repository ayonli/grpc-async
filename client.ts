import {
    ChannelCredentials,
    ChannelOptions,
    Client,
    ClientWritableStream as gClientWritableStream,
    ClientReadableStream as gClientReadableStream,
    ClientDuplexStream as gClientDuplexStream,
    connectivityState,
    ServiceDefinition
} from "@grpc/grpc-js";
import { DuplexFunction, StreamRequestFunction } from "./server";

const NodeVersion = parseInt(process.version.slice(1));

export type ClientWritableStream<Req, Res> = gClientWritableStream<Req> & {
    returns(): Promise<Res>;
};

export type ClientReadableStream<Res> = gClientReadableStream<Res> & AsyncIterable<Res>;

export type ClientDuplexStream<Req, Res> = gClientDuplexStream<Req, Res> & AsyncIterable<Res>;

export type WrapMethods<T extends object> = {
    [K in keyof T]: T[K] extends StreamRequestFunction<infer Req, infer Res> ? () => ClientWritableStream<Req, Res>
    : T[K] extends DuplexFunction<infer Req, infer Res> ? () => ClientDuplexStream<Req, Res>
    : T[K];
};

export type ServiceClient<T extends object> = Omit<Client, "waitForReady"> & {
    waitForReady(deadline?: Date | number): Promise<void>;
    waitForReady(deadline: Date | number, callback: (err: Error) => void): void;
} & WrapMethods<T>;

export interface ServiceClientConstructor<T extends object> {
    new(address: string, credentials: ChannelCredentials, options?: Partial<ChannelOptions>): ServiceClient<T>;
    service: ServiceDefinition;
    serviceName: string;
}

export function connect<T extends object>(
    serviceCtor: ServiceClientConstructor<T>,
    address: string,
    credentials: ChannelCredentials,
    options: Partial<ChannelOptions> & { connectTimeout?: number; } = {}
) {
    const { connectTimeout = 120_000, ...rest } = options;
    const ins = new serviceCtor(address, credentials, rest);

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

    Object.assign(ins, { waitForReady });

    for (const name of Object.getOwnPropertyNames(serviceCtor.service)) {
        const def = serviceCtor.service[name];
        const fnName = def.originalName || name;
        const originalFn = ins[fnName]?.bind(ins);
        let newFn: (data?: any) => any = null as any;

        if (!originalFn)
            continue;

        if (def.requestStream) {
            if (def.responseStream) {
                newFn = function () {
                    const call: gClientDuplexStream<any, any> = originalFn();
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
                newFn = function () {
                    let task: {
                        resolve: (reply: any) => void,
                        reject: (err: unknown) => void;
                    } = null as any;
                    let result: {
                        err: unknown,
                        reply: any;
                    } = null as any;

                    const call: gClientWritableStream<any> = originalFn((err: unknown, reply: any) => {
                        if (task) {
                            err ? task.reject(err) : task.resolve(reply);
                        } else {
                            result = { err, reply };
                        }
                    });
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
            newFn = async function* (data: any) {
                await waitForReady();
                const call: gClientReadableStream<any> = originalFn(data);

                for await (const value of call) {
                    yield value;
                }
            } as AsyncGeneratorFunction;
        } else {
            newFn = (data: any, callback?: (err: unknown, reply: any) => void) => {
                if (callback) {
                    waitForReady(void 0, (err) => {
                        if (err) {
                            callback(err, void 0);
                        } else {
                            originalFn.call(ins, data, callback);
                        }
                    });
                } else {
                    return new Promise((resolve, reject) => {
                        Promise.resolve(waitForReady()).then(() => {
                            originalFn.call(ins, data, (err: unknown, res: any) => {
                                if (err) {
                                    reject(err);
                                } else {
                                    resolve(res);
                                }
                            });
                        }).catch(reject);
                    });
                }
            };
        }

        ins[fnName] = newFn ?? originalFn;
    }

    return ins as any as ServiceClient<T>;
}

/**
 * ServiceProxy gives the ability to connect to multiple servers and implement
 * custom client-side load balancing algorithms.
 */
export class ServiceProxy<T extends object> {
    readonly packageName: string;
    readonly serviceCtor: ServiceClientConstructor<T>;
    protected instances: { [address: string]: ServiceClient<T>; } = {};
    protected acc = 0;

    /**
     * 
     * @param target 
     * @param servers The server configurations used to create service client.
     * @param routeResolver Custom route resolver used to implement load
     *  balancing algorithms, if not provided, a default round-robin algorithm
     *  is used. The function takes a context object and returns an address
     *  filtered from the `ctx.servers`.
     */
    constructor(target: {
        package: string;
        service: ServiceClientConstructor<T>;
    }, protected servers: {
        address: string;
        credentials: ChannelCredentials,
        options?: Partial<ChannelOptions> & { connectTimeout?: number; };
    }[], protected routeResolver: ((ctx: {
        servers: { address: string, state: connectivityState; }[];
        package: string;
        service: ServiceClientConstructor<T>;
        /**
         * The route params passed when calling the `getInstance()` function, we
         * can use this object to calculate the desired route address.
         */
        params: any;
        acc: number;
    }) => string) | null = null) {
        this.packageName = target.package;
        this.serviceCtor = target.service;
    }

    /**
     * Dynamically add server configurations at runtime, this is useful when we 
     * need to implement some kind of service discovery strategy.
     */
    addServer(
        address: string,
        credentials: ChannelCredentials,
        options: Partial<ChannelOptions> & { connectTimeout?: number; } | undefined = void 0
    ) {
        if (!this.servers.some(item => item.address === address)) {
            this.servers.push({
                address,
                credentials,
                options,
            });
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
     * @param routeParams If a custom `routeResolver` is provided when initiating
     *  the proxy, this argument will be passed to the function for route
     *  calculation, otherwise, it has no effect.
     * @returns 
     */
    getInstance(routeParams: any = null): ServiceClient<T> {
        let address: string;

        if (this.routeResolver) {
            address = this.routeResolver({
                servers: this.servers.map(({ address }) => {
                    const ins = this.instances[address];
                    return {
                        address,
                        state: ins
                            ? ins.getChannel().getConnectivityState(false)
                            : connectivityState.IDLE
                    };
                }),
                package: this.packageName,
                service: this.serviceCtor,
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

            ins = connect(this.serviceCtor, config.address, config.credentials, config.options);
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

/**
 * ConnectionManager provides a place to manage all service proxies and retrieve
 * instances via a general approach.
 */
export class ConnectionManager {
    protected registry = new Map<string, ServiceProxy<any>>();

    register(proxy: ServiceProxy<any>) {
        const name = proxy.packageName + "." + proxy.serviceCtor.serviceName;

        if (this.registry.has(name)) {
            return false;
        } else {
            this.registry.set(name, proxy);
            return true;
        }
    }

    /**
     * 
     * @param target If the target is a string, it is the full name of the
     *  service (includes the package name, concatenated with `.`).
     * @returns 
     */
    deregister(target: string | ServiceProxy<any>, closeConnection = false) {
        const { packageName, serviceName } = this.destructPackageAndServiceNames(target);
        const name = packageName + "." + serviceName;

        if (closeConnection) {
            const proxy = this.registry.get(name);

            if (proxy) {
                proxy.close();
            } else {
                return false;
            }
        }

        return this.registry.delete(name);
    }

    /**
     * 
     * @param target If the target is a string, it is the full name of the
     *  service (includes the package name, concatenated with `.`).
     * @param routeParams If a custom `routeResolver` is provided when initiating
     *  the proxy, this argument will be passed to the function for route
     *  calculation, otherwise, it has no effect.
     * @throws If the target service is not registered, a ReferenceError will be
     *  thrown.
     */
    getInstanceOf<T extends object>(
        target: string | ServiceProxy<T>,
        routeParams: any = null
    ): ServiceClient<T> {
        const { packageName, serviceName } = this.destructPackageAndServiceNames(target);
        const name = packageName + "." + serviceName;
        const proxy = this.registry.get(name);

        if (proxy) {
            return proxy.getInstance(routeParams);
        } else {
            throw new ReferenceError(`service ${name} is not registered`);
        }
    }

    private destructPackageAndServiceNames(target: string | ServiceProxy<any>) {
        let packageName: string;
        let serviceName: string;

        if (typeof target === "string") {
            let index = target.lastIndexOf(".");

            if (index <= 0 || index === target.length - 1) {
                throw new TypeError("Invalid service name");
            } else {
                packageName = target.slice(0, index);
                serviceName = target.slice(index + 1);
            }
        } else {
            packageName = target.packageName;
            serviceName = target.serviceCtor.serviceName;
        }

        return { packageName, serviceName };
    }

    /**
     * Closes all the connections of all proxies.
     */
    close() {
        this.registry.forEach(proxy => {
            proxy.close();
        });
    }
}
