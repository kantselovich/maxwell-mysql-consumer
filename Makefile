.DEFAULT_GOAL := up
.PHONY: up down reset phase1 phase2 phase4 phase5 e2e e2e-load e2e-checks mysql57-checks test logs dashboard-data dashboard-data-test
.PHONY: test-basic-replication test-recovery test-invalid-json test-unsupported-schema test-load
# Page-named entry points; existing phase commands remain available.
test-basic-replication:
	WRITE_INTERVAL_MS=$${WRITE_INTERVAL_MS:-250} bash scripts/e2e-checks.sh
test-recovery: phase4
test-invalid-json:
	bash scripts/phase5.sh malformed
test-unsupported-schema:
	bash scripts/phase5.sh unsupported
test-load: e2e-load
up:
	docker compose up --build -d --wait --wait-timeout 240
down:
	docker compose down
reset:
	docker compose down --volumes --remove-orphans
phase1:
	bash scripts/phase1.sh
phase2:
	bash scripts/phase2.sh
phase4:
	bash scripts/phase4.sh
phase5:
	bash scripts/phase5-suite.sh
e2e-load:
	ROWS=$${ROWS:-1000} WRITE_INTERVAL_MS=$${WRITE_INTERVAL_MS:-1} CONVERGENCE_TIMEOUT=$${CONVERGENCE_TIMEOUT:-600} E2E_MAX_SECONDS=$${E2E_MAX_SECONDS:-1800} bash scripts/phase5.sh workload
e2e:
	bash scripts/e2e.sh
e2e-checks:
	bash scripts/e2e-checks.sh
mysql57-checks:
	bash scripts/mysql57-checks.sh
test:
	docker build --target build -t maxwell-poc-swift:tests .
logs:
	docker compose logs --tail=100
dashboard-data:
	mkdir -p dashboard/.generated
	docker compose -f compose.dashboard.yaml run --build --rm --no-deps reporting
dashboard-data-test:
	docker compose -f compose.dashboard.yaml run --build --rm --no-deps reporting npm test

.PHONY: dashboard dashboard-view dashboard-build dashboard-stop dashboard-test dashboard-test-live dashboard-test-update-snapshots
dashboard: dashboard-data
	docker compose -f compose.dashboard.yaml up --build -d viewer watcher
dashboard-view: dashboard-data
	docker compose -f compose.dashboard.yaml up --build -d viewer
dashboard-build: dashboard-data
	docker compose -f compose.dashboard.yaml run --rm --no-deps -e RUN_IDS="$${RUN_IDS:-}" reporting node reporting/export.ts /artifacts /output/report.json /output/snapshots
dashboard-stop:
	docker compose -f compose.dashboard.yaml stop viewer watcher
dashboard-test:
	mkdir -p dashboard/test-results dashboard/playwright-report
	docker compose -f compose.dashboard.yaml run --build --rm --no-deps browser-tests
dashboard-test-update-snapshots:
	mkdir -p dashboard/test-results dashboard/playwright-report
	docker compose -f compose.dashboard.yaml run --build --rm --no-deps browser-tests npm run test:browser:update
dashboard-test-live:
	bash scripts/dashboard-test-live.sh
