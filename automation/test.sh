#!/bin/sh
docker-compose pull api-test
docker-compose build --no-cache api-test
docker-compose up -d api-test
docker-compose exec api-test npx mocha
docker-compose down