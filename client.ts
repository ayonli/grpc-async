import {
    ChannelCredentials,
    ChannelOptions,
    Client,
    ClientWritableStream as gClientWritableStream,
    ClientReadableStream as gClientReadableStream,
    ClientDuplexStream as gClientDuplexStream,
    ServiceClientConstructor,
    Metadata
} from "@grpc/grpc-js";
import { ServerReadableStream, ServerDuplexStream } from "./server";

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
                await waitForReady();
                const call: gClientReadableStream<any> = originalFn(data, metadata);

                for await (const value of call) {
                    yield value;
                }
            } as AsyncGeneratorFunction;
        } else {
            newFn = (data: any, metadata: Metadata | undefined = void 0) => {
                return new Promise((resolve, reject) => {
                    Promise.resolve(waitForReady()).then(() => {
                        if (metadata) {
                            originalFn(data, metadata, (err: unknown, res: any) => {
                                if (err) {
                                    reject(err);
                                } else {
                                    resolve(res);
                                }
                            });
                        } else {
                            originalFn(data, (err: unknown, res: any) => {
                                if (err) {
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
