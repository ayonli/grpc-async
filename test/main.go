package main

import (
	"context"
	"io"
	"log"
	"net"
	"strings"

	"github.com/ayonli/grpc-async/examples"
	"google.golang.org/grpc"
)

type Greeter struct {
	examples.UnimplementedGreeterServer
}

func (g *Greeter) SayHello(ctx context.Context, req *examples.Request) (*examples.Response, error) {
	return &examples.Response{Message: "Hello, " + req.Name}, nil
}

func (g *Greeter) SayHelloStreamReply(req *examples.Request, stream examples.Greeter_SayHelloStreamReplyServer) error {
	log.Println(req.Name)
	stream.Send(&examples.Response{Message: "Hello 1: " + req.Name})
	stream.Send(&examples.Response{Message: "Hello 2: " + req.Name})
	stream.Send(&examples.Response{Message: "Hello 3: " + req.Name})
	return nil
}

func (g *Greeter) SayHelloStreamRequest(stream examples.Greeter_SayHelloStreamRequestServer) error {
	var names []string
	for {
		req, err := stream.Recv()

		if err == io.EOF {
			return stream.SendAndClose(&examples.Response{
				Message: "Hello, " + strings.Join(names[:], ", "),
			})
		}

		names = append(names, req.Name)
	}
}

func (g *Greeter) SayHelloDuplex(stream examples.Greeter_SayHelloDuplexServer) error {
	for {
		req, err := stream.Recv()

		if err == io.EOF {
			return nil
		}

		stream.Send(&examples.Response{
			Message: "Hello, " + req.Name,
		})
	}
}

func main() {
	addr := "localhost:50051"
	tcpSrv, err := net.Listen("tcp", addr)

	if err != nil {
		log.Fatalf("Failed to listen on port %s", addr)
	}

	grpcSrv := grpc.NewServer()

	examples.RegisterGreeterServer(grpcSrv, &Greeter{})

	log.Printf("server listening at %v", tcpSrv.Addr())

	if err := grpcSrv.Serve(tcpSrv); err != nil {
		log.Fatalln("Failed to start the gRPC server")
	}
}
