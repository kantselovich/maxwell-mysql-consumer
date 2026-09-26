.PHONY: up down reset phase1 phase2 test logs
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
test:
	docker build --target build -t maxwell-poc-swift:tests .
logs:
	docker compose logs --tail=100
