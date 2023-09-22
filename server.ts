import type {
    MethodDefinition,
    Server,
    ServerUnaryCall,
    ServerWritableStream as gServerWritableStream,
    ServerReadableStream as gServerReadableStream,
    ServerDuplexStream as gServerDuplexStream,
    ServiceClientConstructor,
    ServiceDefinition,
    Metadata
} from "@grpc/grpc-js";

const AsyncGeneratorFunction = (async function* () { }).constructor;
const GeneratorFunction = (function* () { }).constructor;

export type ServerWritableStream<Req, Res> = gServerWritableStream<Req, Res>;

export type ServerReadableStream<Req, Res = void> = gServerReadableStream<Req, Res> & AsyncIterable<Req>;

export type ServerDuplexStream<Req, Res> = gServerDuplexStream<Req, Res> & AsyncIterable<Req>;

export function serve<T extends object>(
    server: Server,
    service: ServiceClientConstructor | ServiceDefinition<T>,
    instance: T
) {
    const implementations: { [name: string]: (data?: any) => any; } = {};
    let _service: ServiceDefinition<any>;

    if (service instanceof Function && service.service && service.serviceName) {
        _service = service.service;
    } else {
        _service = service as ServiceDefinition<T>;
    }

    for (const name of Object.getOwnPropertyNames(_service)) {
        const ins = instance as any;
        const def = _service[name] as MethodDefinition<any, any>;
        let originalFn: (data?: any, metadata?: Metadata) => any = null as any;
        let newFn: (call: any, callback?: (err: unknown, result: any) => void) => void = null as any;

        if (def.originalName && ins[def.originalName]) {
            originalFn = (ins[def.originalName] as Function)?.bind(instance) as any;
        } else {
            originalFn = (ins[name] as Function)?.bind(instance) as any;
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
                    for await (const value of originalFn(stream.request, stream.metadata)) {
                        stream.write(value);
                    }

                    stream.end();
                };
            }
        } else if (def.requestStream) {
            newFn = (stream: gServerReadableStream<any, any>, callback) => {
                Promise.resolve(originalFn(stream))
                    .then(result => callback!(null, result))
                    .catch(err => callback!(err, void 0));
            };
        } else {
            newFn = (call: ServerUnaryCall<any, any>, callback) => {
                Promise.resolve(originalFn(call.request, call.metadata))
                    .then(result => callback!(null, result))
                    .catch(err => callback!(err, void 0));
            };
        }

        if (newFn) {
            Object.defineProperty(newFn, "name", {
                configurable: true,
                writable: false,
                enumerable: false,
                value: name,
            });

            if (def.originalName && ins[def.originalName]) {
                implementations[def.originalName] = newFn;
            } else {
                implementations[name] = newFn;
            }
        }
    }

    server.addService(_service, implementations);
}

export function unserve<T extends object>(
    server: Server,
    service: ServiceClientConstructor | ServiceDefinition<T>
) {
    let _service: ServiceDefinition<any>;

    if (service instanceof Function && service.service && service.serviceName) {
        _service = service.service;
    } else {
        _service = service as ServiceDefinition<T>;
    }

    server.removeService(_service);
}
