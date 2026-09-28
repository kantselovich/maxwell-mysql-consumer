FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f
WORKDIR /workspace/dashboard
ENV OBSERVABLE_TELEMETRY_DISABLE=true
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY dashboard/tsconfig.json ./
COPY dashboard/reporting ./reporting
COPY dashboard/test ./test
COPY dashboard/viewer ./viewer
COPY dashboard/src ./src
COPY dashboard/observablehq.config.js dashboard/playwright.config.ts ./
COPY scripts /workspace/scripts
COPY Sources/E2EHarness /workspace/Sources/E2EHarness
RUN npm run typecheck && npm test
RUN npm run build:viewer
CMD ["node", "reporting/cli.ts", "/artifacts", "/output/report.json"]
