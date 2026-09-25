FROM swift:6.2.1-jammy AS build
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY Package.swift Package.resolved ./
RUN swift package resolve
COPY Sources Sources
COPY Tests Tests
RUN swift build -c debug --jobs 4 && swift test --jobs 4

# The toolchain image supplies Swift runtime libraries; build artifacts stay out.
FROM swift:6.2.1-jammy AS runtime
COPY --from=build /workspace/.build/debug/cdc-poc /usr/local/bin/cdc-poc
ENTRYPOINT ["/usr/local/bin/cdc-poc"]
CMD ["observe"]
