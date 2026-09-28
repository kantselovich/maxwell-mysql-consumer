FROM node:24.13.0-bookworm-slim@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f
WORKDIR /workspace/dashboard
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY dashboard/tsconfig.json ./
COPY dashboard/reporting ./reporting
COPY dashboard/test ./test
COPY scripts /workspace/scripts
RUN npm run typecheck && npm test
CMD ["node", "reporting/cli.ts", "/artifacts", "/output/report.json"]
