# Multi-stage build of apps/settlement. Build context: repo root.
FROM golang:1.22-alpine AS build
WORKDIR /src/apps/settlement
COPY apps/settlement/go.mod apps/settlement/go.sum ./
RUN go mod download
COPY apps/settlement/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/settlement ./cmd/settlement

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/settlement /app/settlement
EXPOSE 8091
ENTRYPOINT []
CMD ["./settlement", "daemon"]
