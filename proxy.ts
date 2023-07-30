import { ServiceClient, connect } from "./client";
import {
    ChannelCredentials,
    ChannelOptions,
    connectivityState,
    ServiceClientConstructor
} from "@grpc/grpc-js";
import { applyMagic } from "js-magic";

export type ServiceProxyOf<T extends object> = (routeParams?: any) => ServiceClient<T>;

export type ChainingProxyInterface = ServiceProxyOf<any> & {
    [nsp: string]: ChainingProxyInterface;
};

/**
 * ServiceProxy gives the ability to connect to multiple servers and implement
 * custom client-side load balancing algorithms.
 */
export class ServiceProxy<T extends object> {
    readonly packageName: string;
    readonly serviceCtor: ServiceClientConstructor;
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
        service: ServiceClientConstructor;
    }, protected servers: {
        address: string;
        credentials: ChannelCredentials,
        options?: Partial<ChannelOptions> & { connectTimeout?: number; };
    }[], protected routeResolver: ((ctx: {
        servers: { address: string, state: connectivityState; }[];
        package: string;
        service: ServiceClientConstructor;
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

    /**
     * Instead of calling `#getInstanceOf()` to retrieve the service proxy, this
     * function allows us to use chaining syntax to dynamically generated
     * namespaces and proxy constructors that can be used as a syntax sugar.
     * @example
     *  // Instead of this:
     *  const ins = manager.getInstanceOf<Greeter>("examples.Greeter");
     * 
     *  // We do this:
     *  const services = manager.useChainingSyntax();
     *  const ins = services.examples.Greeter();
     */
    useChainingSyntax() {
        return new ChainingProxy("", this) as any as ChainingProxyInterface;
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
    const chain: ChainingProxy = function (routeParams: any = null) {
        return manager.getInstanceOf(target, routeParams);
    } as any;

    Object.setPrototypeOf(chain, ChainingProxy.prototype);
    Object.assign(chain, { __target: target, __manager: manager, __children: {} });

    return applyMagic(chain as any, true);
}

