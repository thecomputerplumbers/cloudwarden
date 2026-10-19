# The cloudwarden Secrets Manager reader: a static Go binary on distroless.
# Build from this directory: docker build -t cloudwarden-secrets-reader .
FROM golang:1.27.2 AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/secrets-reader .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/secrets-reader /secrets-reader
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/secrets-reader"]
