import type {
    ChannelCredentials,
    ChannelOptions,
    Client,
    ClientWritableStream as gClientWritableStream,
    ClientReadableStream as gClientReadableStream,
    ClientDuplexStream as gClientDuplexStream,
    ServiceClientConstructor
} from "@grpc/grpc-js";
import { DuplexFunction, StreamRequestFunction } from "./server";

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

export function connect<T extends object>(
    serviceCtor: ServiceClientConstructor,
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
                    // @ts-ignore
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
            // @ts-ignore
            newFn = (data: any, callback?: (err: unknown, reply: any) => void) => {
                if (callback) {
                    return originalFn.call(ins, data, callback);
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
