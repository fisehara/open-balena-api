#!/bin/bash
set -e

test_versions=''
test_files=''
teardown=0
stop=0
extra_env=''
extra_args=''

while [[ $# -gt 0 ]]; do
	key=$1
	shift
	case $key in
		--without-external)
			extra_env="${extra_env} --env DB_ANALYTICS_PASSWORD= "
		;;
		--teardown)
			teardown=1
		;;
		--rebuild)
			docker-compose build
		;;
		--cleannode)
			cleannode=1
		;;
		--long-stack)
			extra_env="${extra_env} --env BLUEBIRD_LONG_STACK_TRACES=1"
		;;
		--debug)
			extra_env="${extra_env} --env PINEJS_DEBUG=1"
		;;
		--profile)
			extra_args="${extra_args} --inspect-brk=0.0.0.0"
		;;
		--generate-config)
			echo "Generating config as $1"
			echo
			extra_env="${extra_env} --env GENERATE_CONFIG=$1"
			shift
		;;
		--generate-config-version)
			echo "Generating config for model version $1"
			echo
			extra_env="${extra_env} --env GENERATE_CONFIG_VERSION=$1"
			shift
		;;
		-v | --version)
			test_versions="$test_versions $1"
			shift
		;;
		*)
			test_files="$test_files $key"
		;;
	esac
done

if [[ $teardown -eq 1 ]]; then
	echo "Tearing down test environment..."
	docker-compose down
	exit 0
fi

echo "Start up fasttest api and dependings"
# starts automatically redis
docker-compose up -d api-fasttest

echo "Clearing Redis"
docker-compose exec redis /bin/sh -c "redis-cli flushall"

echo "Clearing database"
while ! docker-compose exec db /bin/sh -c "psql --username=docker --dbname=postgres --command='DROP SCHEMA \"public\" CASCADE; CREATE SCHEMA \"public\";' "; do
  echo "waiting for postgress listening..."
  sleep 0.1
done


if [[ $cleannode -eq 1 ]]; then
	echo "Rebuilding node environment ..."
	docker-compose exec api-fasttest /bin/sh -c 'npm ci && npm rebuild'
fi

echo "Execute tests"
if [[ -z "$test_files" ]]; then
	echo "Running all tests"
else
	echo "Running tests: $test_files"
fi
if [[ -z "$test_versions" ]]; then
	echo "Running all versions"
else
	echo "Running versions: $test_versions"
fi

docker-compose exec ${extra_env} --env TEST_VERSIONS="$test_versions" --env TEST_FILES="$test_files" api-fasttest npx mocha --bail ${extra_args}
