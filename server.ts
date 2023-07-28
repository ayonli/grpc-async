import type {
    MethodDefinition,
    Server,
    ServerUnaryCall,
    ServerWritableStream as gServerWritableStream,
    ServerReadableStream as gServerReadableStream,
    ServerDuplexStream as gServerDuplexStream,
    ServiceClientConstructor,
    ServiceDefinition
} from "@grpc/grpc-js";

const AsyncGeneratorFunction = (async function* () { }).constructor;
const GeneratorFunction = (function* () { }).constructor;

export type ServerWritableStream<Req, Res> = gServerWritableStream<Req, Res>;

export type ServerReadableStream<Req, Res = void> = gServerReadableStream<Req, Res> & AsyncIterable<Req>;

export type ServerDuplexStream<Req, Res> = gServerDuplexStream<Req, Res> & AsyncIterable<Req>;

export type StreamRequestFunction<Req, Res> = (stream: ServerReadableStream<Req>) => Promise<Res>;

export type DuplexFunction<Req, Res> = (stream: ServerDuplexStream<Req, Res>) => AsyncGenerator<Res, void, unknown>;

export function serve<T extends object>(
    service: ServiceClientConstructor | ServiceDefinition<T>,
    impl: T | (new () => T),
    server: Server
) {
    const implementations: { [name: string]: (data?: any) => any; } = {};
    let _service: ServiceDefinition<any>;
    let ins: any;

    if (typeof impl === "function") {
        ins = new impl();
    } else {
        ins = impl;
    }

    if (service instanceof Function && service.service && service.serviceName) {
        _service = service.service;
    } else {
        _service = service as ServiceDefinition<T>;
    }

    for (const name of Object.getOwnPropertyNames(_service)) {
        const def: MethodDefinition<any, any> = _service[name];
        let originalFn: (data?: any) => any = null as any;
        let newFn: (call: any, callback?: (err: unknown, result: any) => void) => void = null as any;
        let fnName: string;

        if (def.originalName) {
            originalFn = (ins[def.originalName] as Function)?.bind(ins) as any;
            fnName = def.originalName;
        } else {
            originalFn = (ins[name] as Function)?.bind(ins) as any;
            fnName = name;
        }

        if (!originalFn)
            continue;

        if (def.responseStream) {
            const isGenFn = originalFn instanceof AsyncGeneratorFunction
                || originalFn instanceof GeneratorFunction;

            if (isGenFn && def.requestStream) {
                newFn = async (stream: gServerDuplexStream<any, any>) => {
                    for await (const value of originalFn(stream)) {
                        stream.write(value);
                    }

                    stream.end();
                };
            } else if (isGenFn) {
                newFn = async (stream: gServerWritableStream<any, any>) => {
                    for await (const value of originalFn(stream.request)) {
                        stream.write(value);
                    }

                    stream.end();
                };
            }
        } else if (def.requestStream) {
            if (originalFn.length === 1) {
                newFn = (stream: gServerReadableStream<any, any>, callback) => {
                    Promise.resolve(originalFn(stream))
                        .then(result => callback!(null, result))
                        .catch(err => callback!(err, void 0));
                };
            }
        } else if (originalFn.length === 1) {
            newFn = (call: ServerUnaryCall<any, any>, callback) => {
                Promise.resolve(originalFn(call.request))
                    .then(result => callback!(null, result))
                    .catch(err => callback!(err, void 0));
            };
        }

        implementations[fnName] = newFn ?? originalFn;
    }

    // @ts-ignore
    server.addService(_service, implementations);
    return server;
}
