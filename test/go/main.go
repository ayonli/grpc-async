package main

import (
	"context"
	"io"
	"log"
	"net"
	"strings"

	helloworld "github.com/hyurl/grpc-async/test"
	"google.golang.org/grpc"
)

type Greeter struct {
	helloworld.UnimplementedGreeterServer
}

func (g *Greeter) SayHello(ctx context.Context, req *helloworld.HelloRequest) (*helloworld.HelloReply, error) {
	return &helloworld.HelloReply{Message: "Hello, " + req.Name}, nil
}

func (g *Greeter) SayHelloStreamReply(req *helloworld.HelloRequest, stream helloworld.Greeter_SayHelloStreamReplyServer) error {
	log.Println(req.Name)
	stream.Send(&helloworld.HelloReply{Message: "Hello 1: " + req.Name})
	stream.Send(&helloworld.HelloReply{Message: "Hello 2: " + req.Name})
	stream.Send(&helloworld.HelloReply{Message: "Hello 3: " + req.Name})
	return nil
}

func (g *Greeter) SayHelloStreamRequest(stream helloworld.Greeter_SayHelloStreamRequestServer) error {
	var names []string
	for {
		req, err := stream.Recv()

		if err == io.EOF {
			return stream.SendAndClose(&helloworld.HelloReply{
				Message: "Hello, " + strings.Join(names[:], ", "),
			})
		}

		names = append(names, req.Name)
	}
}

func (g *Greeter) SayHelloDuplex(stream helloworld.Greeter_SayHelloDuplexServer) error {
	for {
		req, err := stream.Recv()

		if err == io.EOF {
			return nil
		}

		stream.Send(&helloworld.HelloReply{
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

	helloworld.RegisterGreeterServer(grpcSrv, &Greeter{})

	log.Printf("server listening at %v", tcpSrv.Addr())

	if err := grpcSrv.Serve(tcpSrv); err != nil {
		log.Fatalln("Failed to start the gRPC server")
	}
}
